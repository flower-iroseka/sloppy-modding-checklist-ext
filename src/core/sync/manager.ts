import type { Msg, MsgParam } from '../../i18n';
import { normalizeDoc } from '../doc';
import { serializeDoc } from '../exchange';
import type { ChecklistDoc } from '../types';
import { SyncError, describeError } from './errors';
import { canonicalJson, planPull, planPush, type SyncSide } from './plan';
import type { PendingConflict, ProviderConfig, RemoteDoc, SyncProvider, SyncStrategy } from './types';

/**
 * The doing part of sync: take the direction plan.ts worked out, then read and write both
 * sides.
 *
 * Every side effect comes in through `SyncDeps`, so a unit test can plug in a fake provider
 * and run upload, pull, conflict and backup end to end without a server.
 */

/**
 * A provider with the config already bound.
 */
export interface BoundProvider {
  /** Read the remote doc. Returns null when there's no remote file yet. */
  read(): Promise<RemoteDoc | null>;
  /** Write the doc to the remote, overwriting what's there. */
  write(json: string): Promise<void>;
}

/**
 * Bind the config into the provider, so every call site doesn't have to pass it along.
 *
 * @param provider one provider's implementation
 * @param config that provider's config
 * @returns a narrow interface exposing only read / write
 */
export function bindProvider(provider: SyncProvider, config: ProviderConfig): BoundProvider {
  return {
    read: () => provider.read(config),
    write: (json) => provider.write(config, json),
  };
}

/**
 * All the external dependencies one sync needs.
 */
export interface SyncDeps {
  /** Read and write the remote. */
  provider: BoundProvider;
  /** Conflict strategy. */
  strategy: SyncStrategy;
  /** Get the current time. Tests can feed in a fixed value. */
  now(): number;
  /** Read the local doc. */
  readLocalDoc(): Promise<ChecklistDoc>;
  /** Write the local doc. */
  writeLocalDoc(doc: ChecklistDoc): Promise<void>;
  /**
   * Save JSON as a backup and return the backup file name (it shows up in the user-facing
   * message). Has to be called once before overwriting either side.
   *
   * @param side which side is being backed up
   * @param json what to back up
   */
  backup(side: BackupSide, json: string): Promise<string>;
}

/** Which side is being backed up. */
export type BackupSide = 'local' | 'remote';

/**
 * The result of one sync.
 */
export interface SyncOutcome {
  /** Whether the flow completed. "Nothing to sync" also counts as completed. */
  ok: boolean;
  /** What actually happened. */
  action: 'push' | 'pull' | 'none';
  /** Template for the sentence shown to the user; the display side decides the language. */
  message: Msg;
  /** Carries the conflict scene when the user has to make the call. */
  conflict?: PendingConflict;
}

/**
 * The local side's comparison basis: the timestamp plus the canonicalized body.
 *
 * @param doc the local doc
 * @returns the side to hand to `planPush` / `planPull`
 */
function localSide(doc: ChecklistDoc): SyncSide {
  return { updatedAt: doc.updatedAt, json: canonicalJson(doc) };
}

/**
 * Parse the remote text into a doc and its comparison basis.
 *
 * @param remote the raw content read from the remote
 * @returns the parsed doc, plus the version used for comparison
 * @throws {SyncError} the remote content isn't valid checklist JSON
 */
function remoteSide(remote: RemoteDoc): { doc: ChecklistDoc; side: SyncSide } {
  let doc: ChecklistDoc;
  try {
    // Passing 0 as `now` instead of letting normalizeDoc call Date.now(): when a file has
    // no valid updatedAt, the default would treat it as "now", making every remote file
    // without a timestamp look newer than the local one. Passing 0 always rules it out;
    // if we really want to trust it, we fall back to HTTP's Last-Modified.
    doc = normalizeDoc(JSON.parse(remote.json), 0);
  } catch (e) {
    throw new SyncError(
      { key: 'err.manager.badRemoteJson', params: { detail: describeError(e) } },
      { cause: e },
    );
  }
  const updatedAt = doc.updatedAt > 0 ? doc.updatedAt : (remote.modifiedAt ?? 0);
  return { doc, side: { updatedAt, json: canonicalJson(doc) } };
}

/**
 * Read the remote, turning any provider failure into a `SyncError`.
 *
 * @param deps the dependencies sync needs
 * @returns the remote doc; null when there's no remote file yet
 * @throws {SyncError} the provider's read failed
 */
async function readRemote(deps: SyncDeps): Promise<RemoteDoc | null> {
  try {
    return await deps.provider.read();
  } catch (e) {
    throw new SyncError(
      { key: 'err.manager.readFailed', params: { detail: describeError(e) } },
      { cause: e },
    );
  }
}

/**
 * Write the remote, turning any provider failure into a `SyncError`.
 *
 * @param deps the dependencies sync needs
 * @param json the serialized doc to write up
 * @throws {SyncError} the provider's write failed
 */
async function writeRemote(deps: SyncDeps, json: string): Promise<void> {
  try {
    await deps.provider.write(json);
  } catch (e) {
    throw new SyncError(
      { key: 'err.manager.pushFailed', params: { detail: describeError(e) } },
      { cause: e },
    );
  }
}

/**
 * Push: send the local copy up to the remote.
 *
 * @param deps the dependencies sync needs
 * @param opts.force when there's a conflict, true means the user confirmed overwriting the
 *        remote
 * @returns this sync's result; when the user has to decide, `conflict` carries the remote scene
 * @throws {SyncError} reading the remote, backing it up, or writing it failed
 */
export async function runPush(deps: SyncDeps, opts: { force?: boolean } = {}): Promise<SyncOutcome> {
  const local = await deps.readLocalDoc();
  const remote = await readRemote(deps);

  let parsed: { doc: ChecklistDoc; side: SyncSide } | null = null;
  if (remote) {
    try {
      parsed = remoteSide(remote);
    } catch {
      // A corrupt remote file is not "can't upload" -- it's exactly the case the user
      // should be allowed to overwrite, so treat it as "nothing to compare against" and let it through.
      parsed = null;
    }
  }

  const plan = planPush(localSide(local), parsed?.side ?? null, deps.strategy);
  if (plan.direction === 'none') return { ok: true, action: 'none', message: plan.reason };

  if (plan.direction === 'ask' && !opts.force) {
    return {
      ok: true,
      action: 'none',
      message: plan.reason,
      conflict: {
        kind: 'push',
        remoteJson: remote?.json ?? '',
        remoteUpdatedAt: parsed?.side.updatedAt ?? 0,
        localUpdatedAt: local.updatedAt,
      },
    };
  }

  // Leave a copy of the remote before overwriting. The local copy is already in storage,
  // so it doesn't need a backup.
  const backedUp = parsed ? await deps.backup('remote', remote!.json) : null;

  await writeRemote(deps, serializeDoc(local));

  // Even without a backup we have to pass an empty string; `{suffix}` can't be left out:
  // a missing param makes renderMsg print the placeholder as-is, and that warning exists
  // for template/call-site mismatches, not for normal paths.
  const suffix: MsgParam = backedUp
    ? { key: 'sync.pushedBackup', params: { backup: backedUp } }
    : '';
  return {
    ok: true,
    action: 'push',
    message: { key: 'sync.pushed', params: { count: countEntries(local), suffix } },
  };
}

/**
 * Pull: take the remote copy down and overwrite the local one.
 *
 * @param deps the dependencies sync needs
 * @param opts.force when there's a conflict, true means the user confirmed overwriting local
 * @param opts.remoteJsonOverride use this remote text directly instead of reading the remote again
 * @returns this sync's result; when the user has to decide, `conflict` carries the remote scene
 * @throws {SyncError} reading the remote, backing up, or writing the local doc failed
 */
export async function runPull(
  deps: SyncDeps,
  opts: { force?: boolean; remoteJsonOverride?: string } = {},
): Promise<SyncOutcome> {
  const local = await deps.readLocalDoc();

  const remote: RemoteDoc | null =
    opts.remoteJsonOverride !== undefined
      ? { json: opts.remoteJsonOverride }
      : await readRemote(deps);

  if (!remote) {
    return { ok: true, action: 'none', message: { key: 'plan.pull.noRemote' } };
  }

  const { doc: remoteDoc, side } = remoteSide(remote);
  const plan = planPull(localSide(local), side, deps.strategy);

  if (plan.direction === 'none') return { ok: true, action: 'none', message: plan.reason };

  if (plan.direction === 'ask' && !opts.force) {
    return {
      ok: true,
      action: 'none',
      message: plan.reason,
      conflict: {
        kind: 'pull',
        remoteJson: remote.json,
        remoteUpdatedAt: side.updatedAt,
        localUpdatedAt: local.updatedAt,
      },
    };
  }

  const backedUp = await deps.backup('local', serializeDoc(local));
  await deps.writeLocalDoc(adopt(remoteDoc, local.updatedAt));

  return {
    ok: true,
    action: 'pull',
    message: {
      key: 'sync.pulled',
      params: {
        count: countEntries(remoteDoc),
        suffix: { key: 'sync.pulledBackup', params: { backup: backedUp } },
      },
    },
  };
}

/**
 * Adopt the remote doc.
 *
 * When the remote timestamp isn't newer than the local one (a tie, or a forced pull by the
 * user), bump the timestamp above the local one -- `applyExternalDoc` only accepts it when
 * incoming.updatedAt is larger, otherwise an open page never sees this change and later
 * writes the old content back, making the pull pointless.
 *
 * @param remoteDoc the remote doc
 * @param localUpdatedAt the local current timestamp
 * @returns a doc you can write into the local side
 */
export function adopt(remoteDoc: ChecklistDoc, localUpdatedAt: number): ChecklistDoc {
  if (remoteDoc.updatedAt > localUpdatedAt) return remoteDoc;
  // Uses "local + 1" rather than now(): with clock skew between devices, this ordering
  // still holds reliably.
  return { ...remoteDoc, updatedAt: localUpdatedAt + 1 };
}

/**
 * Total entry count. It only returns a number; the "{count} in total" wording is copy, and
 * lives in the catalog.
 *
 * @param doc the doc to count
 * @returns how many entries it holds
 */
function countEntries(doc: ChecklistDoc): number {
  let n = 0;
  for (const list of Object.values(doc.cells)) n += list.length;
  return n;
}

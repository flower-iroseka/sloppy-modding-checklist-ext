import type { Msg } from '../../i18n';
import type { SyncStrategy } from './types';

/**
 * Deciding "what should this run do". Pure functions, no network, no storage -- every
 * pitfall in the conflict logic (equal timestamps, identical content, mutually exclusive
 * strategies) can be exhaustively covered in unit tests.
 */

/** This run's conclusion: which way to go, or nothing to do, or ask the user. */
export type SyncDirection = 'push' | 'pull' | 'none' | 'ask';

/** The decision. */
export interface SyncPlan {
  /** What to do. */
  direction: SyncDirection;
  /**
   * Template for a sentence shown to the user. The UI translates it with `renderMsg` and
   * then displays it -- this doesn't produce a pre-translated Chinese string, otherwise the
   * decision logic would be frozen the moment the language switches (see i18n/types.ts).
   */
  reason: Msg;
}

/** One side taking part in the comparison. */
export interface SyncSide {
  /** This side's timestamp (ms). */
  updatedAt: number;
  /**
   * The canonicalized body (see canonicalJson); this is what "same content" is judged on.
   */
  json: string;
}

/**
 * Stable serialization: sort keys recursively, then stringify.
 *
 * Comparing content with plain `JSON.stringify(doc)` gives false mismatches -- the remote
 * copy has the key order from the last upload, while the local one is computed fresh by
 * `normalizeDoc`, so identical fields can end up in different positions. And "is the
 * content the same" is the only basis for deciding "nothing to sync", so getting it wrong
 * means a pointless upload or download on every run.
 *
 * @param value any value
 * @returns the sorted JSON text
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * Recursively sort an object's keys; arrays keep their original order.
 *
 * @param value the value to walk
 * @returns a copy with every object's keys sorted
 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key]);
    return out;
  }
  return value;
}

/**
 * Are the two sides' contents exactly the same?
 *
 * @param a one side
 * @param b the other side
 * @returns true when their canonicalized bodies match
 */
function sameContent(a: SyncSide, b: SyncSide): boolean {
  return a.json === b.json;
}

/**
 * What a pull should do.
 *
 * When the timestamps are equal but the content differs (two devices' clocks landing on the
 * same millisecond, or one side's updatedAt edited by hand), the three "automatic"
 * strategies have to give a deterministic answer, or auto-sync would be stuck on this one
 * case forever. The rules: `newest-wins` takes the remote on a tie, `local-wins` does
 * nothing, `remote-wins` takes the remote, `ask` hands it back to the UI. The local side is
 * always backed up before taking the remote (see manager).
 *
 * @param local the local side
 * @param remote the remote side; pass null when there's no remote file yet
 * @param strategy conflict strategy
 * @returns what to do, and the sentence to show the user
 */
export function planPull(local: SyncSide, remote: SyncSide | null, strategy: SyncStrategy): SyncPlan {
  if (!remote) {
    return { direction: 'none', reason: { key: 'plan.pull.noRemote' } };
  }
  if (sameContent(local, remote)) {
    return { direction: 'none', reason: { key: 'plan.pull.same' } };
  }
  if (remote.updatedAt > local.updatedAt) {
    return { direction: 'pull', reason: { key: 'plan.pull.remoteNewer' } };
  }
  if (remote.updatedAt < local.updatedAt) {
    return { direction: 'none', reason: { key: 'plan.pull.localNewer' } };
  }
  // Equal timestamps, different content
  switch (strategy) {
    case 'local-wins':
      return { direction: 'none', reason: { key: 'plan.pull.localWins' } };
    case 'remote-wins':
      return { direction: 'pull', reason: { key: 'plan.pull.remoteWins' } };
    case 'ask':
      return { direction: 'ask', reason: { key: 'plan.pull.ask' } };
    case 'newest-wins':
    default:
      return { direction: 'pull', reason: { key: 'plan.pull.tieRemote' } };
  }
}

/**
 * What a push should do.
 *
 * When the user clicks "Upload now" they mean "make the remote look like my copy", so it just
 * does that by default -- the only exception is when the remote is definitely newer (later
 * timestamp) and the strategy isn't "Local wins": that would really overwrite someone else's
 * changes, so ask first. This question doesn't block auto-sync, because automatic upload
 * goes through the `autoSync` path, and there `newest-wins` also returns `ask` in that
 * case; manager puts the conflict into status without blocking other actions.
 *
 * @param local the local side
 * @param remote the remote side; pass null when there's no remote file yet
 * @param strategy conflict strategy
 * @returns what to do, and the sentence to show the user
 */
export function planPush(local: SyncSide, remote: SyncSide | null, strategy: SyncStrategy): SyncPlan {
  if (!remote) return { direction: 'push', reason: { key: 'plan.push.noRemote' } };
  if (sameContent(local, remote)) {
    return { direction: 'none', reason: { key: 'plan.push.same' } };
  }
  if (remote.updatedAt > local.updatedAt) {
    if (strategy === 'local-wins') {
      return { direction: 'push', reason: { key: 'plan.push.localWins' } };
    }
    return { direction: 'ask', reason: { key: 'plan.push.ask' } };
  }
  return { direction: 'push', reason: { key: 'plan.push.ok' } };
}

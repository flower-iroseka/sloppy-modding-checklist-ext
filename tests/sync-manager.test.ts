import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDoc } from '../src/core/doc';
import { serializeDoc } from '../src/core/exchange';
import {
  adopt,
  runPull,
  runPush,
  type BackupSide,
  type BoundProvider,
  type SyncDeps,
} from '../src/core/sync/manager';
import type { ChecklistDoc } from '../src/core/types';
import { renderMsg } from '../src/i18n';

/**
 * The sync manager: runPush, runPull and adopt, against a fake remote.
 *
 * Most cases are about what must not happen -- no write on a conflict, no upload when the
 * two sides match, no pull when the remote is older -- so the fake remote records every
 * read and write and the assertions look at that log.
 */

/**
 * Fake remote: a mutable JSON string plus a call log.
 *
 * @param initial the remote's starting content; null means the remote has no file yet
 * @returns `state` holds the current content and call log, `provider` is the port that only knows read / write
 */
function fakeProvider(initial: string | null) {
  const state = { json: initial, reads: 0, writes: [] as string[] };
  const provider: BoundProvider = {
    async read() {
      state.reads += 1;
      return state.json === null ? null : { json: state.json };
    },
    async write(json) {
      state.writes.push(json);
      state.json = json;
    },
  };
  return { state, provider };
}

/**
 * Build a doc with one general-internal entry.
 *
 * @param updatedAt timestamp for the doc and that entry
 * @param summary the entry's summary, also folded into its id
 * @param deviceId device name, defaulting to d-local
 * @returns the built doc
 */
function doc(updatedAt: number, summary: string, deviceId = 'd-local'): ChecklistDoc {
  const d = createEmptyDoc(deviceId, updatedAt);
  d.updatedAt = updatedAt;
  d.cells['general-internal'].push({
    id: `e-${summary}`,
    scope: 'general',
    source: 'internal',
    summary,
    links: [],
    createdAt: updatedAt,
    updatedAt,
  });
  return d;
}

/**
 * Assemble a SyncDeps, keeping the local doc and backup records in state.
 *
 * @param provider the fake remote
 * @param local this device's local doc
 * @param strategy conflict strategy, defaulting to newest-wins
 * @returns the deps object, plus a readable local doc and backup records
 */
function makeDeps(provider: BoundProvider, local: ChecklistDoc, strategy: SyncDeps['strategy'] = 'newest-wins') {
  const state = { local, backups: [] as { side: BackupSide; json: string }[] };
  const deps: SyncDeps = {
    provider,
    strategy,
    now: () => 1_000_000,
    readLocalDoc: async () => state.local,
    writeLocalDoc: async (d) => {
      state.local = d;
    },
    backup: async (side, json) => {
      state.backups.push({ side, json });
      return `backup-${state.backups.length}`;
    },
  };
  return { deps, state };
}

describe('runPush', () => {
  let remote: ReturnType<typeof fakeProvider>;

  beforeEach(() => {
    remote = fakeProvider(null);
  });

  it('no remote file -> create one, no backup needed', async () => {
    const { deps, state } = makeDeps(remote.provider, doc(100, 'a'));
    const out = await runPush(deps);

    expect(out.ok).toBe(true);
    expect(out.action).toBe('push');
    expect(state.backups).toEqual([]);
    expect(JSON.parse(remote.state.writes[0]).cells['general-internal'][0].summary).toBe('a');
  });

  it('overwriting an older remote -> back up the remote first', async () => {
    remote = fakeProvider(serializeDoc(doc(50, '旧远端', 'd-remote')));
    const { deps, state } = makeDeps(remote.provider, doc(100, '新本地'));
    const out = await runPush(deps);

    expect(out.action).toBe('push');
    // `side` is a `BackupSide` (`'local'` / `'remote'`), an enum value, not a display string -- see manager.ts.
    // It's only used to build a storage key prefix; translating it is the display side's job
    // (the line below is the actual copy).
    expect(state.backups.map((b) => b.side)).toEqual(['remote']);
    expect(renderMsg(out.message, 'zh')).toContain('备份');
  });

  it('remote newer + default strategy -> raise a conflict and write not a single byte', async () => {
    const remoteJson = serializeDoc(doc(500, '远端新', 'd-remote'));
    remote = fakeProvider(remoteJson);
    const { deps, state } = makeDeps(remote.provider, doc(100, '本地旧'));
    const out = await runPush(deps);

    expect(out.action).toBe('none');
    expect(out.conflict).toEqual({
      kind: 'push',
      remoteJson,
      remoteUpdatedAt: 500,
      localUpdatedAt: 100,
    });
    expect(remote.state.writes).toEqual([]);
    expect(state.backups).toEqual([]);
  });

  it('force on the same conflict -> actually overwrites', async () => {
    remote = fakeProvider(serializeDoc(doc(500, '远端新', 'd-remote')));
    const { deps } = makeDeps(remote.provider, doc(100, '本地旧'));
    const out = await runPush(deps, { force: true });

    expect(out.action).toBe('push');
    expect(JSON.parse(remote.state.json!).cells['general-internal'][0].summary).toBe('本地旧');
  });

  it('with the local-wins strategy a newer remote is pushed anyway, without asking', async () => {
    remote = fakeProvider(serializeDoc(doc(500, '远端新', 'd-remote')));
    const { deps } = makeDeps(remote.provider, doc(100, '本地旧'), 'local-wins');
    const out = await runPush(deps);

    expect(out.action).toBe('push');
    expect(out.conflict).toBeUndefined();
  });

  it('same content -> none, no write request', async () => {
    const local = doc(100, '一样');
    remote = fakeProvider(serializeDoc(local));
    const { deps } = makeDeps(remote.provider, local);
    const out = await runPush(deps);

    expect(out.action).toBe('none');
    expect(remote.state.writes).toEqual([]);
  });

  // The remote copy has the key order from the last upload, while the local one was just
  // computed by normalizeDoc. Comparing the strings directly would call them "different",
  // so every sync would re-upload for nothing.
  it('different key order but same content -> none', async () => {
    const local = doc(100, '一样');
    const src = local as unknown as Record<string, unknown>;
    const reordered: Record<string, unknown> = {};
    for (const key of Object.keys(src).reverse()) reordered[key] = src[key];
    const remoteJson = JSON.stringify(reordered);
    expect(remoteJson).not.toBe(serializeDoc(local)); // precondition: the two texts really differ

    remote = fakeProvider(remoteJson);
    const { deps } = makeDeps(remote.provider, local);
    const out = await runPush(deps);

    expect(out.action).toBe('none');
    expect(remote.state.writes).toEqual([]);
  });

  it('a corrupt remote file is still pushed over (a corrupt file deserves overwriting anyway)', async () => {
    remote = fakeProvider('{ 这不是 JSON');
    const { deps } = makeDeps(remote.provider, doc(100, '本地'));
    const out = await runPush(deps);

    expect(out.action).toBe('push');
    expect(remote.state.writes).toHaveLength(1);
  });

  it('remote is valid JSON but not a checklist doc -> treated as overwritable too', async () => {
    remote = fakeProvider('{"hello":"world"}');
    const { deps } = makeDeps(remote.provider, doc(100, '本地'));
    expect((await runPush(deps)).action).toBe('push');
  });
});

describe('runPull', () => {
  it('remote newer -> overwrite local and back up local', async () => {
    const remote = fakeProvider(serializeDoc(doc(500, '远端新', 'd-remote')));
    const { deps, state } = makeDeps(remote.provider, doc(100, '本地旧'));
    const out = await runPull(deps);

    expect(out.action).toBe('pull');
    expect(state.backups.map((b) => b.side)).toEqual(['local']);
    expect(state.local.cells['general-internal'][0].summary).toBe('远端新');
    expect(state.local.deviceId).toBe('d-remote');
  });

  it('no remote file -> none, no local write and no backup', async () => {
    const remote = fakeProvider(null);
    const { deps, state } = makeDeps(remote.provider, doc(100, '本地'));
    const out = await runPull(deps);

    expect(out.action).toBe('none');
    expect(state.backups).toEqual([]);
    expect(state.local.cells['general-internal'][0].summary).toBe('本地');
  });

  it('local newer -> none (a pull never rolls local back)', async () => {
    const remote = fakeProvider(serializeDoc(doc(50, '远端旧', 'd-remote')));
    const { deps, state } = makeDeps(remote.provider, doc(100, '本地新'));
    const out = await runPull(deps);

    expect(out.action).toBe('none');
    expect(state.local.cells['general-internal'][0].summary).toBe('本地新');
  });

  // Once a remote file without updatedAt is taken as "now", it silently overwrites local.
  // remoteSide passes now=0, so it has to be judged "older".
  it('remote file missing updatedAt -> not taken (never treated as "just changed")', async () => {
    const bare = { schemaVersion: 1, deviceId: 'd-remote', cells: {} };
    const remote = fakeProvider(JSON.stringify(bare));
    const { deps, state } = makeDeps(remote.provider, doc(999_999, '本地'));
    const out = await runPull(deps);

    expect(out.action).toBe('none');
    expect(state.local.cells['general-internal'][0].summary).toBe('本地');
  });

  it('timestamp tie + ask -> raise a pull conflict, leave local alone', async () => {
    const remoteJson = serializeDoc(doc(100, '远端', 'd-remote'));
    const remote = fakeProvider(remoteJson);
    const { deps, state } = makeDeps(remote.provider, doc(100, '本地'), 'ask');
    const out = await runPull(deps);

    expect(out.action).toBe('none');
    expect(out.conflict?.kind).toBe('pull');
    expect(out.conflict?.remoteJson).toBe(remoteJson);
    expect(state.local.cells['general-internal'][0].summary).toBe('本地');
  });

  it('timestamp tie + force -> take the remote', async () => {
    const remote = fakeProvider(serializeDoc(doc(100, '远端', 'd-remote')));
    const { deps, state } = makeDeps(remote.provider, doc(100, '本地'), 'ask');
    const out = await runPull(deps, { force: true });

    expect(out.action).toBe('pull');
    expect(state.local.cells['general-internal'][0].summary).toBe('远端');
  });

  it('remoteJsonOverride uses the in-hand copy directly, no second network call', async () => {
    const override = serializeDoc(doc(500, '冲突现场', 'd-remote'));
    const remote = fakeProvider(null);
    const { deps, state } = makeDeps(remote.provider, doc(100, '本地'));
    const out = await runPull(deps, { force: true, remoteJsonOverride: override });

    expect(out.action).toBe('pull');
    expect(remote.state.reads).toBe(0);
    expect(state.local.cells['general-internal'][0].summary).toBe('冲突现场');
  });

  it('remote JSON invalid -> throws, instead of wiping local', async () => {
    const remote = fakeProvider('不是 JSON');
    const { deps, state } = makeDeps(remote.provider, doc(100, '本地'));
    await expect(runPull(deps)).rejects.toThrow(/远端文件不是合法的 checklist JSON/);
    expect(state.local.cells['general-internal'][0].summary).toBe('本地');
  });
});

describe('adopt', () => {
  it('a newer remote keeps its timestamp', () => {
    expect(adopt(doc(500, 'r'), 100).updatedAt).toBe(500);
  });

  // Without bumping the timestamp, an open extension page would ignore this adoption and
  // then write the old content back to storage -- making the whole pull pointless.
  it('when the remote is not newer, raise the timestamp above local', () => {
    const adopted = adopt(doc(100, 'r'), 100);
    expect(adopted.updatedAt).toBe(101);
    expect(adopted.updatedAt).toBeGreaterThan(100);
  });

  it('raising the timestamp does not touch the content', () => {
    const adopted = adopt(doc(100, 'r'), 500);
    expect(adopted.cells).toEqual(doc(100, 'r').cells);
    expect(adopted.deviceId).toBe('d-local');
  });
});

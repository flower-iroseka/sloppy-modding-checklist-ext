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

  it('远端没有文件 → 新建一份，不需要备份', async () => {
    const { deps, state } = makeDeps(remote.provider, doc(100, 'a'));
    const out = await runPush(deps);

    expect(out.ok).toBe(true);
    expect(out.action).toBe('push');
    expect(state.backups).toEqual([]);
    expect(JSON.parse(remote.state.writes[0]).cells['general-internal'][0].summary).toBe('a');
  });

  it('覆盖更旧的远端 → 先备份远端', async () => {
    remote = fakeProvider(serializeDoc(doc(50, '旧远端', 'd-remote')));
    const { deps, state } = makeDeps(remote.provider, doc(100, '新本地'));
    const out = await runPush(deps);

    expect(out.action).toBe('push');
    // `side` is a `BackupSide` (`'local'` / `'remote'`), not the Chinese "远端" -- see manager.ts.
    // It's only used to build a storage key prefix; translating it is the display side's job
    // (the line below is the actual copy).
    expect(state.backups.map((b) => b.side)).toEqual(['remote']);
    expect(renderMsg(out.message, 'zh')).toContain('备份');
  });

  it('远端更新 + 默认策略 → 挂冲突，且一个字节都不写', async () => {
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

  it('同一个冲突上 force → 真的覆盖', async () => {
    remote = fakeProvider(serializeDoc(doc(500, '远端新', 'd-remote')));
    const { deps } = makeDeps(remote.provider, doc(100, '本地旧'));
    const out = await runPush(deps, { force: true });

    expect(out.action).toBe('push');
    expect(JSON.parse(remote.state.json!).cells['general-internal'][0].summary).toBe('本地旧');
  });

  it('策略为「本地优先」时远端更新也直接传，不问', async () => {
    remote = fakeProvider(serializeDoc(doc(500, '远端新', 'd-remote')));
    const { deps } = makeDeps(remote.provider, doc(100, '本地旧'), 'local-wins');
    const out = await runPush(deps);

    expect(out.action).toBe('push');
    expect(out.conflict).toBeUndefined();
  });

  it('内容一致 → none，不发写请求', async () => {
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
  it('键序不同但内容一致 → none', async () => {
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

  it('远端文件坏掉时照传不误（坏文件本来就该被覆盖）', async () => {
    remote = fakeProvider('{ 这不是 JSON');
    const { deps } = makeDeps(remote.provider, doc(100, '本地'));
    const out = await runPush(deps);

    expect(out.action).toBe('push');
    expect(remote.state.writes).toHaveLength(1);
  });

  it('远端是合法 JSON 但不是 checklist 文档 → 同样当作可覆盖', async () => {
    remote = fakeProvider('{"hello":"world"}');
    const { deps } = makeDeps(remote.provider, doc(100, '本地'));
    expect((await runPush(deps)).action).toBe('push');
  });
});

describe('runPull', () => {
  it('远端更新 → 覆盖本地，并备份本地', async () => {
    const remote = fakeProvider(serializeDoc(doc(500, '远端新', 'd-remote')));
    const { deps, state } = makeDeps(remote.provider, doc(100, '本地旧'));
    const out = await runPull(deps);

    expect(out.action).toBe('pull');
    expect(state.backups.map((b) => b.side)).toEqual(['local']);
    expect(state.local.cells['general-internal'][0].summary).toBe('远端新');
    expect(state.local.deviceId).toBe('d-remote');
  });

  it('远端没有文件 → none，不写本地也不备份', async () => {
    const remote = fakeProvider(null);
    const { deps, state } = makeDeps(remote.provider, doc(100, '本地'));
    const out = await runPull(deps);

    expect(out.action).toBe('none');
    expect(state.backups).toEqual([]);
    expect(state.local.cells['general-internal'][0].summary).toBe('本地');
  });

  it('本地更新 → none（拉取不会把本地往回退）', async () => {
    const remote = fakeProvider(serializeDoc(doc(50, '远端旧', 'd-remote')));
    const { deps, state } = makeDeps(remote.provider, doc(100, '本地新'));
    const out = await runPull(deps);

    expect(out.action).toBe('none');
    expect(state.local.cells['general-internal'][0].summary).toBe('本地新');
  });

  // Once a remote file without updatedAt is taken as "now", it silently overwrites local.
  // remoteSide passes now=0, so it has to be judged "older".
  it('远端文件缺 updatedAt → 不采纳（不会被当成「刚改的」）', async () => {
    const bare = { schemaVersion: 1, deviceId: 'd-remote', cells: {} };
    const remote = fakeProvider(JSON.stringify(bare));
    const { deps, state } = makeDeps(remote.provider, doc(999_999, '本地'));
    const out = await runPull(deps);

    expect(out.action).toBe('none');
    expect(state.local.cells['general-internal'][0].summary).toBe('本地');
  });

  it('时间戳打平 + ask → 挂 pull 冲突，不动本地', async () => {
    const remoteJson = serializeDoc(doc(100, '远端', 'd-remote'));
    const remote = fakeProvider(remoteJson);
    const { deps, state } = makeDeps(remote.provider, doc(100, '本地'), 'ask');
    const out = await runPull(deps);

    expect(out.action).toBe('none');
    expect(out.conflict?.kind).toBe('pull');
    expect(out.conflict?.remoteJson).toBe(remoteJson);
    expect(state.local.cells['general-internal'][0].summary).toBe('本地');
  });

  it('时间戳打平 + force → 采用远端', async () => {
    const remote = fakeProvider(serializeDoc(doc(100, '远端', 'd-remote')));
    const { deps, state } = makeDeps(remote.provider, doc(100, '本地'), 'ask');
    const out = await runPull(deps, { force: true });

    expect(out.action).toBe('pull');
    expect(state.local.cells['general-internal'][0].summary).toBe('远端');
  });

  it('remoteJsonOverride 直接用现场那份，不再打一次网络', async () => {
    const override = serializeDoc(doc(500, '冲突现场', 'd-remote'));
    const remote = fakeProvider(null);
    const { deps, state } = makeDeps(remote.provider, doc(100, '本地'));
    const out = await runPull(deps, { force: true, remoteJsonOverride: override });

    expect(out.action).toBe('pull');
    expect(remote.state.reads).toBe(0);
    expect(state.local.cells['general-internal'][0].summary).toBe('冲突现场');
  });

  it('远端 JSON 非法 → 抛错，而不是把本地清空', async () => {
    const remote = fakeProvider('不是 JSON');
    const { deps, state } = makeDeps(remote.provider, doc(100, '本地'));
    await expect(runPull(deps)).rejects.toThrow(/远端文件不是合法的 checklist JSON/);
    expect(state.local.cells['general-internal'][0].summary).toBe('本地');
  });
});

describe('adopt', () => {
  it('远端更新时不改时间戳', () => {
    expect(adopt(doc(500, 'r'), 100).updatedAt).toBe(500);
  });

  // Without bumping the timestamp, an open extension page would ignore this adoption and
  // then write the old content back to storage -- making the whole pull pointless.
  it('远端不比本地新时把时间戳抬到本地之上', () => {
    const adopted = adopt(doc(100, 'r'), 100);
    expect(adopted.updatedAt).toBe(101);
    expect(adopted.updatedAt).toBeGreaterThan(100);
  });

  it('抬高时间戳不会动内容', () => {
    const adopted = adopt(doc(100, 'r'), 500);
    expect(adopted.cells).toEqual(doc(100, 'r').cells);
    expect(adopted.deviceId).toBe('d-local');
  });
});

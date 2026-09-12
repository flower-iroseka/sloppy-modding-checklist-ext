import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyDoc } from '../src/core/doc';
import { applyExternalDoc, flushPersist, isPersistDirty, markPersisted } from '../src/core/persist';
import { checklistStore } from '../src/core/store';
import type { ChecklistDoc } from '../src/core/types';
import { resetStore } from './helpers';

/**
 * Multi-context sync through chrome.storage.onChanged: applyExternalDoc.
 *
 * A doc has to survive three things at once -- a remote that is older, a remote that
 * arrives while local changes aren't persisted yet, and the echo of this context's own
 * write. Each case sets one of those up and checks which way the decision went.
 */

/** Read the store's current state, so we don't have to write checklistStore.getState() everywhere. */
function s() {
  return checklistStore.getState();
}

/**
 * Build a "remote" doc with 1 general-internal entry.
 *
 * The timestamp is an offset from now: the local doc's updatedAt is Date.now(), so a
 * hardcoded small number would read as "older than local" and be ignored -- which is
 * one of the rules this file checks.
 *
 * @param offsetMs millisecond offset from the current time; a positive number means newer than local
 * @param summary summary for that entry
 * @returns a doc for device d-remote with just that entry
 */
function remoteDoc(offsetMs: number, summary = '远端条目'): ChecklistDoc {
  const updatedAt = Date.now() + offsetMs;
  const doc = createEmptyDoc('d-remote', updatedAt);
  doc.updatedAt = updatedAt;
  doc.cells['general-internal'].push({
    id: 'r1',
    scope: 'general',
    source: 'internal',
    summary,
    links: [],
    createdAt: updatedAt,
    updatedAt,
  });
  return doc;
}

describe('多上下文实时同步（chrome.storage.onChanged）', () => {
  beforeEach(() => {
    resetStore();
    markPersisted(s().doc);
  });

  it('未水合时不采纳外部文档', () => {
    expect(s().hydrated).toBe(false);
    expect(applyExternalDoc(remoteDoc(5_000))).toBe('ignored');
  });

  it('水合后采纳更新的远端文档', async () => {
    await s().hydrate();
    markPersisted(s().doc);

    expect(applyExternalDoc(remoteDoc(60_000))).toBe('applied');
    expect(s().doc.cells['general-internal'].map((e) => e.summary)).toEqual(['远端条目']);
    expect(s().doc.deviceId).toBe('d-remote');
  });

  it('远端不比本地新 → 不采纳（同时天然忽略自己写盘产生的回声）', async () => {
    await s().hydrate();
    markPersisted(s().doc);
    const current = s().doc;

    expect(applyExternalDoc(remoteDoc(-1_000))).toBe('ignored');
    expect(applyExternalDoc(remoteDoc(-2_000))).toBe('ignored');
    expect(s().doc).toBe(current);
  });

  it('本地有未落盘的改动时，外部改动被拒绝（避免丢数据）', async () => {
    await s().hydrate();
    markPersisted(s().doc);

    s().addEntry({ scope: 'general', source: 'internal', summary: '本地新条目' });
    expect(isPersistDirty()).toBe(true);

    expect(applyExternalDoc(remoteDoc(60_000))).toBe('ignored');
    expect(s().doc.cells['general-internal'].map((e) => e.summary)).toEqual(['本地新条目']);

    // Once the local change is persisted, later remote changes can be accepted
    await flushPersist();
    expect(isPersistDirty()).toBe(false);
    expect(applyExternalDoc(remoteDoc(120_000, '后来的远端'))).toBe('applied');
    expect(s().doc.cells['general-internal'].map((e) => e.summary)).toEqual(['后来的远端']);
  });

  it('非法/损坏的远端值被忽略而不是抛错', async () => {
    await s().hydrate();
    markPersisted(s().doc);

    expect(applyExternalDoc(undefined)).toBe('ignored');
    expect(applyExternalDoc('not a doc')).toBe('ignored');
    expect(applyExternalDoc({ schemaVersion: 99, cells: {} })).toBe('ignored');
  });

  it('采纳后本地不再处于 dirty 状态（不会把刚收到的远端内容又写回去）', async () => {
    await s().hydrate();
    markPersisted(s().doc);

    applyExternalDoc(remoteDoc(60_000));
    expect(isPersistDirty()).toBe(false);
  });
});

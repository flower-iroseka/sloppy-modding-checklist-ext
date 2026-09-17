import { beforeEach, describe, expect, it, vi } from 'vitest';
import { totalCount } from '../src/core/cells';
import { createEmptyDoc } from '../src/core/doc';
import { startAutoPersist, flushPersist } from '../src/core/persist';
import { DOC_KEY } from '../src/core/storage';
import { checklistStore } from '../src/core/store';
import { createMemoryStorage, resetStore, type MemoryStorage } from './helpers';

/**
 * Persisting the doc: hydrate, the debounced auto-persist, and the guards around flush.
 *
 * The one that isn't obvious is "no local changes -> don't write": a tab the browser
 * froze misses storage.onChanged, and on wake an unconditional write would put stale
 * content back over a newer remote. The case right below it is its negative control.
 */

/** Read the store's current state, so we don't have to write checklistStore.getState() everywhere. */
function s() {
  return checklistStore.getState();
}

/**
 * Fish the persisted doc out of the in-memory storage.
 *
 * @param mem the in-memory storage
 * @returns the stored doc; undefined when nothing was written or the key was removed
 */
function storedDoc(mem: MemoryStorage) {
  return mem.dump()[DOC_KEY] as { cells: Record<string, unknown[]>; deviceId: string } | undefined;
}

describe('persistence', () => {
  let mem: MemoryStorage;

  beforeEach(() => {
    mem = resetStore();
  });

  it('hydrate: first start creates an empty doc and writes it, deviceId stays stable', async () => {
    await s().hydrate();

    expect(s().hydrated).toBe(true);
    const doc = storedDoc(mem);
    expect(doc).toBeDefined();
    expect(doc!.deviceId).toBe(s().doc.deviceId);
    expect(totalCount(s().doc.cells)).toBe(0);
  });

  it('CRUD -> flush -> hydrate again: data is still there (survives a "refresh" round trip)', async () => {
    await s().hydrate();
    s().addEntry({
      scope: 'individual',
      source: 'external',
      summary: 'pattern 需要改',
      links: ['https://osu.ppy.sh/beatmapsets/9/discussion/1'],
      note: '备注内容',
      sourceAuthor: { username: 'Electoz', id: 123 },
      meta: { beatmapsetId: 9, mode: 'mania' },
    });
    await flushPersist();

    // Simulate a page refresh: clear the in-memory state and rehydrate
    const deviceId = s().doc.deviceId;
    checklistStore.setState({
      doc: createEmptyDoc('d-other', 1),
      hydrated: false,
      saving: false,
      lastSavedAt: undefined,
      lastError: undefined,
    });
    await s().hydrate();

    expect(s().doc.deviceId).toBe(deviceId);
    const list = s().doc.cells['individual-external'];
    expect(list).toHaveLength(1);
    expect(list[0]!.summary).toBe('pattern 需要改');
    expect(list[0]!.note).toBe('备注内容');
    expect(list[0]!.sourceAuthor).toEqual({ username: 'Electoz', id: 123 });
    expect(list[0]!.meta).toEqual({ beatmapsetId: 9, mode: 'mania' });
  });

  it('flush also writes after destroy/removing an entry', async () => {
    await s().hydrate();
    const a = s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    s().addEntry({ scope: 'general', source: 'internal', summary: 'b' });
    await flushPersist();

    s().removeEntry(a.id);
    await flushPersist();

    const doc = storedDoc(mem)!;
    expect((doc.cells['general-internal'] as { summary: string }[]).map((e) => e.summary)).toEqual(['b']);
  });

  it('auto-persist: writes only once the debounce elapses after a change', async () => {
    vi.useFakeTimers();
    try {
      const stop = startAutoPersist(300);
      await s().hydrate();
      mem.remove(DOC_KEY);

      s().addEntry({ scope: 'general', source: 'internal', summary: 'debounce' });
      expect(storedDoc(mem)).toBeUndefined(); // 300ms hasn't passed yet

      await vi.advanceTimersByTimeAsync(320);
      await flushPersist(); // wait for the chained write to finish

      expect(storedDoc(mem)).toBeDefined();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flush does not write when there are no local changes (a frozen tab that wakes up will not put stale content back)', async () => {
    // Setup: this realm holds A (already persisted, not dirty), then another context
    // writes B. The real trigger is a background tab the browser has frozen -- while
    // frozen it can't run `storage.onChanged`, and when it wakes up `visibilitychange`
    // / `pagehide` will flush; an unconditional write would put B back to A. The
    // symptom is "I did sync, but the data went back a few minutes" -- and silently.
    await s().hydrate();
    s().addEntry({ scope: 'general', source: 'internal', summary: 'A' });
    await flushPersist();
    const afterA = storedDoc(mem)!.deviceId;

    // Another realm writes B: persist directly, bypassing the store, and don't notify
    // this realm (simulating the freeze)
    const mine = s().doc;
    await mem.set({
      [DOC_KEY]: {
        schemaVersion: 1,
        updatedAt: mine.updatedAt + 60_000,
        deviceId: '另一个 realm',
        cells: mine.cells,
      },
    });

    // This realm wakes up -> flush (quitting / switching to background reaches here)
    await flushPersist();

    expect(storedDoc(mem)!.deviceId).toBe('另一个 realm');
    expect(afterA).not.toBe('另一个 realm');
  });

  it('still writes when there really are local changes (negative control for the previous case)', async () => {
    // The previous test guards "don't write carelessly". This one guards that it doesn't
    // also block the writes that should happen -- without it, a plain `return` at the top
    // of `writeCurrent` would also make the previous test pass.
    await s().hydrate();
    const before = totalCount(s().doc.cells);
    s().addEntry({ scope: 'general', source: 'internal', summary: '真改了一条' });

    await flushPersist();

    expect(totalCount(storedDoc(mem)!.cells as Parameters<typeof totalCount>[0])).toBe(before + 1);
  });

  it('a failed write records lastError instead of throwing', async () => {
    resetStore({
      ...createMemoryStorage(),
      // Override set to make it fail
      async set() {
        throw new Error('quota exceeded');
      },
    } as unknown as MemoryStorage);
    await s().hydrate();
    s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });

    await flushPersist();

    expect(s().lastError).toContain('quota exceeded');
    expect(s().saving).toBe(false);
  });
});

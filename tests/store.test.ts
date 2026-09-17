import { beforeEach, describe, expect, it } from 'vitest';
import { totalCount } from '../src/core/cells';
import { checklistStore } from '../src/core/store';
import { resetStore } from './helpers';

/**
 * Store CRUD: addEntry, updateEntry, removeEntry, moveEntry and clearAll.
 *
 * Where an entry ends up is the part worth pinning down -- which cell, which index, and
 * that changing scope/source moves it between cells -- so most cases assert on the cell
 * contents rather than on the returned entry.
 */

/** Read the store's current state, so we don't have to write checklistStore.getState() everywhere. */
function s() {
  return checklistStore.getState();
}

describe('store CRUD', () => {
  beforeEach(() => {
    resetStore();
  });

  it('addEntry lands in the right cell and generates an id / timestamp', () => {
    const entry = s().addEntry({
      scope: 'general',
      source: 'internal',
      summary: 'Jumps are harder than the chorus',
      links: ['https://osu.ppy.sh/beatmapsets/1/discussion/2'],
    });

    expect(entry.id).toBeTruthy();
    expect(entry.createdAt).toBeGreaterThan(0);
    expect(s().doc.cells['general-internal']).toHaveLength(1);
    expect(s().doc.cells['general-internal'][0]!.summary).toContain('Jumps');
    expect(totalCount(s().doc.cells)).toBe(1);
  });

  it('each of the four cells counts independently', () => {
    s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    s().addEntry({ scope: 'general', source: 'external', summary: 'b' });
    s().addEntry({ scope: 'individual', source: 'external', summary: 'c' });

    expect(s().doc.cells['general-internal']).toHaveLength(1);
    expect(s().doc.cells['general-external']).toHaveLength(1);
    expect(s().doc.cells['individual-internal']).toHaveLength(0);
    expect(s().doc.cells['individual-external']).toHaveLength(1);
    expect(totalCount(s().doc.cells)).toBe(3);
  });

  it('updateEntry changes fields but keeps its position', () => {
    const a = s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    s().addEntry({ scope: 'general', source: 'internal', summary: 'b' });

    s().updateEntry(a.id, { summary: 'a2', note: '备注' });

    const list = s().doc.cells['general-internal'];
    expect(list.map((e) => e.summary)).toEqual(['a2', 'b']);
    expect(list[0]!.note).toBe('备注');
  });

  it('updateEntry moves to the target cell when scope/source changes', () => {
    const a = s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });

    s().updateEntry(a.id, { scope: 'individual', source: 'external' });

    expect(s().doc.cells['general-internal']).toHaveLength(0);
    expect(s().doc.cells['individual-external']).toHaveLength(1);
    expect(s().doc.cells['individual-external'][0]!.scope).toBe('individual');
    expect(s().doc.cells['individual-external'][0]!.source).toBe('external');
  });

  it('removeEntry deletes the given entry', () => {
    const a = s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    s().addEntry({ scope: 'general', source: 'internal', summary: 'b' });

    s().removeEntry(a.id);

    expect(s().doc.cells['general-internal'].map((e) => e.summary)).toEqual(['b']);
  });

  it('moveEntry across cells: updates scope/source and inserts at the target index', () => {
    const a = s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    s().addEntry({ scope: 'individual', source: 'external', summary: 'x' });
    s().addEntry({ scope: 'individual', source: 'external', summary: 'y' });

    s().moveEntry(a.id, 'individual-external', 1);

    expect(s().doc.cells['general-internal']).toHaveLength(0);
    const dst = s().doc.cells['individual-external'];
    expect(dst.map((e) => e.summary)).toEqual(['x', 'a', 'y']);
    expect(dst[1]!.scope).toBe('individual');
    expect(dst[1]!.source).toBe('external');
  });

  it('moveEntry reorders within the same cell', () => {
    const a = s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    s().addEntry({ scope: 'general', source: 'internal', summary: 'b' });
    s().addEntry({ scope: 'general', source: 'internal', summary: 'c' });

    s().moveEntry(a.id, 'general-internal', 2);

    expect(s().doc.cells['general-internal'].map((e) => e.summary)).toEqual(['b', 'c', 'a']);
  });

  it('moveEntry with an empty id does not change the doc', () => {
    s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    const before = s().doc;

    s().moveEntry('missing-id', 'individual-external');

    expect(s().doc).toBe(before);
  });

  it('clearAll empties the cells but keeps deviceId', () => {
    s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    const deviceId = s().doc.deviceId;

    s().clearAll();

    expect(totalCount(s().doc.cells)).toBe(0);
    expect(s().doc.deviceId).toBe(deviceId);
  });
});

describe('store and the difficulty tier', () => {
  beforeEach(() => {
    resetStore();
  });

  it('addEntry stores the tier', () => {
    const entry = s().addEntry({
      scope: 'individual',
      source: 'external',
      summary: 'a',
      difficulty: 'hard',
    });
    expect(entry.difficulty).toBe('hard');
    expect(s().doc.cells['individual-external'][0]!.difficulty).toBe('hard');
  });

  it('addEntry without a tier stores no difficulty key at all', () => {
    const entry = s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    expect('difficulty' in entry).toBe(false);
  });

  it('updateEntry can change the tier', () => {
    // Regression guard for the filter in updateEntry's patch type: drop 'difficulty' from
    // that union and the value is silently discarded here, with no error anywhere.
    const a = s().addEntry({
      scope: 'individual',
      source: 'external',
      summary: 'a',
      difficulty: 'easy',
    });

    s().updateEntry(a.id, { difficulty: 'expert' });

    expect(s().doc.cells['individual-external'][0]!.difficulty).toBe('expert');
  });

  it('updateEntry without a tier keeps the existing one', () => {
    const a = s().addEntry({
      scope: 'individual',
      source: 'external',
      summary: 'a',
      difficulty: 'hard',
    });

    s().updateEntry(a.id, { summary: 'a2' });

    expect(s().doc.cells['individual-external'][0]!.difficulty).toBe('hard');
  });

  it('moveEntry carries the tier across cells, even into General where it is not shown', () => {
    const a = s().addEntry({
      scope: 'individual',
      source: 'external',
      summary: 'a',
      difficulty: 'insane',
    });

    s().moveEntry(a.id, 'general-internal');

    expect(s().doc.cells['general-internal'][0]!.difficulty).toBe('insane');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { emptyCells, parseCellId } from '../src/core/cells';
import { createEmptyDoc } from '../src/core/doc';
import { isNoopDrop, resolveDrop, zoneDroppableId } from '../src/core/dnd';
import { checklistStore } from '../src/core/store';
import type { CellId, ChecklistDoc } from '../src/core/types';
import { resetStore } from './helpers';

/**
 * Drag-and-drop: which cell and index a drop resolves to, and the order that ends up in
 * the store.
 *
 * `drag` runs what the UI runs on release (resolveDrop -> isNoopDrop -> moveEntry).
 * resolveDrop is also tested on its own, because a correct target is still wrong if the
 * move lands at a different index.
 */

/**
 * Build a doc with each cell filled from a shorthand spec, so a test doesn't have to
 * write out its entries by hand.
 *
 * @param spec a list of ids per cell; the id doubles as the summary, and scope / source
 *   are derived from the cell name
 * @returns a d-test doc with only the cells named in spec filled in
 */
function docWith(spec: Partial<Record<CellId, string[]>>): ChecklistDoc {
  const doc = createEmptyDoc('d-test', 1_000);
  const cells = emptyCells();
  for (const [key, list] of Object.entries(spec)) {
    const { scope, source } = parseCellId(key as CellId);
    cells[key as CellId] = (list ?? []).map((id) => ({
      id,
      scope,
      source,
      summary: id,
      links: [],
      createdAt: 1,
      updatedAt: 1,
    }));
  }
  return { ...doc, cells };
}

/**
 * Read the id order of all four cells from the current store, for asserting move results.
 *
 * @returns cell name to the entry ids in that cell, in order
 */
function order(): Record<CellId, string[]> {
  const cells = checklistStore.getState().doc.cells;
  return {
    'general-internal': cells['general-internal'].map((e) => e.id),
    'general-external': cells['general-external'].map((e) => e.id),
    'individual-internal': cells['individual-internal'].map((e) => e.id),
    'individual-external': cells['individual-external'].map((e) => e.id),
  };
}

/**
 * Run the whole flow the UI runs on release: resolve the target, check for a no-op, then
 * moveEntry.
 *
 * @param fromId id of the entry being dragged
 * @param overId droppable id of the drop target on release, either a card id or a zone id
 */
function drag(fromId: string, overId: string): void {
  const cells = checklistStore.getState().doc.cells;
  const drop = resolveDrop(cells, overId, fromId);
  if (!drop || isNoopDrop(cells, fromId, drop)) return;
  checklistStore.getState().moveEntry(fromId, drop.cell, drop.index);
}

describe('drop target resolution (pure functions)', () => {
  const cells = docWith({ 'general-internal': ['a', 'b', 'c'], 'general-external': ['x'] }).cells;

  it('dropping on a cell dropzone -> appends to the end of that cell', () => {
    expect(resolveDrop(cells, zoneDroppableId('individual-external'))).toEqual({
      cell: 'individual-external',
    });
  });

  it('dropping on a card -> that card cell and index', () => {
    expect(resolveDrop(cells, 'b')).toEqual({ cell: 'general-internal', index: 1 });
    expect(resolveDrop(cells, 'x')).toEqual({ cell: 'general-external', index: 0 });
  });

  it('dropping on itself / an unresolvable target -> null', () => {
    expect(resolveDrop(cells, 'a', 'a')).toBeNull();
    expect(resolveDrop(cells, null)).toBeNull();
    expect(resolveDrop(cells, 'zone:nope')).toBeNull();
    expect(resolveDrop(cells, 'not-an-entry')).toBeNull();
  });
});

describe('store order after a drop (resolveDrop + moveEntry end to end)', () => {
  beforeEach(() => {
    resetStore();
    checklistStore.getState().replaceDoc(docWith({ 'general-internal': ['a', 'b', 'c'], 'general-external': ['x', 'y'] }));
  });

  it('drag down within the same cell (a onto c)', () => {
    drag('a', 'c');
    expect(order()['general-internal']).toEqual(['b', 'c', 'a']);
  });

  it('drag up within the same cell (c onto a)', () => {
    drag('c', 'a');
    expect(order()['general-internal']).toEqual(['c', 'a', 'b']);
  });

  it('adjacent within the same cell (a onto b = swap)', () => {
    drag('a', 'b');
    expect(order()['general-internal']).toEqual(['b', 'a', 'c']);
  });

  it('cross-cell drop before a given entry (b -> before x)', () => {
    drag('b', 'x');
    expect(order()['general-internal']).toEqual(['a', 'c']);
    expect(order()['general-external']).toEqual(['b', 'x', 'y']);
  });

  it('cross-cell drop on empty space in the target = append to the end (a -> general-external zone)', () => {
    drag('a', zoneDroppableId('general-external'));
    expect(order()['general-internal']).toEqual(['b', 'c']);
    expect(order()['general-external']).toEqual(['x', 'y', 'a']);
  });

  it('a cross-cell drop also rewrites the entry scope/source (dragging = reclassifying)', () => {
    drag('b', zoneDroppableId('individual-external'));
    const moved = checklistStore.getState().doc.cells['individual-external'][0]!;
    expect(moved.id).toBe('b');
    expect(moved.scope).toBe('individual');
    expect(moved.source).toBe('external');
  });

  it('dropping back in place does not change the order', () => {
    drag('b', 'b');
    expect(order()['general-internal']).toEqual(['a', 'b', 'c']);
  });

  it('drop at the end of its own cell when already last -> no change', () => {
    drag('c', zoneDroppableId('general-internal'));
    expect(order()['general-internal']).toEqual(['a', 'b', 'c']);
  });
});

describe('no-op detection', () => {
  const cells = docWith({ 'general-internal': ['a', 'b', 'c'] }).cells;

  const ownZone = zoneDroppableId('general-internal');

  it('dropping on itself counts as a no-op', () => {
    expect(resolveDrop(cells, 'c', 'c')).toBeNull();
    expect(isNoopDrop(cells, 'c', resolveDrop(cells, 'c', 'c'))).toBe(true);
  });

  it('drop at the end of its own cell when already last -> no-op', () => {
    expect(isNoopDrop(cells, 'c', resolveDrop(cells, ownZone, 'c'))).toBe(true);
  });

  it('drop at the end of its own cell but not already last -> not a no-op', () => {
    expect(isNoopDrop(cells, 'a', resolveDrop(cells, ownZone, 'a'))).toBe(false);
  });

  it('a cross-cell drop is always a real move', () => {
    expect(isNoopDrop(cells, 'a', { cell: 'individual-external' })).toBe(false);
  });

  it('an unresolvable drop target counts as a no-op (the move is dropped)', () => {
    expect(isNoopDrop(cells, 'a', null)).toBe(true);
  });
});

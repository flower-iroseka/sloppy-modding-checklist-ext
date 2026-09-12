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

describe('拖拽落点解析（纯函数）', () => {
  const cells = docWith({ 'general-internal': ['a', 'b', 'c'], 'general-external': ['x'] }).cells;

  it('落在格子的 dropzone → 追加到该格末尾', () => {
    expect(resolveDrop(cells, zoneDroppableId('individual-external'))).toEqual({
      cell: 'individual-external',
    });
  });

  it('落在某条卡片上 → 该卡片所在格与下标', () => {
    expect(resolveDrop(cells, 'b')).toEqual({ cell: 'general-internal', index: 1 });
    expect(resolveDrop(cells, 'x')).toEqual({ cell: 'general-external', index: 0 });
  });

  it('落在自己身上 / 解析不出的目标 → null', () => {
    expect(resolveDrop(cells, 'a', 'a')).toBeNull();
    expect(resolveDrop(cells, null)).toBeNull();
    expect(resolveDrop(cells, 'zone:nope')).toBeNull();
    expect(resolveDrop(cells, 'not-an-entry')).toBeNull();
  });
});

describe('拖拽后的落库顺序（resolveDrop + moveEntry 端到端）', () => {
  beforeEach(() => {
    resetStore();
    checklistStore.getState().replaceDoc(docWith({ 'general-internal': ['a', 'b', 'c'], 'general-external': ['x', 'y'] }));
  });

  it('同格内往下拖（a 落到 c 上）', () => {
    drag('a', 'c');
    expect(order()['general-internal']).toEqual(['b', 'c', 'a']);
  });

  it('同格内往上拖（c 落到 a 上）', () => {
    drag('c', 'a');
    expect(order()['general-internal']).toEqual(['c', 'a', 'b']);
  });

  it('同格内相邻（a 落到 b 上 = 交换）', () => {
    drag('a', 'b');
    expect(order()['general-internal']).toEqual(['b', 'a', 'c']);
  });

  it('跨格落到指定条目前（b → x 之前）', () => {
    drag('b', 'x');
    expect(order()['general-internal']).toEqual(['a', 'c']);
    expect(order()['general-external']).toEqual(['b', 'x', 'y']);
  });

  it('跨格落到目标格空白处 = 追加到末尾（a → general-external 区）', () => {
    drag('a', zoneDroppableId('general-external'));
    expect(order()['general-internal']).toEqual(['b', 'c']);
    expect(order()['general-external']).toEqual(['x', 'y', 'a']);
  });

  it('跨格落点会同时改写条目的 scope/source（拖拽 = 改分类）', () => {
    drag('b', zoneDroppableId('individual-external'));
    const moved = checklistStore.getState().doc.cells['individual-external'][0]!;
    expect(moved.id).toBe('b');
    expect(moved.scope).toBe('individual');
    expect(moved.source).toBe('external');
  });

  it('拖回原位不改变顺序', () => {
    drag('b', 'b');
    expect(order()['general-internal']).toEqual(['a', 'b', 'c']);
  });

  it('拖到本格末尾且本来就在末尾 → 不动', () => {
    drag('c', zoneDroppableId('general-internal'));
    expect(order()['general-internal']).toEqual(['a', 'b', 'c']);
  });
});

describe('no-op 判定', () => {
  const cells = docWith({ 'general-internal': ['a', 'b', 'c'] }).cells;

  const ownZone = zoneDroppableId('general-internal');

  it('落在自己身上算 no-op', () => {
    expect(resolveDrop(cells, 'c', 'c')).toBeNull();
    expect(isNoopDrop(cells, 'c', resolveDrop(cells, 'c', 'c'))).toBe(true);
  });

  it('拖到本格末尾且本来就在末尾 → no-op', () => {
    expect(isNoopDrop(cells, 'c', resolveDrop(cells, ownZone, 'c'))).toBe(true);
  });

  it('拖到本格末尾但不在末尾 → 不是 no-op', () => {
    expect(isNoopDrop(cells, 'a', resolveDrop(cells, ownZone, 'a'))).toBe(false);
  });

  it('跨格永远是有效移动', () => {
    expect(isNoopDrop(cells, 'a', { cell: 'individual-external' })).toBe(false);
  });

  it('无法解析的落点算 no-op（放弃移动）', () => {
    expect(isNoopDrop(cells, 'a', null)).toBe(true);
  });
});

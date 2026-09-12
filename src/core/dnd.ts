import { CELL_IDS, locateEntry } from './cells';
import type { CellId, ChecklistEntry } from './types';

/**
 * Drag-and-drop drop resolution (CODING_PLAN §5.4).
 *
 * One DndContext for the whole page: each cell is a droppable (`zone:general-internal`)
 * and each card is a sortable. When a drag ends this module turns dnd-kit's `over` into
 * the `(cell, index)` that `moveEntry` needs. index follows dnd-kit's arrayMove -- take
 * the source element out first, then insert -- and store.moveEntry uses the same rule, so
 * the two line up (see tests/dnd.test.ts).
 */

const ZONE_PREFIX = 'zone:';

/**
 * @param cell a cell name
 * @returns the droppable id of that cell's dropzone
 */
export function zoneDroppableId(cell: CellId): string {
  return `${ZONE_PREFIX}${cell}`;
}

/**
 * @param id the droppable id dnd-kit gives us
 * @returns the cell name after the `zone:` prefix; null when the id is missing or isn't a cell
 */
export function cellFromZoneDroppableId(id: string | null | undefined): CellId | null {
  if (!id || !id.startsWith(ZONE_PREFIX)) return null;
  const cell = id.slice(ZONE_PREFIX.length);
  return (CELL_IDS as readonly string[]).includes(cell) ? (cell as CellId) : null;
}

/** Where one drag lands. */
export interface DropResolution {
  /** Which cell it lands in. */
  cell: CellId;
  /** Index within the cell. Omitted = append to the end of the target cell. */
  index?: number;
}

/**
 * Resolve dnd-kit's `over.id` into a drop: hitting a cell's dropzone appends to the
 * end of that cell, hitting a card lands at that card's cell and index.
 *
 * @param cells the four cells, used to find which cell a card id belongs to
 * @param overId the `over.id` dnd-kit gives when the drag ends
 * @param activeId the id of the entry being dragged; equal to overId means it stays put
 * @returns the drop, or null when the drag lands on empty space and nothing resolves, in
 *   which case the caller gives up on the move
 */
export function resolveDrop(
  cells: Record<CellId, ChecklistEntry[]>,
  overId: string | null | undefined,
  activeId?: string,
): DropResolution | null {
  if (!overId) return null;

  const zoneCell = cellFromZoneDroppableId(overId);
  if (zoneCell) {
    // Dropped on a cell's empty area: treat it as a move to the end. That does nothing
    // when the card is already last; the store handles it as a no-op.
    return { cell: zoneCell };
  }

  const found = locateEntry(cells, overId);
  if (!found) return null;
  // Dropped on itself: stays put
  if (activeId !== undefined && overId === activeId) return null;
  return { cell: found.cell, index: found.index };
}

/**
 * Whether the drop leaves the position where it was, so it can be skipped. Guards against
 * pointless doc.updatedAt churn and disk writes.
 *
 * @param cells the four cells
 * @param activeId the id of the entry being dragged
 * @param drop the resolved drop
 * @returns true when the position doesn't change, or when there's no drop to resolve at all
 */
export function isNoopDrop(
  cells: Record<CellId, ChecklistEntry[]>,
  activeId: string,
  drop: DropResolution | null,
): boolean {
  if (!drop) return true;
  const found = locateEntry(cells, activeId);
  if (!found) return true;
  if (found.cell !== drop.cell) return false;
  // Same cell: no index means append to the end, and after the source element is taken
  // out that lands on the last position, i.e. the original length - 1
  const target = drop.index ?? cells[drop.cell].length - 1;
  return target === found.index;
}

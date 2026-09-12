import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { CELL_IDS, totalCount } from '../core/cells';
import { checklistStore, type ChecklistStore } from '../core/store';

/**
 * Subscribe to the checklist store.
 *
 * @param selector picks out the part of the state to subscribe to
 * @returns the selected value; when the selector returns a new object the component re-renders
 *   endlessly, so it has to be paired with useShallow
 */
export function useChecklist<T>(selector: (state: ChecklistStore) => T): T {
  return useStore(checklistStore, selector);
}

/**
 * Entry count of a single cell.
 *
 * @param cell which cell to count, shaped like `general-internal`
 * @returns the entry count of that cell; returns a number directly to avoid creating a new object every frame
 */
export function useCellCount(cell: (typeof CELL_IDS)[number]): number {
  return useChecklist((s) => s.doc.cells[cell].length);
}

/**
 * Total entry count across the four cells.
 *
 * @returns the total entry count
 */
export function useTotalCount(): number {
  return useChecklist((s) => totalCount(s.doc.cells));
}

/**
 * Whether the doc has been read out of storage.
 *
 * @returns while false the UI shouldn't show 0 yet, otherwise it flashes the empty state in front
 *   of a user who has data
 */
export function useHydrated(): boolean {
  return useChecklist((s) => s.hydrated);
}

/**
 * The save-state trio. Shallow-compared, so the object only changes when one of the three does.
 *
 * @returns saving right now / time of the last successful save / last save error; `lastSavedAt` is
 *   undefined until the first successful save, `lastError` is cleared on the next success
 */
export function useSaveState(): { saving: boolean; lastSavedAt?: number; lastError?: string } {
  return useChecklist(
    useShallow((s) => ({ saving: s.saving, lastSavedAt: s.lastSavedAt, lastError: s.lastError })),
  );
}

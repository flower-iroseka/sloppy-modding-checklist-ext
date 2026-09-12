import { createStore } from 'zustand/vanilla';
import { cellId, locateEntry, parseCellId } from './cells';
import { createEmptyDoc, normalizeDoc } from './doc';
import { newId } from './ids';
import { readDoc, writeDoc } from './storage';
import type { CellId, ChecklistDoc, ChecklistEntry, NewEntryInput } from './types';

/** The data held in the store. */
export interface ChecklistState {
  /**
   * The document in memory. Always a valid, normalized one: hydrate and replaceDoc both
   * run it through normalizeDoc, and the entry actions keep it valid as they go.
   */
  doc: ChecklistDoc;
  /** Whether the first hydration has finished (nothing is written to disk before it does) */
  hydrated: boolean;
  /** A write to storage is in flight */
  saving: boolean;
  /** Millisecond timestamp of the last successful write; undefined until the first one. */
  lastSavedAt?: number;
  /** The latest error, exactly the line shown to the user; cleared on the next success. */
  lastError?: string;
}

/** The operations you can perform on the document. */
export interface ChecklistActions {
  /**
   * Hydrate from storage at startup; if there's no data, create an empty document and write it.
   * Failures land in `lastError`, they don't reject.
   */
  hydrate(): Promise<void>;
  /**
   * Append a new entry to the end of the matching cell.
   *
   * @param input the content of the new entry; id and timestamps are generated here
   * @returns the entry that was created
   */
  addEntry(input: NewEntryInput): ChecklistEntry;
  /**
   * Change an existing entry. If patch carries scope/source it gets moved to the matching cell.
   *
   * @param id the id of the entry to change
   * @param patch the fields to change; scope/source left out keeps the old ones
   */
  updateEntry(
    id: string,
    patch: Partial<
      Pick<ChecklistEntry, 'summary' | 'links' | 'linkAuthors' | 'note' | 'scope' | 'source'>
    >,
  ): void;
  /** @param id the id of the entry to delete */
  removeEntry(id: string): void;
  /**
   * Drag drop: move the entry to targetIndex in the target cell.
   *
   * @param id the id of the entry to move
   * @param targetCell which cell it lands in
   * @param targetIndex index within the cell, against the array after the source element is
   *   removed; omitted = append to the end
   */
  moveEntry(id: string, targetCell: CellId, targetIndex?: number): void;
  /**
   * @param doc the document to replace it with; it gets normalized first
   * @throws {DocValidationError} the new document has an invalid structure
   */
  replaceDoc(doc: ChecklistDoc): void;
  /** Clear all entries. deviceId is kept, it's still the same device. */
  clearAll(): void;
  /** @param saving whether a write is in progress */
  setSaving(saving: boolean): void;
  /** @param at the timestamp of the successful write */
  markSaved(at: number): void;
  /** @param message the error message; pass undefined to clear it */
  setError(message?: string): void;
}

/** The full shape of the store: data plus actions. */
export type ChecklistStore = ChecklistState & ChecklistActions;

/** Turn a thrown thing into one line the user can read. */
function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The one global store. Plain zustand, so consumers read it through getState() rather than a hook. */
export const checklistStore = createStore<ChecklistStore>()((set, get) => ({
  doc: createEmptyDoc(),
  hydrated: false,
  saving: false,

  async hydrate() {
    try {
      const stored = await readDoc();
      const doc = stored ?? createEmptyDoc();
      set({ doc, hydrated: true, lastError: undefined });
      // First startup: write the empty document so the deviceId stays stable
      if (!stored) await writeDoc(doc);
    } catch (e) {
      set({ hydrated: true, lastError: errorMessage(e) });
    }
  },

  addEntry(input) {
    const now = Date.now();
    const entry: ChecklistEntry = {
      id: newId(),
      scope: input.scope,
      source: input.source,
      summary: input.summary,
      links: input.links ?? [],
      ...(input.linkAuthors && Object.keys(input.linkAuthors).length > 0
        ? { linkAuthors: input.linkAuthors }
        : {}),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.sourceAuthor ? { sourceAuthor: input.sourceAuthor } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
      createdAt: now,
      updatedAt: now,
    };
    const cell = cellId(entry.scope, entry.source);
    set((state) => ({
      doc: {
        ...state.doc,
        updatedAt: now,
        cells: { ...state.doc.cells, [cell]: [...state.doc.cells[cell], entry] },
      },
    }));
    return entry;
  },

  updateEntry(id, patch) {
    set((state) => {
      const found = locateEntry(state.doc.cells, id);
      if (!found) return {};

      const scope = patch.scope ?? found.entry.scope;
      const source = patch.source ?? found.entry.source;
      const nextCell = cellId(scope, source);
      const now = Date.now();
      const updated: ChecklistEntry = { ...found.entry, ...patch, scope, source, updatedAt: now };

      const cells = { ...state.doc.cells };
      if (nextCell === found.cell) {
        const list = [...cells[found.cell]];
        list[found.index] = updated;
        cells[found.cell] = list;
      } else {
        const from = [...cells[found.cell]];
        from.splice(found.index, 1);
        cells[found.cell] = from;
        cells[nextCell] = [...cells[nextCell], updated];
      }
      return { doc: { ...state.doc, updatedAt: now, cells } };
    });
  },

  removeEntry(id) {
    set((state) => {
      const found = locateEntry(state.doc.cells, id);
      if (!found) return {};
      const list = [...state.doc.cells[found.cell]];
      list.splice(found.index, 1);
      const now = Date.now();
      return {
        doc: {
          ...state.doc,
          updatedAt: now,
          cells: { ...state.doc.cells, [found.cell]: list },
        },
      };
    });
  },

  moveEntry(id, targetCell, targetIndex) {
    set((state) => {
      const found = locateEntry(state.doc.cells, id);
      if (!found) return {};

      const { scope, source } = parseCellId(targetCell);
      const now = Date.now();
      const moved: ChecklistEntry = { ...found.entry, scope, source, updatedAt: now };

      const cells = { ...state.doc.cells };
      const from = [...cells[found.cell]];
      from.splice(found.index, 1);
      cells[found.cell] = from;

      const to = [...cells[targetCell]];
      const index = targetIndex === undefined ? to.length : Math.max(0, Math.min(targetIndex, to.length));
      to.splice(index, 0, moved);
      cells[targetCell] = to;

      return { doc: { ...state.doc, updatedAt: now, cells } };
    });
  },

  replaceDoc(doc) {
    set({ doc: normalizeDoc(doc), lastError: undefined });
  },

  clearAll() {
    const { doc } = get();
    set({ doc: createEmptyDoc(doc.deviceId), lastError: undefined });
  },

  setSaving(saving) {
    set({ saving });
  },

  markSaved(at) {
    set({ lastSavedAt: at, lastError: undefined });
  },

  setError(message) {
    set({ lastError: message });
  },
}));

/**
 * Convenience read (non-React environments, like the content script / tests).
 *
 * @returns the store's current state
 */
export function getChecklistState(): ChecklistStore {
  return checklistStore.getState();
}

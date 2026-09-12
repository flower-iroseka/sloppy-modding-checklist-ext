import type { MessageKey } from '../i18n';
import type { CellId, ChecklistEntry, Scope, Source } from './types';

/** The two columns, in display order. */
export const SCOPES: readonly Scope[] = ['general', 'individual'];
/** The two sections inside each column, in display order. */
export const SOURCES: readonly Source[] = ['internal', 'external'];

/**
 * Display name for a scope; a key, not a string, so translation happens when it's shown
 * (reasoning in `i18n/types.ts`).
 *
 * The two scope names read the same in both languages, but they still go through a key:
 * callers then get the same kind of thing either way and don't have to remember which
 * one can be translated. This is the only i18n in this file, and it's an `import type`,
 * so the pure logic keeps zero runtime dependencies.
 */
export const SCOPE_LABEL_KEY: Record<Scope, MessageKey> = {
  general: 'scope.general',
  individual: 'scope.individual',
};

/** Display name for a source; same reasoning as `SCOPE_LABEL_KEY`. */
export const SOURCE_LABEL_KEY: Record<Source, MessageKey> = {
  internal: 'source.internal',
  external: 'source.external',
};

/** The four cells, in a fixed order: general-internal, general-external, individual-… */
export const CELL_IDS: readonly CellId[] = SCOPES.flatMap((scope) =>
  SOURCES.map((source) => cellId(scope, source)),
);

/**
 * Build a cell name.
 *
 * @param scope the column
 * @param source the section inside that column
 * @returns a cell name like `general-internal`
 */
export function cellId(scope: Scope, source: Source): CellId {
  return `${scope}-${source}`;
}

/**
 * @param value the value to test
 * @returns whether it is one of the four cell names
 */
export function isCellId(value: unknown): value is CellId {
  return typeof value === 'string' && (CELL_IDS as readonly string[]).includes(value);
}

/**
 * @param id a cell name
 * @returns the scope and source parsed out of it; no validation, the caller is expected
 *   to have checked with `isCellId` first
 */
export function parseCellId(id: CellId): { scope: Scope; source: Source } {
  const [scope, source] = id.split('-') as [Scope, Source];
  return { scope, source };
}

/**
 * @param value the value to test
 * @returns whether it is a valid scope
 */
export function isScope(value: unknown): value is Scope {
  return value === 'general' || value === 'individual';
}

/**
 * @param value the value to test
 * @returns whether it is a valid source
 */
export function isSource(value: unknown): value is Source {
  return value === 'internal' || value === 'external';
}

/**
 * @returns a record with an empty array for each of the four cells
 */
export function emptyCells(): Record<CellId, ChecklistEntry[]> {
  return {
    'general-internal': [],
    'general-external': [],
    'individual-internal': [],
    'individual-external': [],
  };
}

/**
 * @param cells the four cells
 * @returns the total number of entries across all cells
 */
export function totalCount(cells: Record<CellId, ChecklistEntry[]>): number {
  return CELL_IDS.reduce((sum, id) => sum + (cells[id]?.length ?? 0), 0);
}

/**
 * Search all four cells by entry id.
 *
 * @param cells the four cells
 * @param entryId the id of the entry to find
 * @returns the entry itself, its cell and its index; null if it isn't there
 */
export function locateEntry(
  cells: Record<CellId, ChecklistEntry[]>,
  entryId: string,
): { cell: CellId; index: number; entry: ChecklistEntry } | null {
  for (const cell of CELL_IDS) {
    const index = cells[cell]?.findIndex((e) => e.id === entryId) ?? -1;
    if (index >= 0) {
      const entry = cells[cell][index]!;
      return { cell, index, entry };
    }
  }
  return null;
}


import { emptyCells, isScope, isSource, CELL_IDS } from './cells';
import { newDeviceId, newId } from './ids';
import {
  SCHEMA_VERSION,
  type ChecklistDoc,
  type ChecklistEntry,
  type EntryMeta,
  type SourceAuthor,
} from './types';

/**
 * @param deviceId the document's deviceId; generated fresh if omitted
 * @param now the initial value of the document's updatedAt; defaults to the current time,
 *   tests can pass a fixed value
 * @returns a new document with all four cells empty
 */
export function createEmptyDoc(deviceId: string = newDeviceId(), now: number = Date.now()): ChecklistDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: now,
    deviceId,
    cells: emptyCells(),
  };
}

/**
 * The document structure isn't valid: not an object, schemaVersion missing or newer than
 * we support, cells missing.
 */
export class DocValidationError extends Error {}

/** @returns the value as-is if it's a string, otherwise undefined. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Drop non-strings and blank items; treat anything that isn't an array as an empty array. */
function normalizeLinks(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
}

/**
 * @param raw the author field from any source
 * @returns a valid author; undefined when username is missing or it isn't an object at all
 */
function normalizeAuthor(raw: unknown): SourceAuthor | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const author = raw as Record<string, unknown>;
  const username = asString(author.username)?.trim();
  if (!username) return undefined;
  const id = typeof author.id === 'number' && Number.isFinite(author.id) ? author.id : undefined;
  return id === undefined ? { username } : { username, id };
}

/**
 * The author table for each link (key = URL). If the whole thing is empty or nothing in
 * it is valid, drop it, so storage doesn't pile up meaningless fields like `{}`.
 *
 * @param raw the linkAuthors field from any source
 * @returns the filtered author table; undefined when nothing is left
 */
function normalizeLinkAuthors(raw: unknown): Record<string, SourceAuthor> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, SourceAuthor> = {};
  for (const [url, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!url.trim()) continue;
    const author = normalizeAuthor(value);
    if (author) out[url] = author;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * @param raw the meta field from any source
 * @returns only the fields we recognize; undefined when there are none
 */
function normalizeMeta(raw: unknown): EntryMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const meta = raw as Record<string, unknown>;
  const out: EntryMeta = {};
  if (typeof meta.beatmapsetId === 'number' && Number.isFinite(meta.beatmapsetId)) {
    out.beatmapsetId = meta.beatmapsetId;
  }
  if (typeof meta.beatmapId === 'number' && Number.isFinite(meta.beatmapId)) {
    out.beatmapId = meta.beatmapId;
  }
  const mode = asString(meta.mode);
  if (mode) out.mode = mode;
  // Earlier versions also stored meta.category (generalAll / timeline ...). It was just an
  // intermediate value for deriving scope, and it's already in the link URL, so we no
  // longer persist it; leftovers from old data get dropped at this layer.
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * @param raw any value
 * @param fallback used when no valid value can be read
 * @returns a positive timestamp; fallback when it isn't a number, isn't finite, or is <= 0
 */
function normalizeTimestamp(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Normalize a single entry. If one of scope / source / summary is missing, or has the
 * wrong type, the whole entry is dropped.
 *
 * @param raw the entry from any source
 * @param now the fallback for createdAt / updatedAt
 * @returns the normalized entry; null when it isn't valid
 */
export function normalizeEntry(raw: unknown, now: number = Date.now()): ChecklistEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;

  const scope = entry.scope;
  const source = entry.source;
  if (!isScope(scope) || !isSource(source)) return null;

  // summary must be present (an empty string is fine, but the field type has to be right)
  const summary = asString(entry.summary);
  if (summary === undefined) return null;

  const id = asString(entry.id)?.trim() || newId();
  const note = asString(entry.note);
  const sourceAuthor = normalizeAuthor(entry.sourceAuthor);
  const meta = normalizeMeta(entry.meta);
  const linkAuthors = normalizeLinkAuthors(entry.linkAuthors);

  return {
    id,
    scope,
    source,
    summary,
    links: normalizeLinks(entry.links),
    ...(linkAuthors ? { linkAuthors } : {}),
    ...(note !== undefined ? { note } : {}),
    ...(sourceAuthor ? { sourceAuthor } : {}),
    ...(meta ? { meta } : {}),
    createdAt: normalizeTimestamp(entry.createdAt, now),
    updatedAt: normalizeTimestamp(entry.updatedAt, now),
  };
}

/** The result of normalizing. */
export interface NormalizeResult {
  /** The normalized document. */
  doc: ChecklistDoc;
  /** The number of entries dropped because their structure was invalid. */
  dropped: number;
}

/**
 * Normalize content from any source (storage / imported JSON) into a valid doc: fill in
 * missing cells, drop invalid entries, count them. Structural errors -- not an object,
 * schemaVersion missing or too new -- are thrown straight away.
 *
 * @param raw the content from any source
 * @param now the fallback when a timestamp is missing
 * @returns the normalized document, plus the number of entries dropped
 * @throws {DocValidationError} the structure isn't valid, so it can't be normalized
 */
export function normalizeDocDetailed(raw: unknown, now: number = Date.now()): NormalizeResult {
  if (!raw || typeof raw !== 'object') {
    throw new DocValidationError('文档不是合法对象');
  }
  const doc = raw as Record<string, unknown>;

  const version = doc.schemaVersion;
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    throw new DocValidationError('缺少 schemaVersion');
  }
  if (version > SCHEMA_VERSION) {
    throw new DocValidationError(`schemaVersion ${version} 高于当前支持的 ${SCHEMA_VERSION}`);
  }

  const rawCells = doc.cells;
  if (!rawCells || typeof rawCells !== 'object') {
    throw new DocValidationError('缺少 cells');
  }
  const cellsIn = rawCells as Record<string, unknown>;

  const cells = emptyCells();
  let dropped = 0;
  for (const cell of CELL_IDS) {
    const list = cellsIn[cell];
    if (!Array.isArray(list)) continue;
    const entries: ChecklistEntry[] = [];
    for (const item of list) {
      const entry = normalizeEntry(item, now);
      if (entry) entries.push(entry);
      else dropped += 1;
    }
    cells[cell] = entries;
  }

  const deviceId = asString(doc.deviceId)?.trim() || newDeviceId();

  return {
    doc: {
      schemaVersion: SCHEMA_VERSION,
      updatedAt: normalizeTimestamp(doc.updatedAt, now),
      deviceId,
      cells,
    },
    dropped,
  };
}

/**
 * Same as `normalizeDocDetailed`, just without the dropped-entry count.
 *
 * @param raw the content from any source
 * @param now the fallback when a timestamp is missing
 * @returns the normalized document
 * @throws {DocValidationError} the structure isn't valid, so it can't be normalized
 */
export function normalizeDoc(raw: unknown, now: number = Date.now()): ChecklistDoc {
  return normalizeDocDetailed(raw, now).doc;
}

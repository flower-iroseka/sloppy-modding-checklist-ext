import { CELL_IDS } from './cells';
import { DocValidationError, normalizeDocDetailed } from './doc';
import { normalizeUrl } from './dedupe';
import type { CellId, ChecklistDoc, ChecklistEntry } from './types';

/**
 * @param doc the document to export
 * @param space indent width, 2 by default; pass 0 to get compact single-line JSON
 * @returns the JSON text
 */
export function serializeDoc(doc: ChecklistDoc, space: number = 2): string {
  return JSON.stringify(doc, null, space);
}

/** The result of parsing imported text. */
export interface ParseResult {
  /** The normalized document. */
  doc: ChecklistDoc;
  /** The number of entries dropped because their structure was invalid. */
  dropped: number;
}

/**
 * Parse and validate imported JSON text.
 *
 * @param text the content of the file the user picked
 * @returns the normalized document, plus the number of entries dropped
 * @throws {DocValidationError} the JSON has a syntax error, or the structure isn't valid
 */
export function parseDocJson(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new DocValidationError(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
  }
  return normalizeDocDetailed(raw);
}

/** Import mode: merge into the current document, or replace it entirely. */
export type ImportMode = 'merge' | 'overwrite';

/** The result of merging. */
export interface MergeResult {
  /** The merged document. */
  doc: ChecklistDoc;
  /** The number of entries added. */
  added: number;
  /** The number of entries skipped due to a duplicate id or link. */
  skipped: number;
}

/**
 * Merge two documents. base keeps its deviceId and its per-cell order. Entries from
 * incoming are appended to the end of the matching cell, unless their id was seen before
 * or one of their links overlaps an existing entry -- those are skipped.
 *
 * @param base the current document; its cell order and deviceId stay the same after merging
 * @param incoming the document being merged in
 * @returns the merged document and the added/skipped counts
 */
export function mergeDocs(base: ChecklistDoc, incoming: ChecklistDoc): MergeResult {
  const cells = { ...base.cells } as Record<CellId, ChecklistEntry[]>;

  // Duplicate check across everything (same as the §2.3 rule for adding an entry):
  // a hit on the id or on any link means skip.
  const seenIds = new Set<string>();
  const seenLinks = new Set<string>();
  for (const cell of CELL_IDS) {
    for (const entry of cells[cell] ?? []) {
      seenIds.add(entry.id);
      for (const link of entry.links) seenLinks.add(normalizeUrl(link));
    }
  }

  let added = 0;
  let skipped = 0;

  for (const cell of CELL_IDS) {
    const incomingList = incoming.cells[cell] ?? [];
    if (incomingList.length === 0) continue;

    const list = [...(cells[cell] ?? [])];
    for (const entry of incomingList) {
      const idSeen = seenIds.has(entry.id);
      const linkSeen = entry.links.some((link) => seenLinks.has(normalizeUrl(link)));
      if (idSeen || linkSeen) {
        skipped += 1;
        continue;
      }
      list.push(entry);
      seenIds.add(entry.id);
      for (const link of entry.links) seenLinks.add(normalizeUrl(link));
      added += 1;
    }
    cells[cell] = list;
  }

  return {
    doc: { ...base, updatedAt: Date.now(), cells },
    added,
    skipped,
  };
}

/**
 * Export file name: modding-checklist-YYYYMMDD.json (CODING_PLAN §9).
 *
 * @param now which day's date to use; tests can pass a fixed value
 * @returns the file name
 */
export function exportFileName(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `modding-checklist-${y}${m}${d}.json`;
}

/**
 * Trigger a download from an extension page.
 *
 * @param filename the file name shown while downloading
 * @param text the file content
 */
export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Release the object URL late, so the download has time to start
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Read the content of the file the user picked.
 *
 * @param file the file the user selected
 * @returns the file content, decoded as UTF-8
 */
export function readFileAsText(file: File): Promise<string> {
  return file.text();
}

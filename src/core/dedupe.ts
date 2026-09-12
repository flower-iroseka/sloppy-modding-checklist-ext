import { CELL_IDS } from './cells';
import type { CellId, ChecklistEntry } from './types';

/**
 * Link normalization: trim whitespace, drop trailing slashes, drop the hash on the
 * URL. Permalinks often carry an anchor, and if we don't cut it off the same post
 * ends up counted as two links.
 *
 * @param url the raw link
 * @returns the normalized form, for comparison only -- it isn't a URL you can open
 */
export function normalizeUrl(url: string): string {
  let out = url.trim();
  const hashIndex = out.indexOf('#');
  if (hashIndex >= 0) out = out.slice(0, hashIndex);
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * @param a one side's links
 * @param b the other side's links
 * @returns whether the two sides share a link once normalized; false if either side is empty
 */
export function linksOverlap(a: readonly string[], b: readonly string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const set = new Set(a.map(normalizeUrl));
  return b.some((link) => set.has(normalizeUrl(link)));
}

/**
 * Search all four cells for the first entry using this link (CODING_PLAN §2.3).
 *
 * @param cells the four cells
 * @param link the link to compare against
 * @returns the first entry that uses this link, or null when nothing matches or the link
 *   is empty
 */
export function findByLink(
  cells: Record<CellId, ChecklistEntry[]>,
  link: string,
): ChecklistEntry | null {
  const target = normalizeUrl(link);
  if (!target) return null;
  for (const cell of CELL_IDS) {
    for (const entry of cells[cell] ?? []) {
      if (entry.links.some((l) => normalizeUrl(l) === target)) return entry;
    }
  }
  return null;
}

/**
 * @param cells the four cells
 * @param links the links to check
 * @returns an existing entry that duplicates any of these links, or null when none do
 */
export function findDuplicate(
  cells: Record<CellId, ChecklistEntry[]>,
  links: readonly string[],
): ChecklistEntry | null {
  for (const link of links) {
    const hit = findByLink(cells, link);
    if (hit) return hit;
  }
  return null;
}

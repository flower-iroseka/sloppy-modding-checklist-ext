/**
 * Reading a beatmapset's difficulties out of osu's embedded JSON (CODING_PLAN §8.6).
 *
 * The discussion pages carry `<script id="json-beatmapset">` with a `beatmaps` array; each
 * row has `id`, `version` (the difficulty name), `difficulty_rating` (stars) and `mode`.
 * The content script reads that tag straight out of the DOM -- no fetch, no permission, no
 * OAuth. This module is the only place that knows the payload's shape.
 */

import { normalizeMode, type BeatmapMode } from './difficulty';
import { asArray, asId, asRecord } from './osuJson';

/** One difficulty of a beatmapset, as far as the embedded JSON tells us. */
export interface BeatmapInfo {
  /** Difficulty (beatmap) id. */
  id?: number;
  /** The difficulty name. osu's `version` field, free text, often not a tier word. */
  version?: string;
  /** Star rating. */
  stars?: number;
  /** Ruleset, normalized. */
  mode?: BeatmapMode;
}

/**
 * The `mode_int` values, for payloads that carry no `mode` string.
 *
 * The numbers are osu's ruleset ids and don't change; keeping them here beats another
 * dependency on the site's spelling.
 */
const MODE_BY_INT: Record<number, BeatmapMode> = {
  0: 'osu',
  1: 'taiko',
  2: 'catch',
  3: 'mania',
};

/**
 * Pull the difficulty list out of a parsed `json-beatmapset`.
 *
 * A row with neither an id nor a name says nothing about which difficulty it is, so it's
 * dropped. A row with a name but no star rating is kept: the name can still match the
 * naming table.
 *
 * @param root the parsed JSON
 * @returns the difficulties; an empty array when the payload has no usable list
 */
export function parseBeatmapsetBeatmaps(root: unknown): BeatmapInfo[] {
  const record = asRecord(root);
  if (!record) return [];

  const out: BeatmapInfo[] = [];
  for (const raw of asArray(record.beatmaps)) {
    const row = asRecord(raw);
    if (!row) continue;

    const id = asId(row.id);
    const version = typeof row.version === 'string' && row.version.trim() ? row.version : undefined;
    if (id === undefined && version === undefined) continue;

    const stars = asId(row.difficulty_rating);
    const mode =
      normalizeMode(typeof row.mode === 'string' ? row.mode : undefined) ??
      MODE_BY_INT[asId(row.mode_int) ?? -1];

    out.push({
      ...(id !== undefined ? { id } : {}),
      ...(version !== undefined ? { version } : {}),
      ...(stars !== undefined ? { stars } : {}),
      ...(mode ? { mode } : {}),
    });
  }
  return out;
}

/**
 * The DOM-free half of the reader: text in, difficulties out.
 *
 * Split out from the DOM lookup so it can be tested without a page, which matters because
 * the content script path has no other unit coverage.
 *
 * @param text the `textContent` of the json-beatmapset tag
 * @returns the difficulties; an empty array when the text is missing, empty, or not JSON
 */
export function beatmapsFromJsonText(text: string | undefined): BeatmapInfo[] {
  if (!text) return [];
  try {
    return parseBeatmapsetBeatmaps(JSON.parse(text));
  } catch {
    return [];
  }
}

/**
 * Pick the difficulty this entry is about.
 *
 * By id when we have one -- a permalink like `/discussion/1234567/…` carries it, which is
 * the common modding case. Without an id, only a beatmapset with exactly one difficulty
 * answers the question on its own. Everything else gives up: picking one of nine
 * difficulties is making it up, and an id that isn't in the list means the set changed
 * under us, so that gives up too rather than falling back to a neighbour.
 *
 * @param list the beatmapset's difficulties
 * @param beatmapId the difficulty id from the permalink, when there is one
 * @returns that difficulty; undefined when it can't be pinned down
 */
export function pickBeatmap(
  list: readonly BeatmapInfo[],
  beatmapId?: number,
): BeatmapInfo | undefined {
  if (beatmapId !== undefined) return list.find((b) => b.id === beatmapId);
  return list.length === 1 ? list[0] : undefined;
}

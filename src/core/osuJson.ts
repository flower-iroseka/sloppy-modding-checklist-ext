/**
 * Reading the JSON blocks the osu! pages embed.
 *
 * osu ships page data as `<script id="json-…">` tags (`json-beatmapset`,
 * `json-current-user`, …). Two features read them -- author lookup (`osuAuthor.ts`) and
 * beatmap metadata (`beatmap.ts`) -- so the "get the tag, parse it, guard the shape" part
 * lives here instead of being copied.
 *
 * Measured 2026-09. An osu redesign that renames these tags breaks one regex, not three.
 */

/**
 * Escape a string so it can be dropped into a RegExp as a literal.
 *
 * @param text the literal text
 * @returns the same text with regex metacharacters escaped
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Grab the JSON out of `<script id="…">`.
 *
 * The id is a parameter rather than baked in because a page carries several of these tags;
 * `extractJsonScript(html, 'json-beatmapset')` is the one both callers use today.
 *
 * @param html the page's raw HTML
 * @param id the value of the script tag's id attribute
 * @returns the parsed JSON; undefined when the tag is missing or holds invalid JSON
 */
export function extractJsonScript(html: string, id: string): unknown {
  const pattern = new RegExp(
    `<script[^>]*\\bid="${escapeRegExp(id)}"[^>]*>([\\s\\S]*?)</script>`,
  );
  const m = pattern.exec(html);
  if (!m) return undefined;
  try {
    return JSON.parse(m[1]!);
  } catch {
    return undefined;
  }
}

/**
 * Anything that isn't an object counts as absent, so callers don't have to type-check.
 *
 * @param value a value parsed out of JSON
 * @returns the value as a record; undefined when it isn't an object
 */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/**
 * Only finite numbers count; strings, NaN and Infinity all mean "no such field".
 *
 * @param value a value parsed out of JSON
 * @returns the number; undefined when it isn't a finite number
 */
export function asId(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Anything that isn't an array counts as an empty one, so callers don't need a fallback.
 *
 * @param value a value parsed out of JSON
 * @returns the array; an empty one when it isn't an array
 */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

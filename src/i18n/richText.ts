/**
 * Inline markers in the catalog: `**bold**` (CODING_PLAN §14).
 *
 * Markers instead of `<strong>` in the value: splitting a sentence into several keys around
 * tags would leave the translator counting whether they balance. `renderKey` / `renderMsg` /
 * `t` strip every `**` by default (announcements and the injected content-script text go
 * through them and cannot show bold anyway); real bold goes through `renderKeyMarkup` /
 * `renderMsgMarkup` + `<RichText>`. Keep that order -- a key that forgets `<RichText>` only
 * loses the bold, while the other way `**Submit**` reaches the user and nobody notices.
 */

/** One split segment of text. The renderer uses `bold` to decide whether to wrap it in `<strong>`. */
export interface RichTextSegment {
  /** The text of this segment, with `**` already removed. */
  text: string;
  /** Whether this segment was inside `**…**` and should be wrapped in `<strong>` when rendered. */
  bold: boolean;
}

/** A bold segment: `**` + at least one non-`*` character + `**`. */
const MARKER = /\*\*([^*]+)\*\*/g;

/**
 * Strip every `**` marker, keeping only the text.
 *
 * No balance check, every `**` goes. When a marker is half missing (the translator broke it,
 * or there was a stray `**` to begin with), deleting beats keeping: the user sees "Submit",
 * not "**Submit". A lone `*` is left alone (it is not one of our markers).
 *
 * @param text the raw text taken from the catalog
 * @returns the text with markers removed
 */
export function stripBold(text: string): string {
  return text.replace(/\*\*/g, '');
}

/**
 * Split on `**` into segments and let the renderer decide about bold.
 *
 * @param text the raw text taken from the catalog
 * @returns the split segments; with no markers it is a single `bold: false` segment
 *   (`<RichText>` takes this fast path and builds no array of sibling nodes), and an empty
 *   string returns an empty array
 */
export function splitBold(text: string): RichTextSegment[] {
  if (text === '') return [];

  const out: RichTextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(MARKER)) {
    // `matchAll` always has an index; the `?? 0` is only for the type checker.
    const start = match.index ?? 0;
    if (start > last) out.push({ text: stripBold(text.slice(last, start)), bold: false });
    out.push({ text: match[1], bold: true });
    last = start + match[0].length;
  }
  if (last < text.length) out.push({ text: stripBold(text.slice(last)), bold: false });
  return out;
}

import { splitBold } from '../i18n';

/**
 * Render the `**bold**` markers from the catalog as real `<strong>` (CODING_PLAN §14).
 *
 * `<strong>` rather than `<b>` or a style class because it's semantic emphasis: screen
 * readers read it with a different intonation instead of it just looking thicker.
 *
 * `text` must come from a markup-rendering path (`tmMarkup` / `renderMsgMarkup`). Through the
 * default `t` / `tm` the markers are already stripped, so this renders with no bold (see
 * `i18n/richText.ts`).
 *
 * @param text text already rendered to markup
 */
export function RichText({ text }: { text: string }) {
  const parts = splitBold(text);
  if (parts.length === 0) return null;
  // Fast path when there are no markers: no array of sibling nodes, no extra wrapping element.
  if (parts.length === 1 && !parts[0].bold) return <>{parts[0].text}</>;

  return (
    <>
      {parts.map((part, i) =>
        part.bold ? (
          // The parts don't get reordered during render (the key is the index), so using index as key is safe
          <strong key={i}>{part.text}</strong>
        ) : (
          part.text
        ),
      )}
    </>
  );
}

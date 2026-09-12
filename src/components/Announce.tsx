/**
 * Announce region (CODING_PLAN §5.3): speaks the persistent notices that skip the toast --
 * import results, sync errors, conflicts sit on the page and may go unread for ten seconds,
 * and color alone doesn't reach a screen reader.
 *
 * Renders nothing visible and doesn't wrap the caller's copy (an extra box in a `flex; gap`
 * parent would eat a gap). Must stay mounted: a live region has to exist before its text does.
 * Known limit: the same text twice in a row isn't announced twice.
 */
export function Announce({
  kind,
  text,
}: {
  /** `polite` for results and notices; `assertive` for failures -- the latter interrupts what the screen reader is reading. */
  kind: 'polite' | 'assertive';
  /** The text to announce. An empty string means "nothing to say": the region stays but stays silent. */
  text: string;
}) {
  return (
    <div
      className="visually-hidden"
      // An anchor for automation (same approach as the two in toast, `data-mc-injected` and
      // `window.__mc`): the smoke test needs to hit this region directly rather than bumping
      // into other hidden text via `.visually-hidden`.
      data-announce={kind}
      role={kind === 'assertive' ? 'alert' : 'status'}
      aria-live={kind}
    >
      {text}
    </div>
  );
}

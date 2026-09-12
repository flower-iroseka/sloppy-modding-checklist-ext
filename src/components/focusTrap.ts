/**
 * Focus cycling for the modal (CODING_PLAN §5.3).
 *
 * A pure function so it can be unit tested: the tricky parts are the edges (one focusable
 * element in the panel, focus already outside it, Shift+Tab wrapping from the first back to
 * the last), and checking those by driving Tab through CDP is brittle (Tab order depends on
 * the browser window state, see §12.2).
 *
 * @param focusables the currently focusable elements in the panel, in Tab order
 * @param active what the focus is on right now
 * @param shift whether this is a Shift+Tab
 * @returns whether to take over this Tab: given an element, `preventDefault()` and focus it;
 *   given `undefined`, let it through and leave the browser to its own default order
 */
export function trapTarget(
  focusables: readonly HTMLElement[],
  active: Element | null,
  shift: boolean,
): HTMLElement | undefined {
  const n = focusables.length;
  // No focusable elements at all: nowhere to go, and forcing a block would just make the keyboard useless
  if (n === 0) return undefined;

  const i = active ? focusables.indexOf(active as HTMLElement) : -1;

  // Focus is no longer inside the panel (clicked elsewhere, or just moved by a script) -> pull it back to this end
  if (i === -1) return shift ? focusables[n - 1] : focusables[0];

  // Only wrap at the edges. The positions in between have to be let through -- the browser's
  // own Tab order also has to account for tabindex outside the panel and the shadow DOM
  // boundary, and pretending we know better only causes trouble.
  if (shift && i === 0) return focusables[n - 1];
  if (!shift && i === n - 1) return focusables[0];

  return undefined;
}

/**
 * The elements in the panel that can really be focused right now, in Tab order.
 *
 * `querySelectorAll` returns document order, and in a normal DOM document order equals Tab
 * order -- the only case where they differ is positive `tabindex`, which this repo's modals
 * don't have (`tabindex` is only used to exclude containers).
 *
 * @param root the panel's container; an empty array when null is passed (not mounted yet)
 * @returns the focusable elements
 */
export function focusablesIn(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  const SEL = 'input, textarea, select, button, [href], [tabindex]:not([tabindex="-1"])';
  return Array.from(root.querySelectorAll<HTMLElement>(SEL)).filter(
    // A `disabled` element can't receive focus, and counting it would make "the last one"
    // point at something that does nothing when pressed; same for tabIndex < 0 (explicitly
    // excluded from the Tab sequence).
    (el) => !el.hasAttribute('disabled') && el.tabIndex >= 0,
  );
}

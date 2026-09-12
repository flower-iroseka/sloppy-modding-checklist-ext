/**
 * DOM selectors for the osu! beatmap discussion page (CODING_PLAN §8.1).
 *
 * Checked against the real site: 2026-09, osu-web lazer layout. An osu redesign breaks these
 * selectors, so every use site goes through the fail-safe (see the sweep in index.tsx); after a
 * redesign only this one file needs changing.
 */
export const SELECTORS = {
  /** One discussion (the top-level container, the lookup root for author info). */
  discussion: '.beatmap-discussion',
  /** The body block, carrying data-post-id; a reply is a post too. */
  post: '.beatmap-discussion-post[data-post-id]',
  /** The actions area inside a post, the permalink lives at this level. */
  postActions: '.beatmap-discussion-post__actions',
  /** The button row inside the actions area; our "＋" button goes here. */
  postActionsGroup: '.beatmap-discussion-post__actions-group',
  /** Author link (carries data-user-id; the same author has two `a`s, take the one with visible text). */
  userLink: 'a.beatmap-discussion-user-card__user-link[data-user-id]',
  /** Permalink (click-to-copy is osu's "copy to clipboard" link). */
  permalink: 'a.click-to-copy[href*="/discussion/"]',
  /** The current beatmap's mode (osu / taiko / fruit / mania). */
  activeGameMode: '.game-mode-link--active[data-mode]',
  /** The current page category (generalAll / general / timeline / reviews …). */
  activePageMode: '.page-mode-link--is-active[data-mode]',
  /** Marker attribute for the elements we inject ourselves; the sweep currently keys off `.mc-add-btn` instead. */
  injectedAttr: 'data-mc-injected',
} as const;

/**
 * Safely query multiple elements.
 *
 * @param root the element to search down from
 * @param selector CSS selector
 * @returns the matched elements; an empty array instead of a throw when the selector breaks (site redesign)
 */
export function safeQueryAll(root: ParentNode, selector: string): Element[] {
  try {
    return [...root.querySelectorAll(selector)];
  } catch {
    return [];
  }
}

/**
 * Safely query a single element.
 *
 * @param root the element to search down from
 * @param selector CSS selector
 * @returns the first matched element; null when the selector breaks or nothing matches
 */
export function safeQuery(root: ParentNode, selector: string): Element | null {
  try {
    return root.querySelector(selector);
  } catch {
    return null;
  }
}

/**
 * Read the mode value off some `[data-mode]` element.
 *
 * @param root the element to search down from
 * @param selector points at an element carrying data-mode
 * @returns the mode string; undefined when it can't be read, is an empty string, or is just `-`
 *   (osu's way of saying "none")
 */
function dataMode(root: ParentNode, selector: string): string | undefined {
  const el = safeQuery(root, selector);
  const mode = el?.getAttribute('data-mode')?.trim();
  return mode && mode !== '-' ? mode : undefined;
}

/**
 * The current beatmap's mode.
 *
 * @returns the mode name; undefined when it can't be read
 */
export function readActiveGameMode(): string | undefined {
  return dataMode(document, SELECTORS.activeGameMode);
}

/**
 * Get the page category from the URL path (pure function, testable on its own):
 *   /beatmapsets/<set>/discussion/<beatmapId|->/<mode>[/…]
 *
 * @param pathname `location.pathname`
 * @returns that mode segment of the path; measured values (2026-09) are `reviews` / `generalAll` /
 *   `general` / `timeline` / `events`
 */
export function parsePageMode(pathname: string): string | undefined {
  const m = /\/discussion\/[^/]+\/([A-Za-z][\w-]*)/.exec(pathname);
  return m?.[1];
}

/**
 * The current page category.
 *
 * DOM first (that's the page actually rendering in front of the user), URL as the fallback -- so
 * that if an osu redesign replaces `.page-mode-link--is-active`, it doesn't silently degrade to
 * "can't read it".
 *
 * @returns the page category; undefined when neither side can read it
 */
export function readActivePageCategory(): string | undefined {
  return dataMode(document, SELECTORS.activePageMode) ?? parsePageMode(location.pathname);
}

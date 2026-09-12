import type { EntryMeta, Scope, Source, SourceAuthor } from '../core/types';
import {
  SELECTORS,
  readActiveGameMode,
  readActivePageCategory,
  safeQuery,
} from './locators';

/**
 * Reading info off the osu site (CODING_PLAN §8).
 *
 * parseXxx / recommendXxx are pure functions that don't touch the DOM and are testable on their
 * own; only the readXxx family touches the DOM.
 */

/** Basic info about an osu user. */
export interface OsuUser {
  /** osu user id, from the author link's `data-user-id`. */
  id: number;
  /** osu username, from the author link's visible text. */
  username: string;
}

/** The beatmap location a discussion points at. */
export interface DiscussionLocation {
  /** Beatmapset id, taken from the permalink. */
  beatmapsetId?: number;
  /** The beatmapId in /beatmapsets/<set>/discussion/<beatmapId|->/… */
  beatmapId?: number;
}

/**
 * Pull the beatmapset id out of any osu URL.
 *
 * @param href a link on the page
 * @returns the beatmapset id; undefined when the link doesn't have one
 */
export function parseBeatmapsetId(href: string): number | undefined {
  const m = /\/beatmapsets\/(\d+)/.exec(href);
  return m ? Number(m[1]) : undefined;
}

/**
 * Pull the difficulty (beatmap) id out of a discussion URL.
 *
 * @param href a link on the page
 * @returns the difficulty id; undefined for non-numeric ones like generalAll
 */
export function parseBeatmapId(href: string): number | undefined {
  const m = /\/discussion\/(\d+)/.exec(href);
  return m ? Number(m[1]) : undefined;
}

/**
 * Source recommendation (CODING_PLAN §8.3): post author == current logged-in user -> internal,
 * otherwise external. Logged out or either id missing -> external (the user can change it in the
 * dialog if they want).
 *
 * @param authorId the post author's id
 * @param currentUserId the current logged-in user's id
 * @returns the recommended source
 */
export function recommendSource(
  authorId: number | undefined,
  currentUserId: number | undefined,
): Source {
  if (authorId === undefined || currentUserId === undefined) return 'external';
  return authorId === currentUserId ? 'internal' : 'external';
}

/**
 * The "page category -> scope recommendation" lookup (CODING_PLAN §8.3): judged by where this mod
 * sits on the discussion page -- the two General pages are whole-map issues (general), Timeline is
 * about a specific object (individual).
 *
 * The reviews / events pages have no clear whole-map/specific meaning, so they aren't in the table
 * and `recommendScope` falls back for them.
 */
const SCOPE_BY_PAGE_MODE: Record<string, Scope> = {
  generalAll: 'general',
  general: 'general',
  timeline: 'individual',
};

/**
 * Scope recommendation.
 *
 * @param category the current page category, see `readActivePageCategory`
 * @returns the recommended scope; any category not in the table falls back to general (same as the
 *   dialog default)
 */
export function recommendScope(category: string | undefined): Scope {
  return (category && SCOPE_BY_PAGE_MODE[category]) || 'general';
}

/** A post that can be added to the checklist, plus its context. */
export interface PostTarget {
  /** Post permalink (osu's click-to-copy) */
  permalink: string;
  /** Post author; left out when the page shows neither a username nor an id. */
  author?: SourceAuthor;
  /** Context for jumping back to the original discussion -- whatever can be collected, write it */
  meta: EntryMeta;
  /** Source recommendation already decided from the author */
  recommendedSource: Source;
  /** Scope recommendation already decided from the discussion page's position */
  recommendedScope: Scope;
  /** The body as plain text (prefilled as the summary, keeping as much of the content as possible) */
  text: string;
}

/**
 * Read the author from the author card (the same author has two links, take the one with visible text).
 *
 * @param scope where to look for the author link, pass a post or discussion element
 * @returns the author; undefined when there's neither a username nor an id
 */
export function readPostAuthor(scope: Element): SourceAuthor | undefined {
  const links = [...scope.querySelectorAll(SELECTORS.userLink)];
  const preferred = links.find((a) => (a.textContent ?? '').trim().length > 0) ?? links[0];
  if (!preferred) return undefined;

  const idAttr = preferred.getAttribute('data-user-id');
  const id = idAttr ? Number(idAttr) : undefined;
  const username = (preferred.textContent ?? '').trim();

  if (!username && id === undefined) return undefined;
  return {
    username: username || `user-${id}`,
    ...(id !== undefined && Number.isFinite(id) ? { id } : {}),
  };
}

/**
 * The post body as plain text.
 *
 * @param post the body block
 * @returns the body as plain text, used to prefill the summary; falls back to the whole element's
 *   text when the body container isn't found
 */
export function readPostText(post: Element): string {
  const body = safeQuery(post, '.osu-md') ?? post;
  return (body.textContent ?? '').replace(/\s+\n/g, '\n').trim();
}

/**
 * Assemble everything collected for one post.
 *
 * @param discussion the discussion this post belongs to, used as a fallback when the post itself
 *   has no readable author
 * @param post the body block
 * @param currentUserId the current logged-in user id, fetched from the SW by the caller (content
 *   scripts can't read window.currentUser in the isolated world); pass undefined when it isn't
 *   available and the recommended source falls back to external
 * @returns the collected result; null when there isn't even a permalink, and the caller hides the
 *   button based on that
 */
export function readPostTarget(
  discussion: Element,
  post: Element,
  currentUserId?: number,
): PostTarget | null {
  const permalinkEl = safeQuery(post, SELECTORS.permalink);
  const permalink = permalinkEl?.getAttribute('href') ?? '';
  if (!permalink) return null;

  // Check this post's own author card first; in a thread one discussion can hold replies from different authors
  const author = readPostAuthor(post) ?? readPostAuthor(discussion);
  const beatmapsetId = parseBeatmapsetId(permalink);
  const beatmapId = parseBeatmapId(permalink);
  const mode = readActiveGameMode();
  // category is only used to derive the scope, it doesn't go into meta: it's just that segment of
  // the link path (…/discussion/-/generalAll), storing it would be pure duplication.
  const category = readActivePageCategory();

  const meta: EntryMeta = {
    ...(beatmapsetId !== undefined ? { beatmapsetId } : {}),
    ...(beatmapId !== undefined ? { beatmapId } : {}),
    ...(mode ? { mode } : {}),
  };

  return {
    permalink,
    ...(author ? { author } : {}),
    meta,
    recommendedSource: recommendSource(author?.id, currentUserId),
    recommendedScope: recommendScope(category),
    text: readPostText(post),
  };
}

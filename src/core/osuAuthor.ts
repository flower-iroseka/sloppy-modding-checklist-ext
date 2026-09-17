/**
 * Look up the post author from an osu link (CODING_PLAN §8.4).
 *
 * The checklist page only has a URL, so we fetch the linked page again. Discussion pages
 * keep the author in embedded `json-beatmapset` JSON; forum post pages have to be scraped
 * from the DOM, so each kind gets its own parser. Measured 2026-09: the discussion DOM is
 * empty because React renders it client-side, so that JSON is the only real source. One
 * fetch resolves `postId → user_id → username`, and needs no OAuth.
 */

import { asArray, asId, asRecord, extractJsonScript } from './osuJson';
import type { SourceAuthor } from './types';

const OSU_HOSTNAMES = new Set(['osu.ppy.sh', 'www.osu.ppy.sh']);

/**
 * Is this hostname on the osu site?
 *
 * Pulled out on its own so we stop writing `hostname !== 'osu.ppy.sh'` everywhere: if the
 * site ever switches to `www.` or hangs a subdomain off it, every parser would silently
 * break at once -- and that failure mode is quiet enough that nobody would notice.
 *
 * @param hostname the domain to check, case-insensitive
 * @returns true when it's on the site
 */
export function isOsuHost(hostname: string): boolean {
  return OSU_HOSTNAMES.has(hostname.toLowerCase());
}

/** What you can pin down from an osu discussion link. */
export interface OsuDiscussionLink {
  /** Beatmapset id; present in every discussion link. */
  beatmapsetId: number;
  /** Difficulty id; undefined on `/discussion/-/…` (whole-set pages like generalAll, reviews) */
  beatmapId?: number;
  /** `#/<id>`: the hash points at a discussion, or at one post under it */
  postId?: number;
}

/**
 * Parse an osu discussion permalink.
 *
 * Looks like `<origin>/beatmapsets/<set>/discussion/<beatmapId|->/<category>[/…][#/<postId>]`.
 * The hash isn't sent to the server, but it's the only clue to which post the user actually
 * means, so it has to be kept.
 *
 * @param raw the link text as the user entered it
 * @returns the parsed ids; undefined when the link isn't an osu discussion page
 */
export function parseOsuDiscussionLink(raw: string): OsuDiscussionLink | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (!isOsuHost(url.hostname)) return undefined;

  const m = /^\/beatmapsets\/(\d+)\/discussion\/([^/]+)(?:\/|$)/.exec(url.pathname);
  if (!m) return undefined;

  const beatmapsetId = Number(m[1]);
  if (!Number.isFinite(beatmapsetId)) return undefined;

  const beatmapRaw = m[2]!;
  const beatmapId = beatmapRaw === '-' ? undefined : Number(beatmapRaw);

  const hash = /^#\/(\d+)/.exec(url.hash);
  const postId = hash ? Number(hash[1]) : undefined;

  return {
    beatmapsetId,
    ...(beatmapId !== undefined && Number.isFinite(beatmapId) ? { beatmapId } : {}),
    ...(postId !== undefined && Number.isFinite(postId) ? { postId } : {}),
  };
}

/** The "who posted this" part of `json-beatmapset`, after it's pulled out of the HTML. */
export interface BeatmapsetPayload {
  /** discussion id → author user id */
  discussionAuthors: Map<number, number>;
  /** post id → author user id */
  postAuthors: Map<number, number>;
  /** user id → username */
  usernames: Map<number, string>;
}

/**
 * Pull the "post ↔ author" maps out of a discussion page's HTML.
 *
 * @param html the raw HTML of the discussion page
 * @returns the three maps; undefined when what we got isn't a discussion page, or when the
 *          site changes its embedded structure -- in that case the caller should give up
 *          quietly instead of throwing
 */
export function parseBeatmapsetPayload(html: string): BeatmapsetPayload | undefined {
  const root = asRecord(extractJsonScript(html, 'json-beatmapset'));
  if (!root) return undefined;

  const usernames = new Map<number, string>();
  for (const raw of asArray(root.related_users)) {
    const user = asRecord(raw);
    const id = asId(user?.id);
    const username = typeof user?.username === 'string' ? user.username : undefined;
    if (id !== undefined && username) usernames.set(id, username);
  }

  const discussionAuthors = new Map<number, number>();
  const postAuthors = new Map<number, number>();
  for (const raw of asArray(root.discussions)) {
    const discussion = asRecord(raw);
    if (!discussion) continue;
    const discussionId = asId(discussion.id);
    const discussionUserId = asId(discussion.user_id);
    if (discussionId !== undefined && discussionUserId !== undefined) {
      discussionAuthors.set(discussionId, discussionUserId);
    }
    for (const rawPost of asArray(discussion.posts)) {
      const post = asRecord(rawPost);
      const postId = asId(post?.id);
      const postUserId = asId(post?.user_id);
      if (postId !== undefined && postUserId !== undefined) postAuthors.set(postId, postUserId);
    }
  }

  return { discussionAuthors, postAuthors, usernames };
}

/**
 * Look up the author of this post.
 *
 * The id in `#/<id>` can be either a discussion or one post under it (the site uses both
 * kinds of permalink), so we check both maps.
 *
 * @param payload the result of parseBeatmapsetPayload
 * @param postId the id from `#/<id>`
 * @returns the author; undefined when there's no user id, or when there's an id but no
 *          matching username
 */
export function authorForPost(
  payload: BeatmapsetPayload,
  postId: number,
): SourceAuthor | undefined {
  const userId = payload.discussionAuthors.get(postId) ?? payload.postAuthors.get(postId);
  if (userId === undefined) return undefined;
  const username = payload.usernames.get(userId);
  if (!username) return undefined;
  return { username, id: userId };
}

/** An osu forum link that points at exactly one post. */
export interface OsuForumPostLink {
  /** Post id, taken from the permalink or from `?start=`. */
  postId: number;
}

/**
 * Parse an osu forum link. Returns undefined when it can't be pinned to one specific post.
 *
 * Two shapes can pin it down: `/community/forums/posts/<postId>` (a post permalink) and
 * `/community/forums/topics/<topicId>?start=<postId>` (a topic link that jumps to a post).
 * Measured, `start` really is the post id; even if the site ever changes it to a page
 * offset, the only consequence is that we can't find the author.
 *
 * Only `/community/forums/topics/<id>` (without `start`) returns nothing -- a topic holds
 * dozens of posts, so picking one at random as "the author" would be making it up. Same
 * rule as a discussion link without `#/<id>`.
 *
 * @param raw the link text as the user entered it
 * @returns the post id; undefined when it's not on the osu site, or can't be pinned to a
 *          specific post
 */
export function parseOsuForumPostLink(raw: string): OsuForumPostLink | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (!isOsuHost(url.hostname)) return undefined;

  const post = /^\/community\/forums\/posts\/(\d+)\/?$/.exec(url.pathname);
  if (post) {
    const postId = Number(post[1]);
    return Number.isFinite(postId) ? { postId } : undefined;
  }

  const topic = /^\/community\/forums\/topics\/(\d+)\/?$/.exec(url.pathname);
  const start = topic ? Number(url.searchParams.get('start')) : NaN;
  if (Number.isFinite(start) && start > 0) return { postId: start };

  return undefined;
}

/** The few entities that can show up in a username; `decodeEntities` only knows these. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
  nbsp: ' ',
};

/**
 * Usernames in attributes / text can carry entities (`&amp;` and friends), so decode them.
 *
 * @param text the text as scraped
 * @returns the decoded text; entities we don't recognize are left as they are
 */
function decodeEntities(text: string): string {
  return text.replace(/&(#39|amp|lt|gt|quot|apos|nbsp);/g, (whole, name: string) => ENTITIES[name] ?? whole);
}

/**
 * Strip tags with a naive regex. Good enough for the username text we scrape, which never
 * carries nested markup.
 *
 * @param html a fragment of the page
 * @returns the fragment with tags removed
 */
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Pull "post id → author" out of a forum topic page's HTML.
 *
 * A forum page is not a discussion page: there the whole payload sits in embedded JSON,
 * while here we get a server-rendered DOM whose only JSON blobs are `json-current-user` /
 * `json-route-section`, with no post data in them -- so the DOM is all there is to scrape.
 * We cut the page into blocks at container tags carrying `data-post-id`, take the username
 * from `data-post-username`, and the user id from `data-user-id` on `forum-post__user`.
 *
 * If neither is available we skip that post (a deleted post has no author to speak of) --
 * better to give one fewer than to give a wrong one.
 *
 * @param html the raw HTML of the forum post page
 * @returns post id → author; an empty Map when nothing was scraped
 */
export function parseForumPostAuthors(html: string): Map<number, SourceAuthor> {
  const out = new Map<number, SourceAuthor>();
  const tagRe = /<div[^>]*\bclass="js-forum-post[^"]*"[^>]*>/g;
  const tags = [...html.matchAll(tagRe)];

  for (let i = 0; i < tags.length; i++) {
    const tag = tags[i]![0];
    const tagAt = tags[i]!.index!;
    const postId = asId(Number(/data-post-id="(\d+)"/.exec(tag)?.[1]));
    if (postId === undefined) continue;

    const blockEnd = i + 1 < tags.length ? tags[i + 1]!.index! : html.length;
    const block = html.slice(tagAt + tag.length, blockEnd);

    const userEl = /forum-post__user[^>]*data-user-id=["'](\d+)["'][^>]*>([\s\S]*?)<\/a>/.exec(block);
    const username =
      decodeEntities(/data-post-username="([^"]*)"/.exec(tag)?.[1] ?? '').trim() ||
      decodeEntities(stripTags(userEl?.[2] ?? '')).trim();
    if (!username) continue;

    const id = asId(Number(userEl?.[1]));
    out.set(postId, id === undefined ? { username } : { username, id });
  }

  return out;
}

/**
 * Strip the hash: it isn't sent to the server, but the page path has to stay as it is.
 *
 * At first we took the lazy route and always fetched `…/discussion/-/generalAll`
 * ("General (All difficulties)"). That was wrong: a mod on the timeline (the timeline for a
 * specific difficulty) belongs to a different board, and generalAll's `discussions` doesn't
 * contain it at all -- looking one up with an individual permalink reliably finds no author.
 *
 * @param raw the link text as the user entered it
 * @returns the full URL with the hash stripped; undefined when it can't be parsed
 */
function toPageUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * The uniform way to say "this link points at one post" -- along with which parser to use
 * and which page to fetch. Callers (the popover's input on blur) only need to ask whether
 * there is one, not to work out which kind of link it is. `pageUrl` is the page to fetch,
 * with the hash stripped: the hash never reaches the server, but the path has to stay as the
 * user's link had it.
 */
export type AuthorLink =
  | { kind: 'discussion'; postId: number; pageUrl: string }
  | { kind: 'forum'; postId: number; pageUrl: string };

/**
 * Can this link resolve to an author? If so, which page should we fetch?
 *
 * @param raw the link text as the user entered it
 * @returns the parser + the page to fetch; undefined when there's structurally no author
 *          to speak of -- off-site links, user profiles, beatmap pages, and discussion /
 *          topic links without a post number
 */
export function parseAuthorLink(raw: string): AuthorLink | undefined {
  const pageUrl = toPageUrl(raw);
  if (!pageUrl) return undefined;

  const discussion = parseOsuDiscussionLink(raw);
  if (discussion?.postId !== undefined) {
    return { kind: 'discussion', postId: discussion.postId, pageUrl };
  }

  const forum = parseOsuForumPostLink(raw);
  if (forum) return { kind: 'forum', postId: forum.postId, pageUrl };

  return undefined;
}

/**
 * Links that already resolved to an author don't get fetched again (blurring the input
 * fires a lookup every time, and it's easy to trigger repeatedly).
 * Only successful results go in here -- see the note at the end of resolveLinkAuthor.
 */
const cache = new Map<string, SourceAuthor>();

/** Tests only: clear the in-process resolution cache. */
export function clearAuthorCache(): void {
  cache.clear();
}

/** Default timeout (ms) when timeoutMs isn't passed. */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ResolveAuthorOptions {
  /** Defaults to 10s. A timeout is treated the same as "no author resolved". */
  timeoutMs?: number;
}

/**
 * Go to osu and fetch the author for this link.
 *
 * Any failure returns undefined and never throws -- the caller sits on the input's blur
 * handler and has no business interrupting someone filling out a form over a network
 * problem. Failing to get an author just means nothing is shown: not an osu link, on osu
 * but not pinned to a specific post, the response isn't HTML, network failure or timeout --
 * all of those land in this same bucket.
 *
 * @param raw the link text as the user entered it
 * @param options.timeoutMs timeout, 10 seconds by default; a timeout is treated the same as
 *        "no author resolved"
 * @returns the author; undefined when it can't be resolved
 */
export async function resolveLinkAuthor(
  raw: string,
  options: ResolveAuthorOptions = {},
): Promise<SourceAuthor | undefined> {
  // Not pinned to a specific post means there's nothing to resolve: a discussion / a topic
  // can hold dozens of posts, and picking one at random as "the author" is making it up,
  // which is worse than leaving it blank.
  const link = parseAuthorLink(raw);
  if (!link) return undefined;
  if (cache.has(link.pageUrl)) return cache.get(link.pageUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let author: SourceAuthor | undefined;
  try {
    const res = await fetch(link.pageUrl, { credentials: 'include', signal: controller.signal });
    if (res.ok && (res.headers.get('content-type') ?? '').includes('html')) {
      const html = await res.text();
      if (link.kind === 'discussion') {
        const payload = parseBeatmapsetPayload(html);
        if (payload) author = authorForPost(payload, link.postId);
      } else {
        author = parseForumPostAuthors(html).get(link.postId);
      }
    }
  } catch {
    // Silent: see the contract above
  } finally {
    clearTimeout(timer);
  }

  // Only cache the successful run.
  //
  // If failures were cached too, one momentary hiccup (a dropped connection, a timeout)
  // would make this link show "Author not recognised" for the whole browser session:
  // blurring again wouldn't retry, and the user would have to reload the page.
  // And a failure is exactly the one outcome worth retrying -- once a post's author
  // resolves, it never changes.
  if (author) cache.set(link.pageUrl, author);
  return author;
}

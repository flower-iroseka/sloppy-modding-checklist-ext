/**
 * The fallback label on a link button (CODING_PLAN §5.2), used when the link's author
 * annotation can't be resolved.
 *
 * It's a module of its own so it can be tested in a plain node environment; it used to
 * live in `Card.tsx`, where testing it meant spinning up React too.
 */

import { isOsuHost, parseOsuDiscussionLink, parseOsuForumPostLink } from './osuAuthor';

/**
 * When the path ends on one of these words it's a routing verb rather than an identifier,
 * so showing it says nothing.
 *
 * We didn't filter these at first: `youtube.com/watch?v=…` rendered as a bare `watch` and
 * `docs.google.com/document/d/abc/edit` as `edit`, which gave no clue what the link was.
 */
const ROUTING_SEGMENTS = new Set([
  'watch',
  'edit',
  'view',
  'index',
  'index.html',
  'default',
  'home',
  'browse',
  'search',
  'results',
  'page',
  'pages',
  'post',
  'posts',
  'topic',
  'topics',
  'thread',
  'threads',
  'document',
  'documents',
  'file',
  'files',
  'issues',
  'pulls',
  'tree',
  'blob',
  'commit',
  'about',
  'help',
  'terms',
  'privacy',
  'settings',
  'login',
  'signup',
  'dashboard',
  'feed',
  'explore',
  'detail',
  'details',
]);

/** A long tail wrecks the card layout, and these are mostly slugs that still read fine truncated. */
const MAX_TAIL = 24;

/**
 * Give a plain-language label for on-site osu links, based on the shapes we know.
 *
 * @param url the parsed URL
 * @param raw the raw link; the parsers want this rather than the URL
 * @returns the label, or undefined when the link isn't on the osu site or has a shape we
 *   don't know
 */
function osuLabel(url: URL, raw: string): string | undefined {
  if (!isOsuHost(url.hostname)) return undefined;

  // Reuse the parsers from osuAuthor.ts for shape detection, so the same regexes don't drift here.
  const discussion = parseOsuDiscussionLink(raw);
  if (discussion) {
    // With `#/<id>` the post number is short and unique; without it, fall back to the beatmapset.
    return discussion.postId !== undefined
      ? `#${discussion.postId}`
      : `beatmapset ${discussion.beatmapsetId}`;
  }

  const forumPost = parseOsuForumPostLink(raw);
  if (forumPost) return `forum post ${forumPost.postId}`;

  const topic = /^\/community\/forums\/topics\/(\d+)/.exec(url.pathname);
  if (topic) return `forum topic ${topic[1]}`;

  const user = /^\/users\/(\d+)/.exec(url.pathname);
  if (user) return `user ${user[1]}`;

  const set = /^\/beatmapsets\/(\d+)/.exec(url.pathname);
  if (set) return `beatmapset ${set[1]}`;

  return undefined;
}

/**
 * Off-site links: the domain (with www stripped) plus a meaningful tail.
 *
 * @param url the parsed URL
 * @returns the label
 */
function externalLabel(url: URL): string {
  const host = url.hostname.replace(/^www\./, '');
  const tail = url.pathname.split('/').filter(Boolean).pop();

  if (!tail || tail.length > 200 || ROUTING_SEGMENTS.has(tail.toLowerCase())) return host;

  const shown = tail.length > MAX_TAIL ? `${tail.slice(0, MAX_TAIL)}…` : tail;
  return `${host}/${shown}`;
}

/**
 * The fallback label. This is what the card shows when the author can't be resolved; the
 * user at least needs to know "what does this one point at".
 *
 * @param link the raw link
 * @returns the label; when there's no URL structure to work with (a relative path, free
 *   text, `mailto:`) the link comes back unchanged -- if we can't tell, don't guess
 */
export function prettyLink(link: string): string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return link;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return link;

  return osuLabel(url, link) ?? externalLabel(url);
}

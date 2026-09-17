import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorForPost,
  clearAuthorCache,
  parseAuthorLink,
  parseBeatmapsetPayload,
  parseForumPostAuthors,
  parseOsuDiscussionLink,
  parseOsuForumPostLink,
  resolveLinkAuthor,
} from '../src/core/osuAuthor';

/**
 * Link -> author: parsing osu discussion permalinks and forum post links, pulling the
 * author out of the page HTML, and the cached resolveLinkAuthor on top of both.
 *
 * The HTML fixtures keep the real site's anchor structure and cut the body text down to
 * what the parsers read. The "can't tell which post this is" paths are checked as hard
 * as the happy ones, because guessing an author is worse than returning none.
 */

/**
 * Build a discussion page HTML with the post data embedded in that script tag.
 *
 * The shape follows the real site (measured 2026-09, excerpted from beatmapset 2608353):
 * posts aren't in DOM class names (that part is React client-rendered), they're stuffed
 * whole into `<script id="json-beatmapset">`.
 *
 * @param payload the beatmapset JSON to embed, passed through JSON.stringify; when undefined the script contains the literal "undefined"
 * @returns a full page of HTML
 */
function pageWith(payload: unknown): string {
  return `<!DOCTYPE html><html><head>
    <script id="json-current-user" type="application/json">null</script>
    <script id="json-beatmapset" type="application/json">${JSON.stringify(payload)}</script>
  </head><body><div class="js-react" data-react="beatmap-discussions"></div></body></html>`;
}

/** An excerpt of the real payload: two discussions, three posts, the author alternating between two users. */
const REAL_PAYLOAD = {
  id: 2608353,
  creator: 'Daycore',
  user_id: 5596337,
  related_users: [
    { id: 5596337, username: 'Daycore' },
    { id: 8266817, username: 'Spectator' },
  ],
  discussions: [
    {
      id: 5752323,
      user_id: 5596337,
      message_type: 'hype',
      posts: [
        { id: 15116795, user_id: 5596337, message: '4562' },
        { id: 15116798, user_id: 8266817, message: 'kudosu' },
      ],
    },
    {
      id: 5732909,
      user_id: 8266817,
      message_type: 'hype',
      posts: [{ id: 15110000, user_id: 8266817, message: 'hi' }],
    },
  ],
};

describe('osu discussion permalink parsing', () => {
  it('extracts beatmapset / difficulty / post id', () => {
    expect(
      parseOsuDiscussionLink('https://osu.ppy.sh/beatmapsets/2542025/discussion/5841469/timeline#/5762228'),
    ).toEqual({ beatmapsetId: 2542025, beatmapId: 5841469, postId: 5762228 });
  });

  it('all-difficulties pages like generalAll have no difficulty (a `-` placeholder)', () => {
    expect(parseOsuDiscussionLink('https://osu.ppy.sh/beatmapsets/2542025/discussion/-/generalAll')).toEqual(
      { beatmapsetId: 2542025 },
    );
  });

  it('a permalink with a hash still yields the post id', () => {
    const ref = parseOsuDiscussionLink(
      'https://osu.ppy.sh/beatmapsets/2608353/discussion/-/generalAll#/5752323',
    );
    expect(ref?.beatmapsetId).toBe(2608353);
    expect(ref?.postId).toBe(5752323);
  });

  it('a sub-path like praises does not affect parsing', () => {
    expect(
      parseOsuDiscussionLink('https://osu.ppy.sh/beatmapsets/2608353/discussion/-/generalAll/praises#/5752323')
        ?.postId,
    ).toBe(5752323);
  });

  it('a non-osu discussion link is always undefined -- these are the ones where the author must not be guessed', () => {
    expect(parseOsuDiscussionLink('https://docs.google.com/document/d/abc')).toBeUndefined();
    expect(parseOsuDiscussionLink('https://i.imgur.com/abc.png')).toBeUndefined();
    expect(parseOsuDiscussionLink('https://osu.ppy.sh/users/5596337')).toBeUndefined();
    expect(parseOsuDiscussionLink('https://osu.ppy.sh/beatmapsets/2608353')).toBeUndefined();
    expect(parseOsuDiscussionLink('https://example.com/beatmapsets/1/discussion/-/generalAll')).toBeUndefined();
    expect(parseOsuDiscussionLink('随手写的一行字')).toBeUndefined();
    expect(parseOsuDiscussionLink('')).toBeUndefined();
  });
});

describe('pulling "post -> author" out of the discussion page HTML', () => {
  it('turns user_id into a username via related_users', () => {
    const payload = parseBeatmapsetPayload(pageWith(REAL_PAYLOAD));
    expect(payload).toBeDefined();
    expect(payload!.discussionAuthors.get(5752323)).toBe(5596337);
    expect(payload!.postAuthors.get(15116798)).toBe(8266817);
    expect(payload!.usernames.get(5596337)).toBe('Daycore');
  });

  it('both permalink kinds, discussion id and post id, resolve to an author', () => {
    const payload = parseBeatmapsetPayload(pageWith(REAL_PAYLOAD))!;
    // The hash points at the discussion thread itself (what the site does now)
    expect(authorForPost(payload, 5752323)).toEqual({ username: 'Daycore', id: 5596337 });
    // The hash points at one reply inside the discussion thread
    expect(authorForPost(payload, 15116798)).toEqual({ username: 'Spectator', id: 8266817 });
  });

  it('an unknown id returns undefined, not the "first author" as a stand-in', () => {
    const payload = parseBeatmapsetPayload(pageWith(REAL_PAYLOAD))!;
    expect(authorForPost(payload, 999999)).toBeUndefined();
  });

  it('also returns undefined when the user_id has no username in the table', () => {
    const payload = parseBeatmapsetPayload(
      pageWith({ related_users: [], discussions: [{ id: 1, user_id: 42, posts: [] }] }),
    )!;
    expect(authorForPost(payload, 1)).toBeUndefined();
  });

  it('no json-beatmapset in the page (site redesign / not a discussion page) -> undefined, no throw', () => {
    expect(parseBeatmapsetPayload('<html><body>换个页面</body></html>')).toBeUndefined();
    expect(parseBeatmapsetPayload(pageWith(undefined))).toBeUndefined();
  });

  it('invalid JSON inside the <script> is just undefined too', () => {
    expect(
      parseBeatmapsetPayload('<script id="json-beatmapset">{ 这不是 json </script>'),
    ).toBeUndefined();
  });

  it('dirty data with missing fields does not blow up the parse', () => {
    const payload = parseBeatmapsetPayload(
      pageWith({ discussions: [{ id: 'x' }, null, { id: 5, user_id: 7, posts: [{ id: null }] }] }),
    );
    expect(payload).toBeDefined();
    expect(payload!.discussionAuthors.size).toBe(1);
  });
});

/**
 * Build a forum topic page HTML.
 *
 * The shape follows the real site (measured 2026-09, excerpted from topic 2216866):
 * the forum and the discussion page aren't the same thing, and this one is server-rendered
 * DOM, aligned item by item using three anchors: `data-post-id`, `forum-post__user` and
 * `js-post-url`. The real page has 15 posts; below only the anchor structure is kept and
 * the body text is truncated.
 *
 * @param posts the post blocks built by forumPost(), joined into the body in order
 * @returns a full page of HTML
 */
function forumPage(...posts: string[]): string {
  return `<!DOCTYPE html><html><head>
    <script id="json-current-user" type="application/json">null</script>
    <script id="json-route-section" type="application/json">{"section":"forum"}</script>
  </head><body>
    ${posts.join('\n')}
  </body></html>`;
}

/**
 * Build the HTML for one forum post block.
 *
 * @param opts.postId the post's data-post-id, which is the key the parse result is looked up by
 * @param opts.username the username, going into both data-post-username and the author anchor; omit it and data-post-username isn't written
 * @param opts.userId the author's user id, defaulting to 0
 * @param opts.body the post body; when omitted a placeholder body is used
 * @returns the post block HTML
 */
function forumPost(opts: {
  postId: number;
  username?: string;
  userId?: number;
  body?: string;
}): string {
  const head = `<div
    class="js-forum-post  forum-post"
    data-post-id="${opts.postId}"${opts.username === undefined ? '' : `
    data-post-username="${opts.username}"`}
    data-post-position="1"
>
    <div class="forum-post__body">
        <div class="forum-post__content forum-post__content--header">
            <div class="forum-post__header-content">
                <div class="forum-post__header-content-item">
                    <a class='forum-post__user js-usercard' data-user-id='${opts.userId ?? 0}' href='https://osu.ppy.sh/users/${opts.userId ?? 0}' style=''>${opts.username ?? ''}</a>
                    <a class="js-post-url" rel="nofollow" href="https://osu.ppy.sh/community/forums/posts/${opts.postId}">`;
  return `${head}<div class="forum-post__content forum-post__content--main">${opts.body ?? '正文'}</div></div></div></div>`;
}

describe('osu forum link parsing (parseOsuForumPostLink)', () => {
  it('a post permalink yields the post id', () => {
    expect(parseOsuForumPostLink('https://osu.ppy.sh/community/forums/posts/10229745')).toEqual({
      postId: 10229745,
    });
  });

  it('a topic link with ?start=<postId> also locates the post (the live site jumps to posts this way)', () => {
    expect(
      parseOsuForumPostLink('https://osu.ppy.sh/community/forums/topics/2216866?start=10229668'),
    ).toEqual({ postId: 10229668 });
  });

  it('a topic alone, without start: do not guess which post it is', () => {
    expect(parseOsuForumPostLink('https://osu.ppy.sh/community/forums/topics/2216866')).toBeUndefined();
  });

  it('anything not osu-related is always undefined', () => {
    expect(parseOsuForumPostLink('https://example.com/community/forums/posts/1')).toBeUndefined();
    // Domain looks similar but isn't osu
    expect(
      parseOsuForumPostLink('https://osu.ppy.sh.evil.example/community/forums/posts/1'),
    ).toBeUndefined();
    expect(parseOsuForumPostLink('https://osu.ppy.sh/beatmapsets/2608353')).toBeUndefined();
    expect(parseOsuForumPostLink('随手写的一行字')).toBeUndefined();
    expect(parseOsuForumPostLink('')).toBeUndefined();
  });
});

describe('forum page HTML -> post authors (parseForumPostAuthors)', () => {
  it('each post block yields postId -> author (with user id)', () => {
    const html = forumPage(
      forumPost({ postId: 10229668, username: 'sheepex_', userId: 26699280 }),
      forumPost({ postId: 10229745, username: 'Kxxn', userId: 26595459 }),
      forumPost({ postId: 10252138, username: 'peppy', userId: 2 }),
    );
    const authors = parseForumPostAuthors(html);
    expect(authors.size).toBe(3);
    expect(authors.get(10229668)).toEqual({ username: 'sheepex_', id: 26699280 });
    expect(authors.get(10229745)).toEqual({ username: 'Kxxn', id: 26595459 });
    expect(authors.get(10252138)).toEqual({ username: 'peppy', id: 2 });
  });

  it('HTML entities in the username are decoded (things like `&amp;`)', () => {
    const html = forumPage(forumPost({ postId: 5, username: 'A&amp;B', userId: 42 }));
    expect(parseForumPostAuthors(html).get(5)).toEqual({ username: 'A&B', id: 42 });
  });

  it('falls back to the forum-post__user text when data-post-username is absent', () => {
    const html = forumPage(forumPost({ postId: 7, username: 'Fallback', userId: 9 }));
    // Wipe data-post-username off the container tag to simulate a site redesign
    const trimmed = html.replace(/\n    data-post-username="Fallback"/, '');
    expect(parseForumPostAuthors(trimmed).get(7)).toEqual({ username: 'Fallback', id: 9 });
  });

  it('a deleted post (no author anchor) is skipped, no author invented', () => {
    const html = forumPage(
      forumPost({ postId: 1, username: 'Alive', userId: 11 }),
      `<div class="js-forum-post  forum-post" data-post-id="2" data-post-position="2">
         <div class="forum-post__body">这条被删了</div>
       </div>`,
    );
    const authors = parseForumPostAuthors(html);
    expect(authors.size).toBe(1);
    expect(authors.has(2)).toBe(false);
  });

  it('a non-forum page / unexpected structure returns an empty map, no throw', () => {
    expect(parseForumPostAuthors('<html><body>换个页面</body></html>').size).toBe(0);
    expect(parseForumPostAuthors('').size).toBe(0);
    // Nearby false positives: js-forum-post-edit--container / js-forum-post-report aren't post containers
    const noise = `<div class="forum-post__body js-forum-post-edit--container" data-post-id="9"></div>
      <div class="js-react hidden" data-react="forum-post-report"></div>`;
    expect(parseForumPostAuthors(noise).size).toBe(0);
  });
});

describe('parseAuthorLink: deciding uniformly whether a link has a resolvable author', () => {
  it('discussion permalink -> kind=discussion, takes the page path (hash stripped)', () => {
    expect(
      parseAuthorLink('https://osu.ppy.sh/beatmapsets/2608353/discussion/-/generalAll#/5752323'),
    ).toEqual({
      kind: 'discussion',
      postId: 5752323,
      pageUrl: 'https://osu.ppy.sh/beatmapsets/2608353/discussion/-/generalAll',
    });
  });

  it('forum post link -> kind=forum', () => {
    expect(parseAuthorLink('https://osu.ppy.sh/community/forums/posts/10229745')).toEqual({
      kind: 'forum',
      postId: 10229745,
      pageUrl: 'https://osu.ppy.sh/community/forums/posts/10229745',
    });
  });

  it('anything that cannot be pinned to a post is always undefined', () => {
    expect(parseAuthorLink('https://docs.google.com/document/d/abc')).toBeUndefined();
    expect(parseAuthorLink('https://osu.ppy.sh/users/5596337')).toBeUndefined();
    expect(parseAuthorLink('https://osu.ppy.sh/community/forums/topics/2216866')).toBeUndefined();
    expect(
      parseAuthorLink('https://osu.ppy.sh/beatmapsets/2608353/discussion/-/generalAll'),
    ).toBeUndefined();
    expect(parseAuthorLink('')).toBeUndefined();
  });
});

describe('resolveLinkAuthor rejection paths (the cases that send no request)', () => {
  beforeEach(() => clearAuthorCache());

  it('a non-osu link / a link that cannot be pinned to a post is dropped outright, never throws', async () => {
    await expect(resolveLinkAuthor('https://docs.google.com/document/d/abc')).resolves.toBeUndefined();
    await expect(resolveLinkAuthor('https://i.imgur.com/abc.png')).resolves.toBeUndefined();
    // Domain looks similar but isn't osu: don't send a request after it
    await expect(
      resolveLinkAuthor('https://osu.ppy.sh.evil.example/beatmapsets/1/discussion/-/generalAll#/2'),
    ).resolves.toBeUndefined();
    await expect(
      resolveLinkAuthor('https://osu.ppy.sh.evil.example/community/forums/posts/1'),
    ).resolves.toBeUndefined();
    // A discussion link but without #/<id>: we don't know which post it means, so don't guess
    await expect(
      resolveLinkAuthor('https://osu.ppy.sh/beatmapsets/2608353/discussion/-/generalAll'),
    ).resolves.toBeUndefined();
    // A forum topic but without start: same as above
    await expect(
      resolveLinkAuthor('https://osu.ppy.sh/community/forums/topics/2216866'),
    ).resolves.toBeUndefined();
    await expect(resolveLinkAuthor('')).resolves.toBeUndefined();
  });
});

describe('resolveLinkAuthor cache semantics (blur fires repeatedly, but that is no reason to fail repeatedly)', () => {
  beforeEach(() => clearAuthorCache());
  afterEach(() => vi.unstubAllGlobals());

  // A forum post link in its real form: the post can be located, so this one always gets
  // as far as fetch.
  const LINK = 'https://osu.ppy.sh/community/forums/posts/10229745';

  it('parse succeeds -> cache hit, no second request', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => forumPage(forumPost({ postId: 10229745, username: 'Kxxn', userId: 26595459 })),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveLinkAuthor(LINK)).resolves.toEqual({ id: 26595459, username: 'Kxxn' });
    await expect(resolveLinkAuthor(LINK)).resolves.toEqual({ id: 26595459, username: 'Kxxn' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parse fails -> not cached, the next blur retries (otherwise one hiccup poisons the whole session)', async () => {
    // First network call fails, second succeeds -- exactly the shape of "a brief network drop".
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        text: async () => forumPage(forumPost({ postId: 10229745, username: 'Kxxn', userId: 26595459 })),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveLinkAuthor(LINK)).resolves.toBeUndefined();
    await expect(resolveLinkAuthor(LINK)).resolves.toEqual({ id: 26595459, username: 'Kxxn' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('HTML comes back but without that post -> still a failure, not cached', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      // The page doesn't have post 10229745
      text: async () => forumPage(forumPost({ postId: 999, username: '别人', userId: 1 })),
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveLinkAuthor(LINK)).resolves.toBeUndefined();
    await expect(resolveLinkAuthor(LINK)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

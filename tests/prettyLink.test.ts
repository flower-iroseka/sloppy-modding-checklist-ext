import { describe, expect, it } from 'vitest';
import { prettyLink } from '../src/core/prettyLink';

/**
 * prettyLink: how a raw URL is shown on a card.
 *
 * Every expected value is what the user reads, so the cases are grouped by the shape
 * being recognized -- known osu paths, off-site domains, and the fallback that returns
 * the text unchanged when nothing matches.
 */

describe('prettyLink: known osu on-site shapes get a human-readable label', () => {
  it('a discussion permalink with #/<id> uses the post number (short and unique)', () => {
    expect(
      prettyLink('https://osu.ppy.sh/beatmapsets/2608353/discussion/-/generalAll#/5752323'),
    ).toBe('#5752323');
    expect(
      prettyLink('https://osu.ppy.sh/beatmapsets/2547978/discussion/5694126/timeline#/5741319'),
    ).toBe('#5741319');
  });

  it('a discussion link without #/<id> falls back to the beatmapset', () => {
    expect(prettyLink('https://osu.ppy.sh/beatmapsets/2608353/discussion/-/generalAll')).toBe(
      'beatmapset 2608353',
    );
  });

  it('beatmap page / user profile / forum each get their own label', () => {
    // This one used to render as `123#osu/456`
    expect(prettyLink('https://osu.ppy.sh/beatmapsets/123#osu/456')).toBe('beatmapset 123');
    expect(prettyLink('https://osu.ppy.sh/users/26595459')).toBe('user 26595459');
    expect(prettyLink('https://osu.ppy.sh/community/forums/topics/2216866')).toBe(
      'forum topic 2216866',
    );
    expect(prettyLink('https://osu.ppy.sh/community/forums/posts/10229745')).toBe(
      'forum post 10229745',
    );
    // A topic link with ?start= points at a specific post, so show it as a post
    expect(prettyLink('https://osu.ppy.sh/community/forums/topics/2216866?start=10229668')).toBe(
      'forum post 10229668',
    );
  });

  it('the www subdomain is recognized too (so a future domain change does not silently degrade)', () => {
    expect(prettyLink('https://www.osu.ppy.sh/users/2')).toBe('user 2');
  });
});

describe('prettyLink: off-site links use the domain + a meaningful trailing segment', () => {
  it('route verbs are not used as labels (these were the ugliest class in the old implementation)', () => {
    expect(prettyLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube.com');
    expect(prettyLink('https://docs.google.com/document/d/abc123/edit')).toBe('docs.google.com');
    expect(prettyLink('https://github.com/ppy/osu/issues')).toBe('github.com');
  });

  it('keeps the trailing segment when it carries information, strips www from the domain', () => {
    expect(prettyLink('https://github.com/ppy/osu/issues/12345')).toBe('github.com/12345');
    expect(prettyLink('https://imgur.com/a/xyz')).toBe('imgur.com/xyz');
    expect(prettyLink('https://i.imgur.com/abc.png')).toBe('i.imgur.com/abc.png');
  });

  it('when there is only a domain, use the domain', () => {
    expect(prettyLink('https://example.com')).toBe('example.com');
    expect(prettyLink('https://example.com/')).toBe('example.com');
  });

  it('truncates an over-long trailing segment so it does not stretch the card', () => {
    const long = 'x'.repeat(60);
    expect(prettyLink(`https://example.com/${long}`)).toBe(`example.com/${'x'.repeat(24)}…`);
  });
});

describe('prettyLink: returns the text unchanged when it cannot be guessed', () => {
  it('returns the text as-is when it is not a valid URL / not http(s)', () => {
    expect(prettyLink('随手写的一行字')).toBe('随手写的一行字');
    expect(prettyLink('')).toBe('');
    expect(prettyLink('mailto:someone@example.com')).toBe('mailto:someone@example.com');
  });
});

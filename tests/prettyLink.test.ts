import { describe, expect, it } from 'vitest';
import { prettyLink } from '../src/core/prettyLink';

/**
 * prettyLink: how a raw URL is shown on a card.
 *
 * Every expected value is what the user reads, so the cases are grouped by the shape
 * being recognized -- known osu paths, off-site domains, and the fallback that returns
 * the text unchanged when nothing matches.
 */

describe('prettyLink：osu 站内按已知形态给一句人话', () => {
  it('discussion permalink 带 #/<id> 时用帖子编号（短且唯一）', () => {
    expect(
      prettyLink('https://osu.ppy.sh/beatmapsets/2608353/discussion/-/generalAll#/5752323'),
    ).toBe('#5752323');
    expect(
      prettyLink('https://osu.ppy.sh/beatmapsets/2547978/discussion/5694126/timeline#/5741319'),
    ).toBe('#5741319');
  });

  it('没带 #/<id> 的 discussion 链接退回谱面集', () => {
    expect(prettyLink('https://osu.ppy.sh/beatmapsets/2608353/discussion/-/generalAll')).toBe(
      'beatmapset 2608353',
    );
  });

  it('谱面页 / 用户主页 / 论坛都有对应说法', () => {
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

  it('www 子域也认（站点哪天换了域名不至于静默降级）', () => {
    expect(prettyLink('https://www.osu.ppy.sh/users/2')).toBe('user 2');
  });
});

describe('prettyLink：站外链接用域名 + 有意义的尾段', () => {
  it('路由动词不当标签（这些是旧实现里最难看的一类）', () => {
    expect(prettyLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('youtube.com');
    expect(prettyLink('https://docs.google.com/document/d/abc123/edit')).toBe('docs.google.com');
    expect(prettyLink('https://github.com/ppy/osu/issues')).toBe('github.com');
  });

  it('尾段有信息量时带上，域名去掉 www', () => {
    expect(prettyLink('https://github.com/ppy/osu/issues/12345')).toBe('github.com/12345');
    expect(prettyLink('https://imgur.com/a/xyz')).toBe('imgur.com/xyz');
    expect(prettyLink('https://i.imgur.com/abc.png')).toBe('i.imgur.com/abc.png');
  });

  it('只有域名时就用域名', () => {
    expect(prettyLink('https://example.com')).toBe('example.com');
    expect(prettyLink('https://example.com/')).toBe('example.com');
  });

  it('尾段过长时截断，免得把卡片撑歪', () => {
    const long = 'x'.repeat(60);
    expect(prettyLink(`https://example.com/${long}`)).toBe(`example.com/${'x'.repeat(24)}…`);
  });
});

describe('prettyLink：猜不出来就把原文还回去', () => {
  it('不是合法 URL / 不是 http(s) 时原样返回', () => {
    expect(prettyLink('随手写的一行字')).toBe('随手写的一行字');
    expect(prettyLink('')).toBe('');
    expect(prettyLink('mailto:someone@example.com')).toBe('mailto:someone@example.com');
  });
});

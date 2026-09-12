import { describe, expect, it } from 'vitest';
import { parseBeatmapsetId, parseBeatmapId, recommendScope, recommendSource } from '../src/content/osuUser';
import { parsePageMode } from '../src/content/locators';
import { normalizeDoc, normalizeEntry } from '../src/core/doc';
import { createEmptyDoc } from '../src/core/doc';

/**
 * Reading osu! pages: URL parsing (beatmapset / difficulty / page mode) and the scope and
 * source recommendations that follow from it, plus the normalize round-trip for
 * linkAuthors and meta.beatmapId.
 *
 * The inputs are strings copied off the live site, because the shapes are the point -- a
 * `-` standing in for a difficulty, a permalink's `#/<id>`, sub-paths like praises.
 */

describe('osu URL 解析', () => {
  it('取出 beatmapset id', () => {
    expect(parseBeatmapsetId('https://osu.ppy.sh/beatmapsets/2542025/discussion/-/generalAll')).toBe(
      2542025,
    );
    expect(parseBeatmapsetId('https://osu.ppy.sh/beatmapsets/2542025')).toBe(2542025);
    expect(parseBeatmapsetId('https://osu.ppy.sh/home')).toBeUndefined();
  });

  it('取出难度 id；generalAll / reviews 这类没有难度', () => {
    expect(parseBeatmapId('https://osu.ppy.sh/beatmapsets/2340745/discussion/5434238/timeline')).toBe(
      5434238,
    );
    expect(parseBeatmapId('https://osu.ppy.sh/beatmapsets/2340745/discussion/-/generalAll')).toBeUndefined();
    expect(parseBeatmapId('https://osu.ppy.sh/beatmapsets/2340745/discussion/-/reviews')).toBeUndefined();
  });

  it('permalink 带 hash 也照样解析（真实站点形如 …/discussion/-/generalAll#/5762228）', () => {
    const permalink = 'https://osu.ppy.sh/beatmapsets/2542025/discussion/-/generalAll#/5762228';
    expect(parseBeatmapsetId(permalink)).toBe(2542025);
    expect(parseBeatmapId(permalink)).toBeUndefined();
  });
});

describe('来源推荐（CODING_PLAN §8.3）', () => {
  it('作者就是当前登录用户 → internal', () => {
    expect(recommendSource(14579989, 14579989)).toBe('internal');
  });

  it('作者是别人 → external', () => {
    expect(recommendSource(14579989, 123)).toBe('external');
  });

  it('未登录 / 作者 id 缺失 → 退回 external', () => {
    expect(recommendSource(14579989, undefined)).toBe('external');
    expect(recommendSource(undefined, 123)).toBe('external');
    expect(recommendSource(undefined, undefined)).toBe('external');
  });
});

describe('范围推荐（CODING_PLAN §8.3）：按 mod 所在的讨论页位置判断', () => {
  it('General (All difficulties) / General (当前难度) → general', () => {
    expect(recommendScope('generalAll')).toBe('general');
    expect(recommendScope('general')).toBe('general');
  });

  it('Timeline（时间轴）→ individual', () => {
    expect(recommendScope('timeline')).toBe('individual');
  });

  it('没有整图/具体语义的页面（reviews / events）退回 general', () => {
    expect(recommendScope('reviews')).toBe('general');
    expect(recommendScope('events')).toBe('general');
  });

  it('读不到分类（站点改版）也退回 general，不抛错', () => {
    expect(recommendScope(undefined)).toBe('general');
    expect(recommendScope('')).toBe('general');
    expect(recommendScope('somethingNew')).toBe('general');
  });
});

describe('从 URL 路径读页面分类（DOM 读取的兜底）', () => {
  it('五种实测模式都能解析', () => {
    expect(parsePageMode('/beatmapsets/2608353/discussion/-/generalAll')).toBe('generalAll');
    expect(parsePageMode('/beatmapsets/2608353/discussion/5841469/general')).toBe('general');
    expect(parsePageMode('/beatmapsets/2608353/discussion/5841469/timeline')).toBe('timeline');
    expect(parsePageMode('/beatmapsets/2608353/discussion/-/reviews')).toBe('reviews');
    expect(parsePageMode('/beatmapsets/2608353/discussion/-/events')).toBe('events');
  });

  it('带子路径（praises 等）仍取分类那一段', () => {
    expect(parsePageMode('/beatmapsets/2608353/discussion/-/generalAll/praises')).toBe('generalAll');
  });

  it('非 discussion 页返回 undefined', () => {
    expect(parsePageMode('/beatmapsets/2608353')).toBeUndefined();
    expect(parsePageMode('/home')).toBeUndefined();
  });
});

describe('linkAuthors 的规整与往返（CODING_PLAN §8.4）', () => {
  it('保留合法项，丢掉没有用户名的项', () => {
    const entry = normalizeEntry({
      id: 'e1',
      scope: 'general',
      source: 'internal',
      summary: 'x',
      links: ['https://osu.ppy.sh/beatmapsets/1/discussion/-/generalAll#/2'],
      linkAuthors: {
        'https://osu.ppy.sh/beatmapsets/1/discussion/-/generalAll#/2': { username: 'Daycore', id: 5596337 },
        'https://osu.ppy.sh/beatmapsets/1/discussion/-/generalAll#/3': { id: 42 },
        '': { username: '空键不要' },
      },
    });
    expect(entry?.linkAuthors).toEqual({
      'https://osu.ppy.sh/beatmapsets/1/discussion/-/generalAll#/2': { username: 'Daycore', id: 5596337 },
    });
  });

  it('没有可用的项时整个字段不落库', () => {
    const base = { id: 'e1', scope: 'general', source: 'internal', summary: 'x', links: [] };
    expect(normalizeEntry({ ...base, linkAuthors: {} })?.linkAuthors).toBeUndefined();
    expect(normalizeEntry({ ...base, linkAuthors: 'nope' })?.linkAuthors).toBeUndefined();
    expect(normalizeEntry(base)?.linkAuthors).toBeUndefined();
  });

  it('归一化整份文档时 linkAuthors 不丢 —— 否则刷新一次就悄悄没了', () => {
    const doc = createEmptyDoc('d-1', 1);
    doc.cells['general-internal'].push({
      id: 'e1',
      scope: 'general',
      source: 'internal',
      summary: 'x',
      links: ['https://osu.ppy.sh/beatmapsets/1/discussion/-/generalAll#/2'],
      linkAuthors: {
        'https://osu.ppy.sh/beatmapsets/1/discussion/-/generalAll#/2': { username: 'Daycore', id: 5596337 },
      },
      createdAt: 1,
      updatedAt: 1,
    });
    const round = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    expect(round.cells['general-internal'][0]!.linkAuthors).toEqual({
      'https://osu.ppy.sh/beatmapsets/1/discussion/-/generalAll#/2': { username: 'Daycore', id: 5596337 },
    });
  });
});

describe('meta.beatmapId 的规整与往返', () => {
  it('保留 beatmapId，丢弃非法值', () => {
    const entry = normalizeEntry({
      id: 'e1',
      scope: 'general',
      source: 'internal',
      summary: 'x',
      links: [],
      meta: { beatmapsetId: 2340745, beatmapId: 5434238, mode: 'osu' },
    });
    expect(entry?.meta).toEqual({
      beatmapsetId: 2340745,
      beatmapId: 5434238,
      mode: 'osu',
    });

    const bad = normalizeEntry({
      id: 'e2',
      scope: 'general',
      source: 'internal',
      summary: 'x',
      links: [],
      meta: { beatmapId: 'nope' },
    });
    expect(bad?.meta).toBeUndefined();
  });

  it('归一化整份文档时 beatmapId 不丢', () => {
    const doc = createEmptyDoc('d-1', 1);
    doc.cells['general-internal'].push({
      id: 'e1',
      scope: 'general',
      source: 'internal',
      summary: 'x',
      links: [],
      meta: { beatmapsetId: 1, beatmapId: 2 },
      createdAt: 1,
      updatedAt: 1,
    });
    const round = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    expect(round.cells['general-internal'][0]!.meta).toEqual({ beatmapsetId: 1, beatmapId: 2 });
  });

  it('老数据里的 category 在读入时被丢掉（它本来就在链接里）', () => {
    const entry = normalizeEntry({
      id: 'e1',
      scope: 'general',
      source: 'internal',
      summary: 'x',
      links: ['https://osu.ppy.sh/beatmapsets/1/discussion/-/generalAll'],
      meta: { beatmapsetId: 1, mode: 'osu', category: 'generalAll' },
    });
    expect(entry?.meta).toEqual({ beatmapsetId: 1, mode: 'osu' });
    expect(entry?.meta).not.toHaveProperty('category');
  });
});

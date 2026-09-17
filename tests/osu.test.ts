import { describe, expect, it } from 'vitest';
import { parseBeatmapsetId, parseBeatmapId, readPageBeatmaps, recommendScope, recommendSource } from '../src/content/osuUser';
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

describe('osu URL parsing', () => {
  it('extracts the beatmapset id', () => {
    expect(parseBeatmapsetId('https://osu.ppy.sh/beatmapsets/2542025/discussion/-/generalAll')).toBe(
      2542025,
    );
    expect(parseBeatmapsetId('https://osu.ppy.sh/beatmapsets/2542025')).toBe(2542025);
    expect(parseBeatmapsetId('https://osu.ppy.sh/home')).toBeUndefined();
  });

  it('extracts the difficulty id; generalAll / reviews have no difficulty', () => {
    expect(parseBeatmapId('https://osu.ppy.sh/beatmapsets/2340745/discussion/5434238/timeline')).toBe(
      5434238,
    );
    expect(parseBeatmapId('https://osu.ppy.sh/beatmapsets/2340745/discussion/-/generalAll')).toBeUndefined();
    expect(parseBeatmapId('https://osu.ppy.sh/beatmapsets/2340745/discussion/-/reviews')).toBeUndefined();
  });

  it('a permalink with a hash still parses (the live site uses .../discussion/-/generalAll#/5762228)', () => {
    const permalink = 'https://osu.ppy.sh/beatmapsets/2542025/discussion/-/generalAll#/5762228';
    expect(parseBeatmapsetId(permalink)).toBe(2542025);
    expect(parseBeatmapId(permalink)).toBeUndefined();
  });
});

describe('source recommendation (CODING_PLAN §8.3)', () => {
  it('author is the logged-in user -> internal', () => {
    expect(recommendSource(14579989, 14579989)).toBe('internal');
  });

  it('author is someone else -> external', () => {
    expect(recommendSource(14579989, 123)).toBe('external');
  });

  it('not logged in / missing author id -> falls back to external', () => {
    expect(recommendSource(14579989, undefined)).toBe('external');
    expect(recommendSource(undefined, 123)).toBe('external');
    expect(recommendSource(undefined, undefined)).toBe('external');
  });
});

describe('scope recommendation (CODING_PLAN §8.3): decided by where the mod sits on the discussion page', () => {
  it('General (All difficulties) / General (current difficulty) -> general', () => {
    expect(recommendScope('generalAll')).toBe('general');
    expect(recommendScope('general')).toBe('general');
  });

  it('Timeline -> individual', () => {
    expect(recommendScope('timeline')).toBe('individual');
  });

  it('pages with no all-difficulties/specific meaning (reviews / events) fall back to general', () => {
    expect(recommendScope('reviews')).toBe('general');
    expect(recommendScope('events')).toBe('general');
  });

  it('an unreadable category (site redesign) also falls back to general, no throw', () => {
    expect(recommendScope(undefined)).toBe('general');
    expect(recommendScope('')).toBe('general');
    expect(recommendScope('somethingNew')).toBe('general');
  });
});

describe('reading the page category from the URL path (fallback for DOM reads)', () => {
  it('all five observed modes parse', () => {
    expect(parsePageMode('/beatmapsets/2608353/discussion/-/generalAll')).toBe('generalAll');
    expect(parsePageMode('/beatmapsets/2608353/discussion/5841469/general')).toBe('general');
    expect(parsePageMode('/beatmapsets/2608353/discussion/5841469/timeline')).toBe('timeline');
    expect(parsePageMode('/beatmapsets/2608353/discussion/-/reviews')).toBe('reviews');
    expect(parsePageMode('/beatmapsets/2608353/discussion/-/events')).toBe('events');
  });

  it('a sub-path (praises etc.) still takes the category segment', () => {
    expect(parsePageMode('/beatmapsets/2608353/discussion/-/generalAll/praises')).toBe('generalAll');
  });

  it('a non-discussion page returns undefined', () => {
    expect(parsePageMode('/beatmapsets/2608353')).toBeUndefined();
    expect(parsePageMode('/home')).toBeUndefined();
  });
});

describe('linkAuthors normalization and round-trip (CODING_PLAN §8.4)', () => {
  it('keeps valid items, drops items without a username', () => {
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

  it('no usable item means the whole field is not stored', () => {
    const base = { id: 'e1', scope: 'general', source: 'internal', summary: 'x', links: [] };
    expect(normalizeEntry({ ...base, linkAuthors: {} })?.linkAuthors).toBeUndefined();
    expect(normalizeEntry({ ...base, linkAuthors: 'nope' })?.linkAuthors).toBeUndefined();
    expect(normalizeEntry(base)?.linkAuthors).toBeUndefined();
  });

  it('normalizing a whole doc does not lose linkAuthors -- otherwise one refresh would quietly drop them', () => {
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

describe('meta.beatmapId normalization and round-trip', () => {
  it('keeps beatmapId, drops invalid values', () => {
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

  it('normalizing a whole doc does not lose beatmapId', () => {
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

  it('a legacy category is dropped on read (it already lives in the link)', () => {
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

describe('readPageBeatmaps', () => {
  // The reader takes its root as a parameter so it can be exercised without a DOM. All the
  // selector does is `querySelector(…).textContent`, so a two-field stand-in is the whole
  // contract -- and this is the only coverage the content script's beatmap path has (the
  // rest of readPostTarget needs a real page).
  const root = (text: string | null): ParentNode =>
    ({ querySelector: () => (text === null ? null : { textContent: text }) }) as unknown as ParentNode;

  it('reads the embedded beatmapset JSON', () => {
    const list = readPageBeatmaps(
      root(
        JSON.stringify({
          beatmaps: [{ id: 5752323, version: 'Insane', difficulty_rating: 5.65, mode: 'osu' }],
        }),
      ),
    );
    expect(list).toEqual([{ id: 5752323, version: 'Insane', stars: 5.65, mode: 'osu' }]);
  });

  it('returns an empty array when the tag is missing or its text is unusable', () => {
    // Not throwing is the point: this runs inside the "+ click", where a throw is reported
    // to the user as "the site layout may have changed".
    expect(readPageBeatmaps(root(null))).toEqual([]);
    expect(readPageBeatmaps(root(''))).toEqual([]);
    expect(readPageBeatmaps(root('{oops'))).toEqual([]);
  });
});

describe('difficulty normalization and round-trip', () => {
  const base = { id: 'e1', scope: 'individual', source: 'external', summary: 'x', links: [] };

  it('keeps a valid tier', () => {
    expect(normalizeEntry({ ...base, difficulty: 'insane' })?.difficulty).toBe('insane');
  });

  it('drops an unusable tier but keeps the entry', () => {
    // Unlike scope / source, nothing about the entry depends on this field, so losing the
    // text over a bad value would be the wrong trade.
    for (const value of ['Insane', 'nightmare', 3, null, {}]) {
      const entry = normalizeEntry({ ...base, difficulty: value });
      expect(entry, String(value)).not.toBeNull();
      expect(entry?.difficulty, String(value)).toBeUndefined();
    }
  });

  it('stores no key at all when there is no tier', () => {
    expect(normalizeEntry(base)).not.toHaveProperty('difficulty');
  });

  it('normalizing a whole doc does not lose the tier', () => {
    const doc = createEmptyDoc('d-1', 1);
    doc.cells['individual-external'].push({
      id: 'e1',
      scope: 'individual',
      source: 'external',
      summary: 'x',
      links: [],
      difficulty: 'hard',
      createdAt: 1,
      updatedAt: 1,
    });
    const round = normalizeDoc(JSON.parse(JSON.stringify(doc)));
    expect(round.cells['individual-external'][0]!.difficulty).toBe('hard');
  });
});

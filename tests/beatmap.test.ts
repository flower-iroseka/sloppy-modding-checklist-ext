import { describe, expect, it } from 'vitest';
import {
  beatmapsFromJsonText,
  parseBeatmapsetBeatmaps,
  pickBeatmap,
  type BeatmapInfo,
} from '../src/core/beatmap';

/**
 * Reading the difficulties out of osu's embedded `json-beatmapset`.
 *
 * The fixtures keep the real payload's shape (measured 2026-09, excerpted from beatmapset
 * 2608353): the difficulty name really is `version`, the star rating is `difficulty_rating`,
 * the ruleset comes as both a string and a number, and the versions themselves are free
 * text that has nothing to do with a tier ("https://4562.world/" is a real one).
 *
 * Every failure path is checked as hard as the happy one: this parser sits inside the
 * content script's "+ click", so a throw here would be reported as "the site layout may
 * have changed" on a post that was read perfectly well.
 */

/** A row as the real payload spells it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 5752323,
    beatmapset_id: 2608353,
    difficulty_rating: 5.65008,
    mode: 'fruits',
    mode_int: 2,
    version: 'https://4562.world/',
    ...overrides,
  };
}

describe('parseBeatmapsetBeatmaps', () => {
  it('reads id, version, stars and mode', () => {
    expect(parseBeatmapsetBeatmaps({ beatmaps: [row()] })).toEqual([
      { id: 5752323, version: 'https://4562.world/', stars: 5.65008, mode: 'catch' },
    ]);
  });

  it('keeps a row that has a name but no star rating', () => {
    // The name can still match the naming table on its own.
    const list = parseBeatmapsetBeatmaps({
      beatmaps: [row({ difficulty_rating: undefined, version: 'Insane' })],
    });
    expect(list).toEqual([{ id: 5752323, version: 'Insane', mode: 'catch' }]);
  });

  it('drops a row that identifies no difficulty at all', () => {
    const list = parseBeatmapsetBeatmaps({
      beatmaps: [row({ id: undefined, version: undefined }), row({ id: 42, version: 'Hard' })],
    });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe(42);
  });

  it('drops rows that are not objects', () => {
    expect(parseBeatmapsetBeatmaps({ beatmaps: [null, 'x', 7, row()] })).toHaveLength(1);
  });

  it('falls back to mode_int when there is no mode string', () => {
    for (const [int, mode] of [[0, 'osu'], [1, 'taiko'], [2, 'catch'], [3, 'mania']] as const) {
      const list = parseBeatmapsetBeatmaps({
        beatmaps: [row({ mode: undefined, mode_int: int })],
      });
      expect(list[0]!.mode, String(int)).toBe(mode);
    }
  });

  it('leaves mode off when neither field is usable', () => {
    const list = parseBeatmapsetBeatmaps({
      beatmaps: [row({ mode: 'something-else', mode_int: 99 })],
    });
    expect(list[0]).not.toHaveProperty('mode');
  });

  it('returns an empty list for a payload with no beatmaps', () => {
    expect(parseBeatmapsetBeatmaps({})).toEqual([]);
    expect(parseBeatmapsetBeatmaps({ beatmaps: null })).toEqual([]);
    expect(parseBeatmapsetBeatmaps({ beatmaps: 'nope' })).toEqual([]);
    expect(parseBeatmapsetBeatmaps({ beatmaps: [] })).toEqual([]);
  });

  it('returns an empty list when the payload is not an object', () => {
    for (const raw of [undefined, null, 'json', 3, []]) {
      expect(parseBeatmapsetBeatmaps(raw), String(raw)).toEqual([]);
    }
  });
});

describe('beatmapsFromJsonText', () => {
  it('parses the tag text', () => {
    const text = JSON.stringify({ beatmaps: [row(), row({ id: 5752324, version: 'Rain' })] });
    expect(beatmapsFromJsonText(text)).toHaveLength(2);
  });

  it('never throws on missing or broken text', () => {
    for (const text of [undefined, '', '   ', '{', '{"beatmaps":', 'not json at all']) {
      expect(beatmapsFromJsonText(text), String(text)).toEqual([]);
    }
  });
});

describe('pickBeatmap', () => {
  const list: BeatmapInfo[] = [
    { id: 1, version: 'Easy' },
    { id: 2, version: 'Insane' },
    { id: 3, version: 'Expert' },
  ];

  it('picks by id, which is what a difficulty permalink gives us', () => {
    expect(pickBeatmap(list, 2)?.version).toBe('Insane');
  });

  it('gives up when an id is given but is not in the list', () => {
    // The set changed under us; a neighbouring difficulty is not an answer.
    expect(pickBeatmap(list, 99)).toBeUndefined();
  });

  it('picks the only difficulty when there is no id', () => {
    expect(pickBeatmap([{ id: 7, version: 'Hard' }])?.id).toBe(7);
  });

  it('gives up when there is no id and more than one difficulty', () => {
    // Which of nine difficulties a generalAll post is about is not something we can know.
    expect(pickBeatmap(list)).toBeUndefined();
  });

  it('gives up on an empty list', () => {
    expect(pickBeatmap([], 1)).toBeUndefined();
    expect(pickBeatmap([])).toBeUndefined();
  });
});

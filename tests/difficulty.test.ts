import { describe, expect, it } from 'vitest';
import {
  DIFFICULTIES,
  DIFFICULTY_LABEL_KEY,
  NAME_SCHEMES,
  detectDifficulty,
  difficultyFromName,
  difficultyFromStars,
  difficultyNameTable,
  isDifficulty,
  normalizeDifficultyName,
  normalizeMode,
  type BeatmapMode,
} from '../src/core/difficulty';
import type { Difficulty } from '../src/core/types';

/**
 * Picking a difficulty tier: the naming tables, the star ranges, and the detection order.
 *
 * The wiki's naming tables are transcribed a second time below (Ranking_criteria/
 * Difficulty_naming, read 2026-09) so a typo in a tier is caught. That copy is deliberate:
 * re-reading NAME_SCHEMES would only prove the code equals itself.
 *
 * The four names that two schemes disagree about (`basic`, `novice`, `ex`, `lunatic`) get
 * their own cases, because their answer comes from the order of NAME_SCHEMES and nothing
 * else -- and swapping two entries there is a one-line change that would otherwise pass
 * unnoticed.
 */

/** One scheme's slice of the wiki, transcribed from the article. */
const WIKI_TABLE: ReadonlyArray<{
  scheme: string;
  mode?: BeatmapMode;
  names: ReadonlyArray<[string, Difficulty]>;
}> = [
  {
    scheme: 'osuTaiko',
    mode: 'taiko',
    names: [
      ['Kantan', 'easy'],
      ['Futsuu', 'normal'],
      ['Muzukashii', 'hard'],
      ['Oni', 'insane'],
      ['Inner Oni', 'expert'],
      ['Shokyuu', 'easy'],
      ['Ura Oni', 'expert'],
      ['Hell Oni', 'expert'],
    ],
  },
  {
    scheme: 'osuCatch',
    mode: 'catch',
    names: [
      ['Cup', 'easy'],
      ['Salad', 'normal'],
      ['Platter', 'hard'],
      ['Rain', 'insane'],
      ['Overdose', 'expert'],
      ['Deluge', 'expert'],
    ],
  },
  {
    scheme: 'osu',
    names: [
      ['Easy', 'easy'],
      ['Normal', 'normal'],
      ['Hard', 'hard'],
      ['Insane', 'insane'],
      ['Expert', 'expert'],
      ['Beginner', 'easy'],
      ['Advanced', 'normal'],
      ['Hyper', 'hard'],
      ['Extra', 'expert'],
      ['Extreme', 'expert'],
    ],
  },
  {
    scheme: 'iidx',
    names: [
      ['Beginner', 'easy'],
      ['Normal', 'normal'],
      ['Hyper', 'hard'],
      ['Another', 'insane'],
      ['Black Another', 'expert'],
      ['Leggendaria', 'expert'],
    ],
  },
  {
    scheme: 'ddr',
    names: [
      ['Beginner', 'easy'],
      ['Basic', 'normal'],
      ['Difficult', 'hard'],
      ['Expert', 'insane'],
      ['Challenge', 'expert'],
    ],
  },
  {
    scheme: 'sdvx',
    names: [
      ['BASIC', 'easy'],
      ['BSC', 'easy'],
      ['NOVICE', 'normal'],
      ['NOV', 'normal'],
      ['ADVANCED', 'hard'],
      ['ADV', 'hard'],
      ['EXHAUST', 'insane'],
      ['EXH', 'insane'],
      ['INFINITE', 'expert'],
      ['INF', 'expert'],
      ['GRAVITY', 'expert'],
      ['GRV', 'expert'],
      ['MAXIMUM', 'expert'],
      ['MXM', 'expert'],
      ['ULTIMATE', 'expert'],
      ['ULT', 'expert'],
      ['HEAVENLY', 'expert'],
      ['HVN', 'expert'],
      ['VIVID', 'expert'],
      ['VVD', 'expert'],
      ['EXCEED', 'expert'],
      ['XCD', 'expert'],
    ],
  },
  {
    scheme: 'itg',
    names: [
      ['Novice', 'easy'],
      ['Easy', 'easy'],
      ['Medium', 'normal'],
      ['Hard', 'hard'],
      ['Expert', 'insane'],
    ],
  },
  {
    scheme: 'djmax',
    names: [
      ['EZ', 'easy'],
      ['NM', 'normal'],
      ['HD', 'hard'],
      ['MX', 'insane'],
      ['SC', 'expert'],
    ],
  },
  {
    scheme: 'ez2dj',
    names: [
      ['EZ', 'easy'],
      ['NM', 'normal'],
      ['HD', 'hard'],
      ['SHD', 'insane'],
      ['EX', 'expert'],
    ],
  },
  {
    scheme: 'popn',
    names: [
      ['Easy', 'easy'],
      ['Normal', 'normal'],
      ['Hyper', 'hard'],
      ['EX', 'insane'],
    ],
  },
  {
    scheme: 'arcaea',
    names: [
      ['Past', 'normal'],
      ['Present', 'hard'],
      ['Future', 'insane'],
      ['Eternal', 'expert'],
      ['Beyond', 'expert'],
    ],
  },
  {
    scheme: 'lanota',
    names: [
      ['Whisper', 'normal'],
      ['Acoustic', 'hard'],
      ['Ultra', 'insane'],
      ['Master', 'expert'],
    ],
  },
  {
    scheme: 'cytus',
    names: [
      ['Easy', 'easy'],
      ['Normal', 'normal'],
      ['Hard', 'hard'],
      ['Insane', 'insane'],
      ['Chaos', 'expert'],
      ['Glitch', 'expert'],
      ['Crash', 'expert'],
      ['Extra', 'expert'],
      ['Special', 'expert'],
    ],
  },
  {
    scheme: 'touhou',
    names: [
      ['Easy', 'easy'],
      ['Normal', 'normal'],
      ['Hard', 'hard'],
      ['Lunatic', 'insane'],
      ['Extra', 'expert'],
      ['Extra Stage', 'expert'],
      ['Phantasm', 'expert'],
    ],
  },
  {
    scheme: 'maimai',
    names: [
      ['EASY', 'easy'],
      ['BASIC', 'normal'],
      ['ADVANCED', 'hard'],
      ['EXPERT', 'insane'],
      ['MASTER', 'expert'],
      ['Re:MASTER', 'expert'],
      ['ULTIMA', 'expert'],
      ["WORLD'S END", 'expert'],
      ['LUNATIC', 'expert'],
    ],
  },
];

/**
 * Look a scheme up by id.
 *
 * @param id the scheme id
 * @returns the scheme's own name table
 */
function schemeNames(id: string): Readonly<Record<string, Difficulty>> {
  const scheme = NAME_SCHEMES.find((s) => s.id === id);
  if (!scheme) throw new Error(`no scheme named ${id}`);
  return scheme.names;
}

describe('difficulty tiers', () => {
  it('accepts exactly the five tiers', () => {
    for (const tier of DIFFICULTIES) expect(isDifficulty(tier)).toBe(true);
    expect(DIFFICULTIES).toHaveLength(5);
  });

  it('rejects anything else, including the right words in the wrong case', () => {
    for (const value of ['Easy', 'EXPERT', '', ' ', 'normal ', 3, null, undefined, ['easy']]) {
      expect(isDifficulty(value), String(value)).toBe(false);
    }
  });

  it('has a label key for every tier', () => {
    expect(Object.keys(DIFFICULTY_LABEL_KEY).sort()).toEqual([...DIFFICULTIES].sort());
  });
});

describe('the naming table matches the wiki', () => {
  it.each(WIKI_TABLE)('$scheme', ({ scheme, names }) => {
    const table = schemeNames(scheme);
    expect(Object.keys(table).sort()).toEqual(names.map(([name]) => name.toLowerCase()).sort());
    for (const [name, tier] of names) {
      expect(table[name.toLowerCase()], `${scheme}: ${name}`).toBe(tier);
    }
  });

  it('stores every entry pre-normalized, so no lookup can miss', () => {
    for (const scheme of NAME_SCHEMES) {
      for (const name of Object.keys(scheme.names)) {
        expect(normalizeDifficultyName(name), `${scheme.id}: ${name}`).toBe(name);
      }
    }
  });

  it('gives every scheme a distinct id', () => {
    const ids = NAME_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('names two schemes disagree about', () => {
  // Each of these is decided by the order of NAME_SCHEMES alone. Both readings are
  // defensible; these are the ones we settled on.
  it('takes the osu! reading over the borrowed one', () => {
    expect(difficultyFromName('Expert', 'osu')).toBe('expert'); // not DDR's / ITG's Insane
    expect(difficultyFromName('Advanced', 'osu')).toBe('normal'); // not SOUND VOLTEX's / maimai's Hard
  });

  it('takes the majority reading of Basic', () => {
    // DDR and maimai both call their second tier BASIC; SOUND VOLTEX calls its first one that.
    expect(difficultyFromName('BASIC')).toBe('normal');
  });

  it('takes the SOUND VOLTEX reading of Novice', () => {
    expect(difficultyFromName('Novice')).toBe('normal'); // In The Groove has it at Easy
  });

  it('takes the EZ2DJ reading of EX', () => {
    expect(difficultyFromName('EX')).toBe('expert'); // Pop'n Music has it at Insane
  });

  it('takes the Touhou reading of Lunatic', () => {
    expect(difficultyFromName('Lunatic')).toBe('insane'); // maimai has it at Expert
  });
});

describe('ruleset filtering', () => {
  it('keeps the taiko and catch names inside their own ruleset', () => {
    expect(difficultyFromName('Oni', 'taiko')).toBe('insane');
    expect(difficultyFromName('Oni', 'osu')).toBeUndefined();
    expect(difficultyFromName('Cup', 'catch')).toBe('easy');
    expect(difficultyFromName('Cup', 'mania')).toBeUndefined();
  });

  it('does not guess when the ruleset is unknown', () => {
    // A standard map with a jokey "Oni" difficulty must not read as taiko.
    expect(difficultyFromName('Oni')).toBeUndefined();
    expect(difficultyFromName('Overdose')).toBeUndefined();
    // The mode-independent names still resolve.
    expect(difficultyFromName('Insane')).toBe('insane');
  });

  it('keeps Inner Oni at Expert rather than Insane', () => {
    // The taiko list has five entries, and the fifth slot is Expert -- Ura Oni being the
    // "alternative to Inner Oni" and coloured expert is what confirms it.
    expect(difficultyFromName('Inner Oni', 'taiko')).toBe('expert');
  });

  it('merges every scheme without a ruleset instead of dropping them', () => {
    const table = difficultyNameTable();
    expect(table.size).toBeGreaterThan(50);
    expect(table.get('another')).toBe('insane');
    expect(table.get('master')).toBe('expert');
  });
});

describe('normalizeMode', () => {
  it.each([
    ['osu', 'osu'],
    ['OSU', 'osu'],
    ['taiko', 'taiko'],
    ['osu!taiko', 'taiko'],
    ['fruit', 'catch'],
    ['fruits', 'catch'],
    ['catch', 'catch'],
    ['osu!catch', 'catch'],
    ['mania', 'mania'],
    ['osu!mania', 'mania'],
    [' taiko ', 'taiko'],
  ] as const)('%s -> %s', (raw, expected) => {
    expect(normalizeMode(raw)).toBe(expected);
  });

  it('returns undefined for anything that is not a ruleset', () => {
    for (const raw of ['', 'standard', 'osu!lazer', undefined]) {
      expect(normalizeMode(raw), String(raw)).toBeUndefined();
    }
  });
});

describe('name normalization', () => {
  it('folds case, spacing and full-width forms', () => {
    expect(difficultyFromName(' INSANE ')).toBe('insane');
    expect(difficultyFromName('Insane')).toBe('insane');
    expect(difficultyFromName('ＩＮＳＡＮＥ')).toBe('insane');
    expect(difficultyFromName('Inner   Oni', 'taiko')).toBe('expert');
    expect(difficultyFromName('world’s end')).toBeUndefined(); // curly apostrophe is not folded
  });

  it('does not match on substrings or suffixes', () => {
    // A confident wrong answer is worse than falling through to the star rating.
    expect(difficultyFromName('Hardcore')).toBeUndefined();
    expect(difficultyFromName('Expert+')).toBeUndefined();
    expect(difficultyFromName('Note 2')).toBeUndefined();
    expect(difficultyFromName('https://4562.world/')).toBeUndefined();
    expect(difficultyFromName('')).toBeUndefined();
  });

  it('reads through a guest mapper credit', () => {
    // The most common shape of a collab difficulty name in the wild. These three are real
    // versions, off beatmapset 2340745.
    expect(difficultyFromName("Wonton's Extreme")).toBe('expert');
    expect(difficultyFromName("Charity's Another")).toBe('insane');
    expect(difficultyFromName('Yukarle’s Extra')).toBe('expert'); // curly apostrophe
  });

  it('still resolves nothing when the credit is all there is', () => {
    expect(difficultyFromName("Wonton's Revenge")).toBeUndefined();
    expect(difficultyFromName("Mochi's")).toBeUndefined();
    expect(difficultyFromName("Don't Stop")).toBeUndefined();
  });

  it('prefers the whole name over the credit-stripped one', () => {
    // The exact match is tried first, so a table entry can never be shadowed by stripping.
    expect(difficultyFromName('Extra')).toBe('expert');
    expect(difficultyFromName('ADVANCED')).toBe('normal');
  });
});

describe('star rating ranges', () => {
  it.each([
    [0, 'easy'],
    [1.99, 'easy'],
    [2, 'normal'],
    [2.69, 'normal'],
    [2.7, 'hard'],
    [3.99, 'hard'],
    [4, 'insane'],
    [5.29, 'insane'],
    [5.3, 'expert'],
    [6.49, 'expert'],
    [6.5, 'expert'], // the wiki's Expert+ folds into Expert, we only keep five tiers
    [12, 'expert'],
  ] as const)('%s stars -> %s', (stars, tier) => {
    expect(difficultyFromStars(stars)).toBe(tier);
  });

  it('refuses a rating that is not a usable number', () => {
    // A bare comparison would read NaN as Easy.
    for (const stars of [Number.NaN, Number.POSITIVE_INFINITY, -1, -0.1]) {
      expect(difficultyFromStars(stars), String(stars)).toBeUndefined();
    }
  });
});

describe('detectDifficulty', () => {
  it('takes the difficulty name when the table knows it', () => {
    // The name wins even though the stars alone would say Expert.
    expect(detectDifficulty({ version: 'Insane', stars: 6.2 })).toEqual({
      tier: 'insane',
      via: 'name',
    });
  });

  it('falls back to the star rating for a name nobody recognises', () => {
    const result = detectDifficulty({
      version: 'Disc: Rain (Girl EDM & non-binaries too)',
      stars: 4.25841,
      mode: 'fruits',
    });
    expect(result).toEqual({ tier: 'insane', via: 'stars', stars: 4.25841 });
  });

  it('works with only one of the two', () => {
    expect(detectDifficulty({ version: 'Overdose', mode: 'catch' })).toEqual({
      tier: 'expert',
      via: 'name',
    });
    expect(detectDifficulty({ stars: 1.2 })).toEqual({ tier: 'easy', via: 'stars', stars: 1.2 });
  });

  it('carries the star rating only on the star route', () => {
    expect(detectDifficulty({ version: 'Hyper', stars: 3 })).not.toHaveProperty('stars');
  });

  it('reads the name against the beatmap own ruleset', () => {
    expect(detectDifficulty({ version: 'Kantan', mode: 'taiko' })?.tier).toBe('easy');
    // Same name, a ruleset that has no such difficulty: falls through to the stars.
    expect(detectDifficulty({ version: 'Kantan', mode: 'osu', stars: 5.4 })).toEqual({
      tier: 'expert',
      via: 'stars',
      stars: 5.4,
    });
  });

  it('returns undefined when there is nothing to go on', () => {
    expect(detectDifficulty(undefined)).toBeUndefined();
    expect(detectDifficulty({})).toBeUndefined();
    expect(detectDifficulty({ version: 'https://4562.world/' })).toBeUndefined();
    expect(detectDifficulty({ version: 'Unnamed', stars: Number.NaN })).toBeUndefined();
  });
});

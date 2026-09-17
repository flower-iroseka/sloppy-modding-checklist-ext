/**
 * Difficulty tiers, and how one is picked for a beatmap (CODING_PLAN §8.6).
 *
 * Two routes, tried in this order:
 *   1. the difficulty name, matched against the osu! wiki's naming tables;
 *   2. the star rating, using the wiki's five level ranges.
 *
 * Pure module: no DOM, no network, no `t()`. The label map holds MessageKeys rather than
 * rendered text, so a stored value can't freeze the language it happened to be written in
 * (reasoning in `i18n/types.ts`).
 */

import type { MessageKey } from '../i18n';
import type { Difficulty } from './types';

/** The five tiers, easiest first. Also the display order of the picker. */
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'normal', 'hard', 'insane', 'expert'];

/**
 * Display name for a tier; a key, not a string, so translation happens when it's shown.
 * Same reasoning as `SCOPE_LABEL_KEY` in `cells.ts`.
 */
export const DIFFICULTY_LABEL_KEY: Record<Difficulty, MessageKey> = {
  easy: 'difficulty.easy',
  normal: 'difficulty.normal',
  hard: 'difficulty.hard',
  insane: 'difficulty.insane',
  expert: 'difficulty.expert',
};

/**
 * @param value the value to test
 * @returns whether it is one of the five tiers
 */
export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'string' && (DIFFICULTIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------- Ruleset

/** The four osu! rulesets. */
export type BeatmapMode = 'osu' | 'taiko' | 'catch' | 'mania';

/**
 * The spellings we accept for each ruleset.
 *
 * Three vocabularies collide here and they all have to work: the site's DOM (`data-mode` is
 * `osu` / `taiko` / `fruit` / `mania`), the embedded beatmapset JSON (`mode` is `fruits`,
 * with `mode_int` alongside it), and the wiki (`osu!taiko` / `osu!catch` / `osu!mania`).
 * The wiki form is handled by stripping its `osu!` prefix before this lookup.
 */
const MODE_BY_NAME: Record<string, BeatmapMode> = {
  osu: 'osu',
  taiko: 'taiko',
  catch: 'catch',
  fruit: 'catch',
  fruits: 'catch',
  mania: 'mania',
};

/**
 * @param raw a mode name from the page DOM or from a payload
 * @returns the ruleset; undefined when it isn't one of the four
 */
export function normalizeMode(raw: string | undefined): BeatmapMode | undefined {
  if (!raw) return undefined;
  return MODE_BY_NAME[raw.trim().toLowerCase().replace(/^osu!/, '')];
}

// ---------------------------------------------------------------- Difficulty names

/**
 * One naming scheme: either a ruleset's own set of names, or a scheme borrowed from another
 * game (the wiki lists those separately, and they're common on imports).
 */
export interface DifficultyNameScheme {
  /** Scheme name, for comments and test output. Nothing renders it. */
  id: string;
  /** Restricts the scheme to these rulesets; undefined means it applies to every mode. */
  modes?: readonly BeatmapMode[];
  /** Normalized difficulty name -> tier. A short form and its long form are separate keys. */
  names: Readonly<Record<string, Difficulty>>;
}

/**
 * Every scheme, in priority order: the first scheme that defines a name wins.
 *
 * The order isn't alphabetical and isn't by game age, because it *is* the collision policy:
 *
 *   1. taiko and catch first, each restricted to its own ruleset -- `Oni` and `Cup` are
 *      meaningless outside their mode, so a standard map with a jokey `Oni` difficulty must
 *      not be read as taiko;
 *   2. then osu!'s own words, which apply to every ruleset. This is what makes `Expert` mean
 *      Expert rather than DDR's Insane, and `Advanced` mean Normal rather than SOUND
 *      VOLTEX's Hard. osu!mania's defaults are these same five words, so it needs no entry;
 *   3. then the borrowed schemes, which can only supply names osu! doesn't have.
 *
 * Four names are still ambiguous -- two borrowed games use the same word for different
 * tiers, and osu! has no opinion either way. Their relative order here is the decision:
 *
 *   * `basic`   DDR -> normal, maimai -> normal, SOUND VOLTEX -> easy    -> normal
 *   * `novice`  SOUND VOLTEX -> normal, In The Groove -> easy            -> normal
 *   * `ex`      EZ2DJ -> expert, Pop'n Music -> insane                   -> expert
 *   * `lunatic` Touhou -> insane, maimai -> expert                       -> insane
 *
 * Swapping two entries flips an answer; `tests/difficulty.test.ts` pins all four.
 */
export const NAME_SCHEMES: readonly DifficultyNameScheme[] = [
  {
    id: 'osuTaiko',
    modes: ['taiko'],
    names: {
      kantan: 'easy',
      futsuu: 'normal',
      muzukashii: 'hard',
      oni: 'insane',
      'inner oni': 'expert',
      shokyuu: 'easy', // below Kantan
      'ura oni': 'expert', // alternative to Inner Oni
      'hell oni': 'expert', // above Inner Oni
    },
  },
  {
    id: 'osuCatch',
    modes: ['catch'],
    names: {
      cup: 'easy',
      salad: 'normal',
      platter: 'hard',
      rain: 'insane',
      overdose: 'expert',
      deluge: 'expert', // above Overdose
    },
  },
  {
    // osu! standard's defaults and alternatives, and osu!mania's defaults with them.
    id: 'osu',
    names: {
      easy: 'easy',
      normal: 'normal',
      hard: 'hard',
      insane: 'insane',
      expert: 'expert',
      beginner: 'easy', // below Easy
      advanced: 'normal', // between Normal and Hard
      hyper: 'hard', // between Hard and Insane
      extra: 'expert', // alternative to Expert
      extreme: 'expert', // above Expert
    },
  },
  {
    id: 'iidx',
    names: {
      beginner: 'easy',
      normal: 'normal',
      hyper: 'hard',
      another: 'insane',
      'black another': 'expert',
      leggendaria: 'expert',
    },
  },
  {
    id: 'ddr',
    names: {
      beginner: 'easy',
      basic: 'normal',
      difficult: 'hard',
      expert: 'insane',
      challenge: 'expert',
    },
  },
  {
    id: 'sdvx',
    names: {
      basic: 'easy',
      bsc: 'easy',
      novice: 'normal',
      nov: 'normal',
      advanced: 'hard',
      adv: 'hard',
      exhaust: 'insane',
      exh: 'insane',
      // Everything from EXHAUST up is expert or expert+, and we only keep five tiers.
      infinite: 'expert',
      inf: 'expert',
      gravity: 'expert',
      grv: 'expert',
      maximum: 'expert',
      mxm: 'expert',
      ultimate: 'expert',
      ult: 'expert',
      heavenly: 'expert',
      hvn: 'expert',
      vivid: 'expert',
      vvd: 'expert',
      exceed: 'expert',
      xcd: 'expert',
    },
  },
  {
    id: 'itg',
    names: {
      novice: 'easy',
      easy: 'easy',
      medium: 'normal',
      hard: 'hard',
      expert: 'insane',
    },
  },
  {
    id: 'djmax',
    names: { ez: 'easy', nm: 'normal', hd: 'hard', mx: 'insane', sc: 'expert' },
  },
  {
    id: 'ez2dj',
    names: { ez: 'easy', nm: 'normal', hd: 'hard', shd: 'insane', ex: 'expert' },
  },
  {
    id: 'popn',
    names: { easy: 'easy', normal: 'normal', hyper: 'hard', ex: 'insane' },
  },
  {
    id: 'arcaea',
    names: {
      past: 'normal',
      present: 'hard',
      future: 'insane',
      eternal: 'expert',
      beyond: 'expert',
    },
  },
  {
    id: 'lanota',
    names: { whisper: 'normal', acoustic: 'hard', ultra: 'insane', master: 'expert' },
  },
  {
    // Cytus, Deemo and VOEZ share the first four names.
    id: 'cytus',
    names: {
      easy: 'easy',
      normal: 'normal',
      hard: 'hard',
      insane: 'insane',
      chaos: 'expert', // Cytus
      glitch: 'expert', // Cytus
      crash: 'expert', // Cytus
      extra: 'expert', // Deemo
      special: 'expert', // VOEZ
    },
  },
  {
    id: 'touhou',
    names: {
      easy: 'easy',
      normal: 'normal',
      hard: 'hard',
      lunatic: 'insane',
      extra: 'expert',
      'extra stage': 'expert',
      phantasm: 'expert',
    },
  },
  {
    // Deliberately last: maimai, CHUNITHM and Ongeki reuse names other schemes already
    // claimed with a different tier (`LUNATIC` is expert here, insane in Touhou).
    id: 'maimai',
    names: {
      easy: 'easy',
      basic: 'normal',
      advanced: 'hard',
      expert: 'insane',
      master: 'expert',
      're:master': 'expert', // maimai
      ultima: 'expert', // CHUNITHM
      "world's end": 'expert', // CHUNITHM
      lunatic: 'expert', // Ongeki
    },
  },
];

/**
 * Normalize a difficulty name for table lookup.
 *
 * `normalize('NFKC')` folds the full-width `ＡＤＶＡＮＣＥＤ` that comes out of a Japanese IME
 * into plain ASCII. Nothing else is stripped: no punctuation removal, no suffix trimming, so
 * `Expert+` stays unknown rather than being read as Expert.
 *
 * @param raw the difficulty name as the beatmap spells it
 * @returns the lookup key
 */
export function normalizeDifficultyName(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Merged tables, one per mode, built lazily and kept. */
const tableCache = new Map<string, ReadonlyMap<string, Difficulty>>();

/**
 * The merged "difficulty name -> tier" table for one ruleset.
 *
 * @param mode the ruleset; undefined skips the ruleset-specific schemes, so their names
 *   (`Oni`, `Cup`) stay unknown rather than being guessed at
 * @returns the table, shared for the lifetime of the page
 */
export function difficultyNameTable(mode?: BeatmapMode): ReadonlyMap<string, Difficulty> {
  const key = mode ?? '*';
  const cached = tableCache.get(key);
  if (cached) return cached;

  const table = new Map<string, Difficulty>();
  for (const scheme of NAME_SCHEMES) {
    if (scheme.modes && (mode === undefined || !scheme.modes.includes(mode))) continue;
    for (const [name, tier] of Object.entries(scheme.names)) {
      // First scheme to define a name keeps it: that's the whole collision policy.
      if (!table.has(name)) table.set(name, tier);
    }
  }

  tableCache.set(key, table);
  return table;
}

/**
 * A guest mapper's credit in front of a difficulty name: `Kagari's Insane`, `Wonton's Extra`.
 *
 * Both apostrophes are accepted, the straight one and the curly one the game's own text
 * often carries. Bounded so a name with no space after the apostrophe (`Don't`) isn't
 * mistaken for a preface.
 */
const GUEST_PREFIX = /^[^'’]{1,32}['’]s\s+/;

/**
 * @param name the difficulty name as the beatmap spells it
 * @param mode the ruleset, when it's known
 * @returns the tier; undefined when no scheme recognises the name
 */
export function difficultyFromName(name: string, mode?: BeatmapMode): Difficulty | undefined {
  const table = difficultyNameTable(mode);
  const normalized = normalizeDifficultyName(name);

  const exact = table.get(normalized);
  if (exact) return exact;

  // Guest difficulties are named `X's <tier>` and the tier word is doing the same job it
  // would on its own, so it's looked up once with the credit taken off. This is not fuzzy
  // matching: a prefix that isn't there leaves the name untouched, and `Wonton's Revenge`
  // resolves to nothing at all rather than to `Wonton`.
  const withoutGuest = normalized.replace(GUEST_PREFIX, '');
  return withoutGuest === normalized ? undefined : table.get(withoutGuest);
}

// ---------------------------------------------------------------- Star rating

/**
 * The wiki's difficulty levels by star rating, upper bound exclusive.
 *
 * Descending, so the lookup is "the first bound the rating reaches". The bounds are written
 * the way the wiki writes them (2.7, not 2.69) because the wiki's "2.0-2.69" is a display
 * convention for a value that's stored with more precision; half-open bounds reproduce it
 * exactly with no epsilon.
 *
 * The wiki has a sixth level above these, Expert+ at 6.5 and up. We only keep five tiers, so
 * it falls into Expert through the 5.3 bound.
 */
export const STAR_TIERS: ReadonlyArray<{ min: number; tier: Difficulty }> = [
  { min: 5.3, tier: 'expert' },
  { min: 4.0, tier: 'insane' },
  { min: 2.7, tier: 'hard' },
  { min: 2.0, tier: 'normal' },
  { min: 0, tier: 'easy' },
];

/**
 * @param stars the star rating
 * @returns the tier; undefined when the rating isn't a usable number (a NaN must not read
 *   as Easy, which is what a bare comparison would do)
 */
export function difficultyFromStars(stars: number): Difficulty | undefined {
  if (!Number.isFinite(stars) || stars < 0) return undefined;
  return STAR_TIERS.find((step) => stars >= step.min)?.tier;
}

// ---------------------------------------------------------------- Detection

/** What is known about the beatmap before the tier is decided. */
export interface DifficultyInput {
  /** The difficulty name (osu's `version` field). */
  version?: string;
  /** Star rating (`difficulty_rating`). */
  stars?: number;
  /** Ruleset: the beatmap's own mode when it's known, otherwise the page's. */
  mode?: string;
}

/** The chosen tier, plus how it was chosen -- the dialog says which route it took. */
export interface DetectedDifficulty {
  /** The tier. */
  tier: Difficulty;
  /** Which route produced it. */
  via: 'name' | 'stars';
  /** The rating the star route used, for the hint text. Only set on the star route. */
  stars?: number;
}

/**
 * Pick the tier for a beatmap: the difficulty name first, the star rating as the fallback.
 *
 * Most difficulty names in the wild are free text (`Disc: Rain (Girl EDM & non-binaries
 * too)`), so the star route is the common one, not the exception.
 *
 * @param input what is known about the beatmap
 * @returns the tier and the route; undefined when neither route had usable input
 */
export function detectDifficulty(
  input: DifficultyInput | undefined,
): DetectedDifficulty | undefined {
  if (!input) return undefined;

  const mode = normalizeMode(input.mode);
  if (input.version) {
    const byName = difficultyFromName(input.version, mode);
    if (byName) return { tier: byName, via: 'name' };
  }

  if (input.stars !== undefined) {
    const byStars = difficultyFromStars(input.stars);
    if (byStars) return { tier: byStars, via: 'stars', stars: input.stars };
  }

  return undefined;
}

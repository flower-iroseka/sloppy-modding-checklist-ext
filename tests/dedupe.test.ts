import { describe, expect, it } from 'vitest';
import { emptyCells } from '../src/core/cells';
import { findDuplicate, findByLink, linksOverlap, normalizeUrl } from '../src/core/dedupe';
import type { ChecklistEntry } from '../src/core/types';

/**
 * Link dedupe: normalizeUrl, findByLink, findDuplicate and linksOverlap across all four
 * cells.
 *
 * The lookups only read an entry's id and links, so `entry` builds a minimal one rather
 * than going through the store.
 */

/**
 * Build a minimal entry with only the fields the dedupe lookup cares about.
 *
 * @param id entry id, also used as the summary
 * @param links the entry's links
 * @returns a general / internal entry with both timestamps set to 0
 */
const entry = (id: string, links: string[]): ChecklistEntry => ({
  id,
  scope: 'general',
  source: 'internal',
  summary: id,
  links,
  createdAt: 0,
  updatedAt: 0,
});

describe('normalizeUrl', () => {
  it('去掉首尾空白、末尾斜杠与 hash', () => {
    expect(normalizeUrl('  https://osu.ppy.sh/beatmapsets/1/discussion/2#513  ')).toBe(
      'https://osu.ppy.sh/beatmapsets/1/discussion/2',
    );
    expect(normalizeUrl('https://example.com/a/')).toBe('https://example.com/a');
  });
});

describe('去重查找', () => {
  // Fill only two of the four cells and leave the other two empty: that also catches a
  // lookup which skips a cell or runs off the end
  const cells = emptyCells();
  cells['general-internal'] = [entry('e1', ['https://osu.ppy.sh/beatmapsets/1/discussion/2'])];
  cells['individual-external'] = [entry('e2', ['https://example.com/pattern'])];

  it('findByLink 跨四格命中并忽略末尾斜杠/hash 差异', () => {
    expect(findByLink(cells, 'https://osu.ppy.sh/beatmapsets/1/discussion/2/#513')?.id).toBe('e1');
    expect(findByLink(cells, 'https://example.com/pattern/')?.id).toBe('e2');
    expect(findByLink(cells, 'https://nope.example/x')).toBeNull();
  });

  it('findDuplicate 命中任意一条链接', () => {
    expect(findDuplicate(cells, ['https://nope.example/x', 'https://example.com/pattern'])?.id).toBe('e2');
    expect(findDuplicate(cells, ['https://nope.example/x'])).toBeNull();
  });

  it('linksOverlap 空数组不视为重复', () => {
    expect(linksOverlap([], ['a'])).toBe(false);
    expect(linksOverlap(['a'], [])).toBe(false);
    expect(linksOverlap(['https://a/'], ['https://a'])).toBe(true);
  });
});

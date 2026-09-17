import { describe, expect, it } from 'vitest';
import { trapTarget } from '../src/components/focusTrap';

/**
 * Edge cases for `trapTarget` (CODING_PLAN §5.3).
 *
 * The function only compares identity and wraps around, so empty objects standing in for
 * elements are enough -- no DOM needed. The half that really touches the DOM (the
 * filtering in `focusablesIn`) is covered by `scripts/smoke-m8.mjs` in a real browser.
 */

/**
 * Make a fake element. `trapTarget` only compares identity and never touches anything on
 * the element.
 *
 * @param name only used to tell elements apart on failure; the function itself doesn't read it
 * @returns a plain object cast to HTMLElement
 */
const el = (name: string) => ({ name }) as unknown as HTMLElement;

/**
 * Turn a list of elements into names, so assertions and failures read better.
 *
 * @param list the elements to take names from
 * @returns an array of names, in the same order as the input
 */
const names = (list: readonly HTMLElement[]) => list.map((e) => (e as unknown as { name: string }).name);

const A = el('A');
const B = el('B');
const C = el('C');
const OUTSIDE = el('outside');
const THREE = [A, B, C];

/**
 * Run `trapTarget` once and turn the result into a name.
 *
 * @param list the focusable elements in the panel, in document order
 * @param active the currently focused element; null means focus hasn't come in yet or has left
 * @param shift whether this is Shift+Tab
 * @returns the name of the target element when it should take over; undefined when it lets the event through
 */
function target(list: readonly HTMLElement[], active: Element | null, shift: boolean) {
  const t = trapTarget(list, active, shift);
  return t === undefined ? undefined : names([t])[0];
}

describe('trapTarget', () => {
  it('lets the event through when the panel has no focusable element', () => {
    expect(target([], A, false)).toBeUndefined();
    expect(target([], A, true)).toBeUndefined();
  });

  // Middle positions must pass through: the browser's own Tab order still knows about
  // focus outside the panel, and only the two ends are ours to handle.
  it('focus in the middle: both directions pass through', () => {
    expect(target(THREE, B, false)).toBeUndefined();
    expect(target(THREE, B, true)).toBeUndefined();
  });

  it('focus on the last element, Tab -> back to the first', () => {
    expect(target(THREE, C, false)).toBe('A');
  });

  it('focus on the first element, Shift+Tab -> jump to the last', () => {
    expect(target(THREE, A, true)).toBe('C');
  });

  // The other side of the same thing: these two must not be taken over. If the previous
  // test had been written as "always wrap to the first", these two would fail.
  it('Tab on the first and Shift+Tab on the last are both left alone', () => {
    expect(target(THREE, A, false)).toBeUndefined();
    expect(target(THREE, C, true)).toBeUndefined();
  });

  it('with a single focusable element, both directions wrap back to it', () => {
    expect(target([A], A, false)).toBe('A');
    expect(target([A], A, true)).toBe('A');
  });

  // "Focus escaping the overlay" is the whole reason this thing exists, so it's the
  // one case this file should nail down hardest.
  it('focus already outside the panel (or not in yet) -> pulled back to the ends by direction', () => {
    expect(target(THREE, OUTSIDE, false)).toBe('A');
    expect(target(THREE, OUTSIDE, true)).toBe('C');
    expect(target(THREE, null, false)).toBe('A');
    expect(target(THREE, null, true)).toBe('C');
  });

  it('single element + focus outside -> pulled back to it', () => {
    expect(target([A], null, false)).toBe('A');
    expect(target([A], null, true)).toBe('A');
  });
});

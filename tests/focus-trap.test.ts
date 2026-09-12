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
  it('面板里一个可聚焦元素都没有时不拦', () => {
    expect(target([], A, false)).toBeUndefined();
    expect(target([], A, true)).toBeUndefined();
  });

  // Middle positions must pass through: the browser's own Tab order still knows about
  // focus outside the panel, and only the two ends are ours to handle.
  it('焦点在中间：两个方向都放行', () => {
    expect(target(THREE, B, false)).toBeUndefined();
    expect(target(THREE, B, true)).toBeUndefined();
  });

  it('焦点在最后一个再按 Tab → 回到第一个', () => {
    expect(target(THREE, C, false)).toBe('A');
  });

  it('焦点在第一个再按 Shift+Tab → 跳到最后一个', () => {
    expect(target(THREE, A, true)).toBe('C');
  });

  // The other side of the same thing: these two must not be taken over. If the previous
  // test had been written as "always wrap to the first", these two would fail.
  it('焦点在第一个按 Tab、在最后一个按 Shift+Tab 都不接管', () => {
    expect(target(THREE, A, false)).toBeUndefined();
    expect(target(THREE, C, true)).toBeUndefined();
  });

  it('只有一个可聚焦元素时，两个方向都回绕到它自己', () => {
    expect(target([A], A, false)).toBe('A');
    expect(target([A], A, true)).toBe('A');
  });

  // "Focus escaping the overlay" is the whole reason this thing exists, so it's the
  // one case this file should nail down hardest.
  it('焦点已经不在面板里（或还没进来）→ 按方向拉回两端', () => {
    expect(target(THREE, OUTSIDE, false)).toBe('A');
    expect(target(THREE, OUTSIDE, true)).toBe('C');
    expect(target(THREE, null, false)).toBe('A');
    expect(target(THREE, null, true)).toBe('C');
  });

  it('单个元素 + 焦点在外面 → 拉回到它', () => {
    expect(target([A], null, false)).toBe('A');
    expect(target([A], null, true)).toBe('A');
  });
});

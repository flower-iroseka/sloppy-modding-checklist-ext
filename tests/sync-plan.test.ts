import { describe, expect, it } from 'vitest';
import { canonicalJson, planPull, planPush, type SyncSide } from '../src/core/sync/plan';
import type { SyncStrategy } from '../src/core/sync/types';
import { renderMsg } from '../src/i18n';

/**
 * planPull / planPush: what to do given the two sides' timestamps and content.
 *
 * The interesting cases are the ones that have to come out deterministic -- a timestamp
 * tie with different content, or a newer remote under local-wins -- because auto-sync
 * calls this in a loop and any "maybe" would stall it there forever.
 */

/**
 * Build one side's comparison basis. The body just holds a single tag, enough to tell
 * whether the two sides are the same copy.
 *
 * @param updatedAt this side's timestamp
 * @param tag the marker stuffed into the json; a different tag means different content
 * @returns a side you can feed straight to planPull / planPush
 */
function side(updatedAt: number, tag: string): SyncSide {
  return { updatedAt, json: `{"tag":"${tag}"}` };
}

const STRATEGIES: SyncStrategy[] = ['newest-wins', 'local-wins', 'remote-wins', 'ask'];

describe('canonicalJson', () => {
  it('the same content with a different key order serializes the same', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('objects nested in objects and inside arrays are sorted too', () => {
    const a = { cells: [{ z: 1, a: 2 }], meta: { y: 1, x: 2 } };
    const b = { meta: { x: 2, y: 1 }, cells: [{ a: 2, z: 1 }] };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('array order still matters (the in-cell order is what the user dragged)', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('different values stay different', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});

describe('planPull', () => {
  it('no remote file -> none, with a prompt to upload', () => {
    const plan = planPull(side(100, 'l'), null, 'newest-wins');
    expect(plan.direction).toBe('none');
    // `reason` is a `Msg` (since M9, see i18n/types.ts): the core layer only says
    // "which phrase + what params", and turning it into text happens at display time,
    // so here we render first and then look for the word.
    expect(renderMsg(plan.reason!, 'zh')).toContain('上传');
  });

  // The `json` this layer receives has already been through canonicalJson, so key-order
  // differences don't exist here (the manager does the normalizing, see "different key order
  // but same content" in sync-manager.test.ts).
  it('same content -> none, even if the remote timestamp is newer', () => {
    const local: SyncSide = { updatedAt: 100, json: '{"a":1,"b":2}' };
    const remote: SyncSide = { updatedAt: 900, json: '{"a":1,"b":2}' };
    expect(planPull(local, remote, 'newest-wins').direction).toBe('none');
  });

  it('remote is newer -> pull', () => {
    expect(planPull(side(100, 'l'), side(200, 'r'), 'newest-wins').direction).toBe('pull');
  });

  it('local is newer -> no pull back', () => {
    expect(planPull(side(200, 'l'), side(100, 'r'), 'remote-wins').direction).toBe('none');
  });

  // Equal timestamps, different content: all three "automatic" strategies must give a
  // deterministic answer, otherwise auto-sync would be stuck on this case forever.
  it('a timestamp tie (different content) still gives every strategy a definite answer', () => {
    const local = side(100, 'l');
    const remote = side(100, 'r');
    const got = Object.fromEntries(
      STRATEGIES.map((s) => [s, planPull(local, remote, s).direction]),
    );
    expect(got).toEqual({
      'newest-wins': 'pull', // a tie goes to the remote
      'local-wins': 'none',
      'remote-wins': 'pull',
      ask: 'ask',
    });
  });

  it('on a tie, newest-wins gives the same result no matter how many times it is called', () => {
    const local = side(100, 'l');
    const remote = side(100, 'r');
    expect(planPull(local, remote, 'newest-wins').direction).toBe(
      planPull(local, remote, 'newest-wins').direction,
    );
  });
});

describe('planPush', () => {
  it('no remote file -> create one', () => {
    expect(planPush(side(100, 'l'), null, 'ask').direction).toBe('push');
  });

  it('same content -> none (no pointless upload)', () => {
    const local: SyncSide = { updatedAt: 100, json: '{"a":1,"b":2}' };
    const remote: SyncSide = { updatedAt: 900, json: '{"a":1,"b":2}' };
    expect(planPush(local, remote, 'ask').direction).toBe('none');
  });

  it('local is newer -> push', () => {
    expect(planPush(side(200, 'l'), side(100, 'r'), 'newest-wins').direction).toBe('push');
  });

  it('remote newer + local-wins -> push anyway (the user picked this strategy explicitly)', () => {
    const plan = planPush(side(100, 'l'), side(200, 'r'), 'local-wins');
    expect(plan.direction).toBe('push');
    expect(renderMsg(plan.reason!, 'zh')).toContain('本地优先');
  });

  it('remote newer + any other strategy -> ask (must not quietly overwrite the other side)', () => {
    for (const s of ['newest-wins', 'remote-wins', 'ask'] as SyncStrategy[]) {
      expect(planPush(side(100, 'l'), side(200, 'r'), s).direction).toBe('ask');
    }
  });
});

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
  it('键序不同的同一份内容序列化结果相同', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('嵌套对象与数组里的对象也要排序', () => {
    const a = { cells: [{ z: 1, a: 2 }], meta: { y: 1, x: 2 } };
    const b = { meta: { x: 2, y: 1 }, cells: [{ a: 2, z: 1 }] };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('数组顺序仍然有意义（格内顺序是用户拖出来的）', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('值不同就不同', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 2 }));
  });
});

describe('planPull', () => {
  it('远端没有文件 → none，并提示去上传', () => {
    const plan = planPull(side(100, 'l'), null, 'newest-wins');
    expect(plan.direction).toBe('none');
    // `reason` is a `Msg` (since M9, see i18n/types.ts): the core layer only says
    // "which phrase + what params", and turning it into text happens at display time,
    // so here we render first and then look for the word.
    expect(renderMsg(plan.reason!, 'zh')).toContain('上传');
  });

  // The `json` this layer receives has already been through canonicalJson, so key-order
  // differences don't exist here (the manager does the normalizing, see "键序不同但内容一致"
  // in sync-manager.test.ts).
  it('内容相同 → none，哪怕远端时间戳更新', () => {
    const local: SyncSide = { updatedAt: 100, json: '{"a":1,"b":2}' };
    const remote: SyncSide = { updatedAt: 900, json: '{"a":1,"b":2}' };
    expect(planPull(local, remote, 'newest-wins').direction).toBe('none');
  });

  it('远端更新 → pull', () => {
    expect(planPull(side(100, 'l'), side(200, 'r'), 'newest-wins').direction).toBe('pull');
  });

  it('本地更新 → 不往回拉', () => {
    expect(planPull(side(200, 'l'), side(100, 'r'), 'remote-wins').direction).toBe('none');
  });

  // Equal timestamps, different content: all three "automatic" strategies must give a
  // deterministic answer, otherwise auto-sync would be stuck on this case forever.
  it('时间戳打平（内容不同）时各策略都有确定结果', () => {
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

  it('打平时 newest-wins 的结果不随调用次数变化', () => {
    const local = side(100, 'l');
    const remote = side(100, 'r');
    expect(planPull(local, remote, 'newest-wins').direction).toBe(
      planPull(local, remote, 'newest-wins').direction,
    );
  });
});

describe('planPush', () => {
  it('远端没有文件 → 直接建一份', () => {
    expect(planPush(side(100, 'l'), null, 'ask').direction).toBe('push');
  });

  it('内容相同 → none（不用白传一遍）', () => {
    const local: SyncSide = { updatedAt: 100, json: '{"a":1,"b":2}' };
    const remote: SyncSide = { updatedAt: 900, json: '{"a":1,"b":2}' };
    expect(planPush(local, remote, 'ask').direction).toBe('none');
  });

  it('本地更新 → push', () => {
    expect(planPush(side(200, 'l'), side(100, 'r'), 'newest-wins').direction).toBe('push');
  });

  it('远端更新 + 本地优先 → 照传（用户明确选了这个策略）', () => {
    const plan = planPush(side(100, 'l'), side(200, 'r'), 'local-wins');
    expect(plan.direction).toBe('push');
    expect(renderMsg(plan.reason!, 'zh')).toContain('本地优先');
  });

  it('远端更新 + 其余策略 → ask（不能安静地覆盖掉那边的改动）', () => {
    for (const s of ['newest-wins', 'remote-wins', 'ask'] as SyncStrategy[]) {
      expect(planPush(side(100, 'l'), side(200, 'r'), s).direction).toBe('ask');
    }
  });
});

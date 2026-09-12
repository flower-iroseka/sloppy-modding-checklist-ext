import { beforeEach, describe, expect, it } from 'vitest';
import { totalCount } from '../src/core/cells';
import { checklistStore } from '../src/core/store';
import { resetStore } from './helpers';

/**
 * Store CRUD: addEntry, updateEntry, removeEntry, moveEntry and clearAll.
 *
 * Where an entry ends up is the part worth pinning down -- which cell, which index, and
 * that changing scope/source moves it between cells -- so most cases assert on the cell
 * contents rather than on the returned entry.
 */

/** Read the store's current state, so we don't have to write checklistStore.getState() everywhere. */
function s() {
  return checklistStore.getState();
}

describe('store CRUD', () => {
  beforeEach(() => {
    resetStore();
  });

  it('addEntry 落到对应格子并生成 id / 时间戳', () => {
    const entry = s().addEntry({
      scope: 'general',
      source: 'internal',
      summary: 'Jumps are harder than the chorus',
      links: ['https://osu.ppy.sh/beatmapsets/1/discussion/2'],
    });

    expect(entry.id).toBeTruthy();
    expect(entry.createdAt).toBeGreaterThan(0);
    expect(s().doc.cells['general-internal']).toHaveLength(1);
    expect(s().doc.cells['general-internal'][0]!.summary).toContain('Jumps');
    expect(totalCount(s().doc.cells)).toBe(1);
  });

  it('四个格子各自独立计数', () => {
    s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    s().addEntry({ scope: 'general', source: 'external', summary: 'b' });
    s().addEntry({ scope: 'individual', source: 'external', summary: 'c' });

    expect(s().doc.cells['general-internal']).toHaveLength(1);
    expect(s().doc.cells['general-external']).toHaveLength(1);
    expect(s().doc.cells['individual-internal']).toHaveLength(0);
    expect(s().doc.cells['individual-external']).toHaveLength(1);
    expect(totalCount(s().doc.cells)).toBe(3);
  });

  it('updateEntry 修改字段但保持位置', () => {
    const a = s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    s().addEntry({ scope: 'general', source: 'internal', summary: 'b' });

    s().updateEntry(a.id, { summary: 'a2', note: '备注' });

    const list = s().doc.cells['general-internal'];
    expect(list.map((e) => e.summary)).toEqual(['a2', 'b']);
    expect(list[0]!.note).toBe('备注');
  });

  it('updateEntry 改 scope/source 时搬到目标格', () => {
    const a = s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });

    s().updateEntry(a.id, { scope: 'individual', source: 'external' });

    expect(s().doc.cells['general-internal']).toHaveLength(0);
    expect(s().doc.cells['individual-external']).toHaveLength(1);
    expect(s().doc.cells['individual-external'][0]!.scope).toBe('individual');
    expect(s().doc.cells['individual-external'][0]!.source).toBe('external');
  });

  it('removeEntry 删除指定条目', () => {
    const a = s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    s().addEntry({ scope: 'general', source: 'internal', summary: 'b' });

    s().removeEntry(a.id);

    expect(s().doc.cells['general-internal'].map((e) => e.summary)).toEqual(['b']);
  });

  it('moveEntry 跨格移动：更新 scope/source 并插入目标下标', () => {
    const a = s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    s().addEntry({ scope: 'individual', source: 'external', summary: 'x' });
    s().addEntry({ scope: 'individual', source: 'external', summary: 'y' });

    s().moveEntry(a.id, 'individual-external', 1);

    expect(s().doc.cells['general-internal']).toHaveLength(0);
    const dst = s().doc.cells['individual-external'];
    expect(dst.map((e) => e.summary)).toEqual(['x', 'a', 'y']);
    expect(dst[1]!.scope).toBe('individual');
    expect(dst[1]!.source).toBe('external');
  });

  it('moveEntry 同格重排', () => {
    const a = s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    s().addEntry({ scope: 'general', source: 'internal', summary: 'b' });
    s().addEntry({ scope: 'general', source: 'internal', summary: 'c' });

    s().moveEntry(a.id, 'general-internal', 2);

    expect(s().doc.cells['general-internal'].map((e) => e.summary)).toEqual(['b', 'c', 'a']);
  });

  it('moveEntry 空 id 不改变文档', () => {
    s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    const before = s().doc;

    s().moveEntry('missing-id', 'individual-external');

    expect(s().doc).toBe(before);
  });

  it('clearAll 清空但保留 deviceId', () => {
    s().addEntry({ scope: 'general', source: 'internal', summary: 'a' });
    const deviceId = s().doc.deviceId;

    s().clearAll();

    expect(totalCount(s().doc.cells)).toBe(0);
    expect(s().doc.deviceId).toBe(deviceId);
  });
});

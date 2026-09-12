import { describe, expect, it } from 'vitest';
import { totalCount } from '../src/core/cells';
import { createEmptyDoc, DocValidationError } from '../src/core/doc';
import { exportFileName, mergeDocs, parseDocJson, serializeDoc } from '../src/core/exchange';
import type { ChecklistDoc, NewEntryInput } from '../src/core/types';

/**
 * Export and import: serializeDoc + parseDocJson round-tripping, and mergeDocs.
 *
 * Parsing is where a hand-edited or older file comes in, so most of the file is about
 * bad input -- which entries get dropped and counted, and which files are rejected
 * outright instead of loading half of the document.
 */

/**
 * Build a doc from "which cell gets what".
 *
 * @param entries each item pairs a target cell with the NewEntryInput to put there
 * @returns the built doc, with entry ids generated in insertion order as e1, e2, ...
 */
function docWith(entries: Array<{ cell: 'general-internal' | 'general-external' | 'individual-internal' | 'individual-external'; input: NewEntryInput }>): ChecklistDoc {
  const doc = createEmptyDoc('d-1', 1_000);
  let n = 0;
  for (const { cell, input } of entries) {
    const now = 1_000 + n++;
    doc.cells[cell].push({
      id: `e${n}`,
      scope: input.scope,
      source: input.source,
      summary: input.summary,
      links: input.links ?? [],
      createdAt: now,
      updatedAt: now,
    });
  }
  return doc;
}

describe('导出 / 导入', () => {
  it('serialize → parse 往返一致', () => {
    const doc = docWith([
      {
        cell: 'general-internal',
        input: {
          scope: 'general',
          source: 'internal',
          summary: 'Jumps 偏难',
          links: ['https://osu.ppy.sh/beatmapsets/1/discussion/2'],
          note: '备注',
          sourceAuthor: { username: 'Electoz', id: 123 },
          meta: { beatmapsetId: 1, mode: 'mania' },
        },
      },
      {
        cell: 'individual-external',
        input: { scope: 'individual', source: 'external', summary: 'pattern 2 的间距', links: [] },
      },
    ]);

    const { doc: parsed, dropped } = parseDocJson(serializeDoc(doc));

    expect(dropped).toBe(0);
    expect(parsed).toEqual(doc);
  });

  it('非法 JSON / 版本过高 / 缺 cells 均抛 DocValidationError', () => {
    expect(() => parseDocJson('{ not json')).toThrow(DocValidationError);
    expect(() => parseDocJson('{"schemaVersion":99,"cells":{}}')).toThrow(DocValidationError);
    expect(() => parseDocJson('{"schemaVersion":1}')).toThrow(DocValidationError);
  });

  it('丢弃结构非法的条目并计数，缺格补齐', () => {
    const text = JSON.stringify({
      schemaVersion: 1,
      deviceId: 'd-x',
      updatedAt: 5,
      cells: {
        'general-internal': [
          { id: 'ok', scope: 'general', source: 'internal', summary: 'good', links: ['a'] },
          { id: 'bad', scope: 'nope', source: 'internal', summary: 'bad scope' },
          { id: 'bad2', scope: 'general', source: 'internal' }, // missing summary
          'not-an-object',
        ],
      },
    });

    const { doc, dropped } = parseDocJson(text);

    expect(dropped).toBe(3);
    expect(doc.cells['general-internal']).toHaveLength(1);
    expect(doc.cells['individual-external']).toEqual([]);
  });

  it('merge：新增不重复的条目，跳过 id 重复与链接重复', () => {
    const base = docWith([
      {
        cell: 'general-internal',
        input: { scope: 'general', source: 'internal', summary: 'A', links: ['https://a/1'] },
      },
    ]);
    const incoming = {
      ...base,
      updatedAt: 9,
      cells: {
        ...base.cells,
        'general-internal': [
          { ...base.cells['general-internal'][0]! }, // both id and link are duplicates
          {
            id: 'new-1',
            scope: 'general' as const,
            source: 'internal' as const,
            summary: 'B',
            links: ['https://b/2'],
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'new-2',
            scope: 'general' as const,
            source: 'internal' as const,
            summary: 'C 链接重复',
            links: ['https://a/1/'],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        'individual-external': [
          {
            id: 'new-3',
            scope: 'individual' as const,
            source: 'external' as const,
            summary: 'D',
            links: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    };

    const { doc, added, skipped } = mergeDocs(base, incoming);

    expect(added).toBe(2);
    expect(skipped).toBe(2);
    expect(doc.cells['general-internal'].map((e) => e.summary)).toEqual(['A', 'B']);
    expect(doc.cells['individual-external'].map((e) => e.summary)).toEqual(['D']);
    expect(doc.deviceId).toBe('d-1'); // the base doc's deviceId wins
    expect(totalCount(doc.cells)).toBe(3);
  });

  it('exportFileName 形如 modding-checklist-YYYYMMDD.json', () => {
    expect(exportFileName(new Date(2026, 8, 10))).toBe('modding-checklist-20260910.json');
  });
});

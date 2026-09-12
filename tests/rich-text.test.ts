import { describe, expect, it } from 'vitest';
import { splitBold, stripBold } from '../src/i18n/richText';
import { renderKey, renderKeyMarkup } from '../src/i18n';

/**
 * The inline `**bold**` markers in the catalog (CODING_PLAN §14).
 *
 * Two guards, both for failures that stay silent. The default path (`renderKey` / `t`)
 * must never emit `**`, or a pair of asterisks shows up in the UI where only a person
 * would notice it. The markup path has to cut the markers out and hand the pieces to
 * `<RichText>`; if it breaks, the bold is simply gone.
 */

/**
 * Stitch the split segments back into a whole sentence, wrapping bold in `<b>`.
 *
 * @param text the source text with `**` markers
 * @returns the assembled string, so a failure shows at a glance where the split went wrong
 */
function rejoin(text: string): string {
  return splitBold(text)
    .map((s) => (s.bold ? `<b>${s.text}</b>` : s.text))
    .join('');
}

describe('stripBold', () => {
  it('去掉成对的标记，只留文字', () => {
    expect(stripBold('点 **Submit** 才算数')).toBe('点 Submit 才算数');
  });

  it('落单的标记照样去掉', () => {
    // Either the translator broke the pair or there was a lone `**` to begin with. Losing
    // the emphasis beats letting asterisks leak into the user's face: seeing "**Submit" is
    // much worse than not seeing bold.
    expect(stripBold('**没配平的标记')).toBe('没配平的标记');
    expect(stripBold('没配平的标记**')).toBe('没配平的标记');
  });

  it('单个 `*` 不是我们的标记，不动它', () => {
    expect(stripBold('a * b **粗** c')).toBe('a * b 粗 c');
  });

  it('没有标记时原样返回', () => {
    expect(stripBold('一句普通的话')).toBe('一句普通的话');
  });
});

describe('splitBold', () => {
  it('没有标记时只给一段、且不加粗', () => {
    expect(splitBold('一句普通的话')).toEqual([{ text: '一句普通的话', bold: false }]);
  });

  it('空串给空数组（`<RichText>` 据此渲染 null）', () => {
    expect(splitBold('')).toEqual([]);
  });

  it('句中加粗：切成三段', () => {
    expect(rejoin('勾完必须点 **Submit**，只勾不提交等于没配。')).toBe(
      '勾完必须点 <b>Submit</b>，只勾不提交等于没配。',
    );
  });

  it('一句里有两处加粗', () => {
    expect(rejoin('**甲**和**乙**')).toBe('<b>甲</b>和<b>乙</b>');
  });

  it('整句加粗', () => {
    expect(rejoin('**整句**')).toBe('<b>整句</b>');
  });

  it('加粗在句首或句尾时不产生空段', () => {
    // An empty segment makes `<RichText>` render an extra empty sibling node, which is
    // harmless in React, but it's a sign that the split went wrong -- so pin down here
    // that it never happens.
    expect(splitBold('**头**后面')).toEqual([
      { text: '头', bold: true },
      { text: '后面', bold: false },
    ]);
    expect(splitBold('前面**尾**')).toEqual([
      { text: '前面', bold: false },
      { text: '尾', bold: true },
    ]);
  });

  it('两处加粗中间隔着一个空段时不留空串', () => {
    expect(splitBold('**甲****乙**')).toEqual([
      { text: '甲', bold: true },
      { text: '乙', bold: true },
    ]);
  });

  it('没配平的标记落在普通段里，会被顺手剥掉', () => {
    // This is the division of labor between `splitBold` and `stripBold`: do the safety net
    // at the same time as the split, so a key going through RichText doesn't leak
    // asterisks because its markers were broken.
    expect(rejoin('**开了头没有结尾')).toBe('开了头没有结尾');
  });
});

describe('默认渲染路径永远不吐出标记（保底）', () => {
  const KEY = 'help.dropbox.step2';

  it('renderKey 剥掉标记', () => {
    expect(renderKey(KEY, undefined, 'zh')).not.toContain('**');
    expect(renderKey(KEY, undefined, 'en')).not.toContain('**');
  });

  it('renderKeyMarkup 保留标记，给 `<RichText>` 切段', () => {
    expect(renderKeyMarkup(KEY, undefined, 'zh')).toContain('**');
    expect(renderKeyMarkup(KEY, undefined, 'en')).toContain('**');
  });

  it('两条路除了标记之外**一字不差**', () => {
    // Drift means "the text in the UI" and "the text in the README" start telling different
    // stories, and readme.test.ts compares the markup path.
    for (const key of ['help.dropbox.step1', 'help.dropbox.step2', 'err.folder.notAFile'] as const) {
      for (const locale of ['zh', 'en'] as const) {
        expect(stripBold(renderKeyMarkup(key, undefined, locale)), `${key} / ${locale}`).toBe(
          renderKey(key, undefined, locale),
        );
      }
    }
  });
});

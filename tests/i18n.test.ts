import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetLocaleForTest,
  detectLocale,
  getLocale,
  getLocaleSetting,
  getLocaleSnapshot,
  initLocale,
  LOCALE_KEY,
  renderKey,
  renderMsg,
  setLocale,
  subscribeLocale,
  t,
} from '../src/i18n';
import { en } from '../src/i18n/en';
import { zh } from '../src/i18n/zh';
import { setStorageBackend } from '../src/core/storage';
import { createMemoryStorage } from './helpers';

/**
 * The i18n layer: catalog completeness, rendering, locale detection, and the locale store.
 *
 * Most cases are here because a mistake would be silent -- a key missing from one
 * catalog, a placeholder renamed in one language, Chinese left behind in the English
 * catalog. Nothing throws and nothing logs; the wrong text just ships. The tests are the
 * only thing that notices.
 */

type Key = keyof typeof zh;

const keys = Object.keys(zh) as Key[];
const enKeys = Object.keys(en) as Key[];

/**
 * Get the placeholder names that appear in a template.
 *
 * @param template one copy template from the catalog
 * @returns the deduped, sorted placeholder names, e.g. `{count}` gives `count`
 */
function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();
}

describe('目录完整性', () => {
  it('中英两份目录的 key 完全一一对应', () => {
    // Order doesn't matter, only the set: a missed key goes red here, and the
    // `Catalog` type on `en.ts` makes it go red even earlier, in `tsc`.
    expect([...enKeys].sort()).toEqual([...keys].sort());
  });

  it('每一条文案都非空', () => {
    for (const key of keys) {
      expect(zh[key].length, `zh.${key}`).toBeGreaterThan(0);
      expect(en[key].length, `en.${key}`).toBeGreaterThan(0);
    }
  });

  it('同一条文案的占位符名字在两种语言里一致', () => {
    // This guards against "the English translated {count} into {数量}" -- the type system
    // can't see it, and at runtime it would silently print `{数量}` to the user as-is.
    for (const key of keys) {
      expect(placeholders(en[key]), `en.${key}`).toEqual(placeholders(zh[key]));
    }
  });

  it('没有空占位符 {}', () => {
    for (const key of keys) {
      expect(zh[key], `zh.${key}`).not.toMatch(/\{\}/);
      expect(en[key], `en.${key}`).not.toMatch(/\{\}/);
    }
  });
});

describe('渲染', () => {
  it('按语言取目录里的那句话', () => {
    expect(renderKey('err.webdav.notFound', { action: zh['action.test'] }, 'zh')).toBe(
      '测试连接失败：路径不存在（HTTP 404），请检查服务器地址与子目录。',
    );
    expect(renderKey('err.webdav.notFound', { action: en['action.test'] }, 'en')).toBe(
      'Connection test failed: path not found (HTTP 404). Check the server address and subfolder.',
    );
  });

  it('没有参数时原样返回模板', () => {
    expect(renderKey('err.oauth.cancelled', undefined, 'zh')).toBe(zh['err.oauth.cancelled']);
  });

  it('数字参数会被转成字符串', () => {
    expect(renderKey('err.api.other', { provider: 'Dropbox', action: 'x', status: 500 }, 'zh')).toBe(
      'Dropbox x失败：HTTP 500。',
    );
  });

  it('参数里可以嵌一条 Msg（错误套错误）', () => {
    const inner = { key: 'err.folder.noFolder' as const };
    const outer = { key: 'err.manager.readFailed' as const, params: { detail: inner } };
    expect(renderMsg(outer, 'zh')).toBe(`读取远端失败：${zh['err.folder.noFolder']}`);
    expect(renderMsg(outer, 'en')).toBe(`Reading from the remote failed: ${en['err.folder.noFolder']}`);
  });

  it('参数里可以嵌一串 Msg，按换行拼起来', () => {
    const hints = [
      { key: 'err.oauth.windowClosedHintLine' as const, params: { n: 1, hint: '甲' } },
      { key: 'err.oauth.windowClosedHintLine' as const, params: { n: 2, hint: '乙' } },
    ];
    expect(renderMsg({ key: 'err.oauth.windowClosed', params: { hints, redirect: '尾' } }, 'zh')).toBe(
      `授权窗口被关闭了，没有拿到授权码。\n1. 甲\n2. 乙\n尾`,
    );
  });

  it('同步结果的数量按参数走，不再由核心层拼「N 条」', () => {
    expect(renderKey('sync.pushed', { count: 3, suffix: '' }, 'zh')).toBe('已上传 3 条');
    expect(renderKey('sync.pushed', { count: 3, suffix: '' }, 'en')).toBe('Uploaded: 3 in total');
    // The "backup overwritten" half is itself a Msg, resolved recursively from the params
    expect(
      renderKey(
        'sync.pushed',
        { count: 1, suffix: { key: 'sync.pushedBackup', params: { backup: 'a.json' } } },
        'zh',
      ),
    ).toBe('已上传 1 条；覆盖前的远端已备份为「a.json」');
  });

  it('缺参数时保留占位符并报一声，而不是显示 undefined', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(renderKey('err.api.other', { provider: 'Dropbox' }, 'zh')).toBe(
      'Dropbox {action}失败：HTTP {status}。',
    );
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('多给的参数被忽略', () => {
    expect(renderKey('err.oauth.cancelled', { nope: 'x' }, 'zh')).toBe(zh['err.oauth.cancelled']);
  });
});

describe('语言解析', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  /**
   * Replace globalThis.navigator with just a language field.
   *
   * @param language the language tag to install; undefined means there's no navigator at all
   */
  function stubNavigator(language: string | undefined): void {
    Object.defineProperty(globalThis, 'navigator', {
      value: language === undefined ? undefined : { language },
      configurable: true,
    });
  }

  /**
   * Replace globalThis.chrome.
   *
   * @param getUILanguage the stubbed UI-language getter; null means there's no chrome.i18n
   */
  function stubChrome(getUILanguage: (() => string) | null): void {
    (globalThis as { chrome?: unknown }).chrome =
      getUILanguage === null ? undefined : { i18n: { getUILanguage } };
  }

  beforeEach(() => {
    __resetLocaleForTest();
  });

  afterEach(() => {
    stubChrome(null);
    if (original) Object.defineProperty(globalThis, 'navigator', original);
    __resetLocaleForTest();
  });

  it('只看主语言子标签：zh 的方言全是中文', () => {
    stubNavigator('zh-TW');
    stubChrome(() => 'zh-Hans-CN');
    expect(detectLocale()).toBe('zh');
  });

  it('en 的各种地区变体都是英文', () => {
    stubNavigator('en-GB');
    stubChrome(() => 'en-US');
    expect(detectLocale()).toBe('en');
  });

  it('chrome.i18n 优先于 navigator.language', () => {
    stubNavigator('en-US');
    stubChrome(() => 'zh-CN');
    expect(detectLocale()).toBe('zh');
  });

  it('没有 chrome.i18n 时退回 navigator.language', () => {
    stubNavigator('en-US');
    stubChrome(null);
    expect(detectLocale()).toBe('en');
  });

  it('中文优先于英文：两个标签冲突时按 chrome.i18n 走', () => {
    stubNavigator('en-US');
    stubChrome(() => 'zh-CN');
    expect(detectLocale()).toBe('zh');
  });

  it('认不出的语言落到英文（见 FALLBACK_LOCALE 的取舍说明）', () => {
    stubNavigator('fr-FR');
    stubChrome(() => 'ja-JP');
    expect(detectLocale()).toBe('en');
  });

  it('两个来源都没有时也有答案', () => {
    stubNavigator(undefined);
    stubChrome(null);
    expect(detectLocale()).toBe('en');
  });
});

describe('语言状态', () => {
  let store: ReturnType<typeof createMemoryStorage>;

  beforeEach(() => {
    store = createMemoryStorage();
    setStorageBackend(store);
    __resetLocaleForTest();
  });

  afterEach(() => {
    setStorageBackend(null);
    __resetLocaleForTest();
  });

  it('默认是 auto，落盘后才钉死', async () => {
    await setLocale('en');
    expect(getLocale()).toBe('en');
    expect(getLocaleSetting()).toBe('en');
    expect(store.dump()[LOCALE_KEY]).toBe('en');
  });

  it('切回 auto 会重新跟随系统语言', async () => {
    await setLocale('zh');
    expect(getLocale()).toBe('zh');
    await setLocale('auto');
    expect(getLocaleSetting()).toBe('auto');
    expect(getLocale()).toBe(detectLocale());
  });

  it('initLocale 会把 storage 里的设置读回来', async () => {
    await store.set({ [LOCALE_KEY]: 'en' });
    await initLocale();
    expect(getLocale()).toBe('en');
    expect(getLocaleSetting()).toBe('en');
  });

  it('storage 里的值是垃圾时当 auto，不会把用户锁死在错语言上', async () => {
    await store.set({ [LOCALE_KEY]: 'klingon' });
    await initLocale();
    expect(getLocaleSetting()).toBe('auto');
    expect(getLocale()).toBe(detectLocale());
  });

  it('initLocale 是幂等的', async () => {
    await store.set({ [LOCALE_KEY]: 'en' });
    await initLocale();
    __resetLocaleForTest();
    await initLocale();
    await initLocale();
    expect(getLocale()).toBe('en');
  });

  it('没有 storage 的环境下 initLocale 不炸', async () => {
    setStorageBackend(null);
    (globalThis as { chrome?: unknown }).chrome = undefined;
    await expect(initLocale()).resolves.toBeUndefined();
  });

  it('只在真的变化时才通知订阅者', async () => {
    const seen = vi.fn();
    const off = subscribeLocale(seen);
    await setLocale('en');
    expect(seen).toHaveBeenCalledTimes(1);
    // Set the same value again: the snapshot hasn't changed, so React shouldn't be woken up
    await setLocale('en');
    expect(seen).toHaveBeenCalledTimes(1);
    await setLocale('zh');
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    await setLocale('en');
    expect(seen).toHaveBeenCalledTimes(2);
  });

  it('快照对象在没变时保持同一身份（useSyncExternalStore 不能拿到新对象）', async () => {
    const before = getLocaleSnapshot();
    expect(getLocaleSnapshot()).toBe(before);
    await setLocale('en');
    const after = getLocaleSnapshot();
    expect(after).not.toBe(before);
    expect(after.locale).toBe('en');
    expect(getLocaleSnapshot()).toBe(after);
  });

  it('t() 用的是当前语言', async () => {
    await setLocale('zh');
    expect(t('err.oauth.cancelled')).toBe(zh['err.oauth.cancelled']);
    await setLocale('en');
    expect(t('err.oauth.cancelled')).toBe(en['err.oauth.cancelled']);
  });

  it('renderMsg 不传语言时用当前语言', async () => {
    await setLocale('en');
    expect(renderMsg({ key: 'err.oauth.cancelled' })).toBe(en['err.oauth.cancelled']);
  });
});

describe('行内标记 `**粗体**`', () => {
  /**
   * The whitelist of keys that use `**`.
   *
   * Adding a key means its call site must render with `<RichText text={tmMarkup(…)} />`
   * (see `components/RichText.tsx`). Not updating the call site won't error -- the default
   * rendering path strips the markers, so the bold just disappears. That's why this table
   * is maintained by hand.
   */
  const BOLD_KEYS = new Set<Key>([
    'err.folder.notAFile',
    'err.oauth.windowClosedRedirect',
    'help.dropbox.step1',
    'help.dropbox.step2',
    'help.dropbox.misconfig1',
  ]);

  it('用标记的 key 正好是白名单里的那些', () => {
    const used = keys.filter((k) => zh[k].includes('**') || en[k].includes('**'));
    expect(new Set(used)).toEqual(BOLD_KEYS);
  });

  it('标记是配平的', () => {
    // A missing half won't error, it just makes `splitBold` treat the whole stretch as
    // plain text -- the bold is gone, though the asterisks won't leak out (`stripBold`
    // covers that). This test guards "is the bold still there".
    for (const key of keys) {
      for (const [name, catalog] of [
        ['zh', zh],
        ['en', en],
      ] as const) {
        const marks = (catalog[key].match(/\*\*/g) ?? []).length;
        expect(marks % 2, `${name}.${key}：${catalog[key]}`).toBe(0);
      }
    }
  });
});

describe('程序文字的语气（2026-09-11 的用户要求）', () => {
  /**
   * Allowed proper nouns: "我的云端硬盘 / My Drive" is the product's own name, not our
   * voice, so "我 / My" showing up there is expected. Allow by phrase rather than by key --
   * allowing a whole key would also let through the spots inside it that really should change.
   */
  const PROPER_NOUNS = ['我的云端硬盘', 'My Drive'];

  /** Two hard rules for the "manual voice": no em dashes, no first person. */
  const RULES: Array<{ why: string; re: RegExp }> = [
    {
      why: '破折号（中文 `——`、英文 `—` 都是它）',
      // Only checks U+2014. The hyphen `-` and range dash aren't included: they're not em dashes.
      re: /—/,
    },
    {
      why: '第一人称（英文用被动式或直接省略主语）',
      re: /\b(?:we|us|our|ours|ourselves|I|my|mine)\b/i,
    },
    {
      why: '第一人称',
      re: /我/,
    },
  ];

  /**
   * Strip the allowed proper nouns first, then check what's left.
   *
   * @param text one piece of copy
   * @returns the text with proper nouns removed
   */
  function strip(text: string): string {
    return PROPER_NOUNS.reduce((acc, noun) => acc.split(noun).join(''), text);
  }

  it('值里没有破折号，也没有第一人称', () => {
    for (const key of keys) {
      for (const [name, catalog] of [
        ['zh', zh],
        ['en', en],
      ] as const) {
        const value = strip(catalog[key]);
        for (const rule of RULES) {
          expect(rule.re.test(value), `${name}.${key} 里有${rule.why}：${catalog[key]}`).toBe(false);
        }
      }
    }
  });
});

describe('英文目录没有中文残留', () => {
  // Copying an English string and forgetting to change it, leaving the Chinese behind, is
  // the most common kind of missed translation, and type checking can't catch it.
  const CJK = /[一-鿿]/;

  /**
   * The few keys allowed to contain Chinese characters: a language's own name in the
   * language picker (endonym).
   *
   * "中文" stays "中文" in an English UI -- someone who can't read English can still
   * recognize their own language in that column. The cell names (`scope.*` / `source.*`)
   * don't belong here: they're quoted mid-sentence as terms, so both catalogs write
   * General / Individual.
   *
   * Kept as a whitelist rather than "skip all settings.language*": when a language is
   * added later, only the key that really needs Chinese in the English UI should go in.
   */
  const ENDONYMS = new Set<Key>(['settings.languageZh']);

  it('英文值里不含汉字（语言名除外）', () => {
    for (const key of enKeys) {
      if (ENDONYMS.has(key)) {
        expect(CJK.test(en[key]), `en.${key} 是本该保留汉字的那一个，现在却变干净了`).toBe(true);
        continue;
      }
      expect(CJK.test(en[key]), `en.${key} 里还有中文：${en[key]}`).toBe(false);
    }
  });
});

describe('英文文案不留占位符残渣', () => {
  it('英文值里不该出现中文标点（全角逗号/句号/冒号）', () => {
    // Edge case: the whole sentence was translated but the punctuation was forgotten,
    // which reads oddly. The ones listed are the easiest full-width punctuation to miss;
    // they don't show up in normal English copy.
    for (const key of enKeys) {
      expect(/[，。：；（）「」]/.test(en[key]), `en.${key}：${en[key]}`).toBe(false);
    }
  });
});

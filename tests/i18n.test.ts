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

describe('catalog completeness', () => {
  it('the zh and en catalogs have exactly the same keys', () => {
    // Order doesn't matter, only the set: a missed key goes red here, and the
    // `Catalog` type on `en.ts` makes it go red even earlier, in `tsc`.
    expect([...enKeys].sort()).toEqual([...keys].sort());
  });

  it('every string is non-empty', () => {
    for (const key of keys) {
      expect(zh[key].length, `zh.${key}`).toBeGreaterThan(0);
      expect(en[key].length, `en.${key}`).toBeGreaterThan(0);
    }
  });

  it('placeholder names match across the two languages for the same string', () => {
    // This guards against "the English renamed {count} to a different placeholder" -- the
    // type system can't see it, and at runtime it would silently print that raw placeholder
    // to the user as-is.
    for (const key of keys) {
      expect(placeholders(en[key]), `en.${key}`).toEqual(placeholders(zh[key]));
    }
  });

  it('no empty placeholder {}', () => {
    for (const key of keys) {
      expect(zh[key], `zh.${key}`).not.toMatch(/\{\}/);
      expect(en[key], `en.${key}`).not.toMatch(/\{\}/);
    }
  });
});

describe('rendering', () => {
  it('picks the catalog sentence for the language', () => {
    expect(renderKey('err.api.notConnected', { provider: zh['provider.dropbox'] }, 'zh')).toBe(
      'Dropbox 还没有连接，请先在设置页点「连接」。',
    );
    expect(renderKey('err.api.notConnected', { provider: en['provider.dropbox'] }, 'en')).toBe(
      'Dropbox is not connected yet. Click "Connect" in Settings first.',
    );
  });

  it('returns the template as-is when there are no params', () => {
    expect(renderKey('err.oauth.cancelled', undefined, 'zh')).toBe(zh['err.oauth.cancelled']);
  });

  it('numeric params are converted to strings', () => {
    expect(renderKey('err.api.other', { provider: 'Dropbox', action: 'x', status: 500 }, 'zh')).toBe(
      'Dropbox x失败：HTTP 500。',
    );
  });

  it('a param can nest a Msg (an error inside an error)', () => {
    const inner = { key: 'err.folder.noFolder' as const };
    const outer = { key: 'err.manager.readFailed' as const, params: { detail: inner } };
    expect(renderMsg(outer, 'zh')).toBe(`读取远端失败：${zh['err.folder.noFolder']}`);
    expect(renderMsg(outer, 'en')).toBe(`Reading from the remote failed: ${en['err.folder.noFolder']}`);
  });

  it('a param can nest a list of Msgs, joined by newlines', () => {
    const hints = [
      { key: 'err.oauth.windowClosedHintLine' as const, params: { n: 1, hint: '甲' } },
      { key: 'err.oauth.windowClosedHintLine' as const, params: { n: 2, hint: '乙' } },
    ];
    expect(renderMsg({ key: 'err.oauth.windowClosed', params: { hints, redirect: '尾' } }, 'zh')).toBe(
      `授权窗口被关闭了，没有拿到授权码。\n1. 甲\n2. 乙\n尾`,
    );
  });

  it('the sync result count comes from params, the core layer no longer builds "N items"', () => {
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

  it('a missing param keeps the placeholder and warns, instead of showing undefined', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(renderKey('err.api.other', { provider: 'Dropbox' }, 'zh')).toBe(
      'Dropbox {action}失败：HTTP {status}。',
    );
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it('extra params are ignored', () => {
    expect(renderKey('err.oauth.cancelled', { nope: 'x' }, 'zh')).toBe(zh['err.oauth.cancelled']);
  });
});

describe('locale detection', () => {
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

  it('only the primary language subtag counts: zh dialects are all Chinese', () => {
    stubNavigator('zh-TW');
    stubChrome(() => 'zh-Hans-CN');
    expect(detectLocale()).toBe('zh');
  });

  it('every regional variant of en is English', () => {
    stubNavigator('en-GB');
    stubChrome(() => 'en-US');
    expect(detectLocale()).toBe('en');
  });

  it('chrome.i18n takes priority over navigator.language', () => {
    stubNavigator('en-US');
    stubChrome(() => 'zh-CN');
    expect(detectLocale()).toBe('zh');
  });

  it('falls back to navigator.language when there is no chrome.i18n', () => {
    stubNavigator('en-US');
    stubChrome(null);
    expect(detectLocale()).toBe('en');
  });

  it('Chinese beats English: on conflicting tags chrome.i18n wins', () => {
    stubNavigator('en-US');
    stubChrome(() => 'zh-CN');
    expect(detectLocale()).toBe('zh');
  });

  it('an unrecognized language falls to English (see the FALLBACK_LOCALE rationale)', () => {
    stubNavigator('fr-FR');
    stubChrome(() => 'ja-JP');
    expect(detectLocale()).toBe('en');
  });

  it('still has an answer when neither source exists', () => {
    stubNavigator(undefined);
    stubChrome(null);
    expect(detectLocale()).toBe('en');
  });
});

describe('locale state', () => {
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

  it('defaults to auto, only pinned once written to storage', async () => {
    await setLocale('en');
    expect(getLocale()).toBe('en');
    expect(getLocaleSetting()).toBe('en');
    expect(store.dump()[LOCALE_KEY]).toBe('en');
  });

  it('switching back to auto follows the system language again', async () => {
    await setLocale('zh');
    expect(getLocale()).toBe('zh');
    await setLocale('auto');
    expect(getLocaleSetting()).toBe('auto');
    expect(getLocale()).toBe(detectLocale());
  });

  it('initLocale reads the setting back out of storage', async () => {
    await store.set({ [LOCALE_KEY]: 'en' });
    await initLocale();
    expect(getLocale()).toBe('en');
    expect(getLocaleSetting()).toBe('en');
  });

  it('a garbage value in storage counts as auto, so the user is not locked into the wrong language', async () => {
    await store.set({ [LOCALE_KEY]: 'klingon' });
    await initLocale();
    expect(getLocaleSetting()).toBe('auto');
    expect(getLocale()).toBe(detectLocale());
  });

  it('initLocale is idempotent', async () => {
    await store.set({ [LOCALE_KEY]: 'en' });
    await initLocale();
    __resetLocaleForTest();
    await initLocale();
    await initLocale();
    expect(getLocale()).toBe('en');
  });

  it('initLocale does not blow up when there is no storage', async () => {
    setStorageBackend(null);
    (globalThis as { chrome?: unknown }).chrome = undefined;
    await expect(initLocale()).resolves.toBeUndefined();
  });

  it('notifies subscribers only on a real change', async () => {
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

  it('the snapshot object keeps its identity when unchanged (useSyncExternalStore must not get a new object)', async () => {
    const before = getLocaleSnapshot();
    expect(getLocaleSnapshot()).toBe(before);
    await setLocale('en');
    const after = getLocaleSnapshot();
    expect(after).not.toBe(before);
    expect(after.locale).toBe('en');
    expect(getLocaleSnapshot()).toBe(after);
  });

  it('t() uses the current language', async () => {
    await setLocale('zh');
    expect(t('err.oauth.cancelled')).toBe(zh['err.oauth.cancelled']);
    await setLocale('en');
    expect(t('err.oauth.cancelled')).toBe(en['err.oauth.cancelled']);
  });

  it('renderMsg uses the current language when none is passed', async () => {
    await setLocale('en');
    expect(renderMsg({ key: 'err.oauth.cancelled' })).toBe(en['err.oauth.cancelled']);
  });
});

describe('inline `**bold**` markers', () => {
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

  it('the keys using the markers are exactly the whitelisted ones', () => {
    const used = keys.filter((k) => zh[k].includes('**') || en[k].includes('**'));
    expect(new Set(used)).toEqual(BOLD_KEYS);
  });

  it('the markers are balanced', () => {
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

describe('the voice of the program copy (a user request, 2026-09-11)', () => {
  /**
   * Allowed proper nouns: a product's own localized name (Google Drive's, which contains a
   * first-person word) is not our voice, so a first-person word showing up there is expected.
   * Allow by phrase rather than by key -- allowing a whole key would also let through the
   * spots inside it that really should change.
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

  it('no em dashes and no first person in the values', () => {
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

describe('the English catalog has no leftover Chinese', () => {
  // Copying an English string and forgetting to change it, leaving the Chinese behind, is
  // the most common kind of missed translation, and type checking can't catch it.
  const CJK = /[一-鿿]/;

  /**
   * The few keys allowed to contain Chinese characters: a language's own name in the
   * language picker (endonym).
   *
   * The endonym stays as written in an English UI -- someone who can't read English can
   * still recognize their own language in that column. The cell names (`scope.*` / `source.*`)
   * don't belong here: they're quoted mid-sentence as terms, so both catalogs write
   * General / Individual.
   *
   * Kept as a whitelist rather than "skip all settings.language*": when a language is
   * added later, only the key that really needs Chinese in the English UI should go in.
   */
  const ENDONYMS = new Set<Key>(['settings.languageZh']);

  it('no Han characters in the English values (except language names)', () => {
    for (const key of enKeys) {
      if (ENDONYMS.has(key)) {
        expect(CJK.test(en[key]), `en.${key} 是本该保留汉字的那一个，现在却变干净了`).toBe(true);
        continue;
      }
      expect(CJK.test(en[key]), `en.${key} 里还有中文：${en[key]}`).toBe(false);
    }
  });
});

describe('the English copy leaves no placeholder residue', () => {
  it('no Chinese punctuation in the English values (full-width comma/period/colon)', () => {
    // Edge case: the whole sentence was translated but the punctuation was forgotten,
    // which reads oddly. The ones listed are the easiest full-width punctuation to miss;
    // they don't show up in normal English copy.
    for (const key of enKeys) {
      expect(/[，。：；（）「」]/.test(en[key]), `en.${key}：${en[key]}`).toBe(false);
    }
  });
});

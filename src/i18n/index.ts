import { readKey, writeKey, onKeyChanged } from '../core/storage';
import type { Catalog, MessageKey, Msg, MsgParam } from './types';
import { en } from './en';
import { stripBold } from './richText';
import { zh } from './zh';

export type { Catalog, MessageKey, Msg, MsgParam, Translate } from './types';
export { splitBold, stripBold, type RichTextSegment } from './richText';

/**
 * i18n runtime (CODING_PLAN §14).
 *
 * This file (and `types / zh / en`) must not import React: the service worker needs
 * translations too, and it has its own bundle -- importing React here would drag it into
 * that bundle for nothing. The React binding lives in `./react.ts`.
 */

// ---------------------------------------------------------------- Locales

/** The locales that actually have a catalog. */
export type Locale = 'zh' | 'en';

/** The user's choice: `auto` = follow the browser, otherwise pinned to one. */
export type LocaleSetting = 'auto' | Locale;

/** Storage key for the language setting. Shares the same backend as the document and sync settings (see core/storage). */
export const LOCALE_KEY = 'locale';

/** Locales that have a catalog. The order is the order of the language toggle in Settings. */
export const LOCALES: readonly Locale[] = ['zh', 'en'];

/** One catalog per locale. Typed as `Record<Locale, Catalog>`, so a `Locale` without a catalog here is a compile error. */
const CATALOGS: Record<Locale, Catalog> = { zh, en };

/**
 * What to use when the locale cannot be recognised.
 *
 * English rather than Chinese: at that point the UI still has a language toggle
 * (Settings), and a Japanese user who sees English can follow "Settings" to the switch,
 * whereas Chinese leaves them stuck. Chinese users are not affected -- their browser
 * language is `zh*`, which takes the branch above.
 */
const FALLBACK_LOCALE: Locale = 'en';

/**
 * Narrow a raw value read back from storage into a valid setting.
 *
 * @param raw the value read from storage, which can be anything
 * @returns the value itself if it is recognised, `auto` if it was never set or was edited by hand into something broken
 */
function parseSetting(raw: unknown): LocaleSetting {
  if (raw === 'auto' || raw === 'zh' || raw === 'en') return raw;
  // auto is the least likely to lock the user into the wrong language
  return 'auto';
}

/**
 * Guess a locale from the browser language.
 *
 * Only the primary language subtag is looked at (`zh-Hans-CN` / `zh-TW` / `zh` all
 * count as Chinese), because simplified and traditional are not split yet.
 * `chrome.i18n.getUILanguage()` takes priority over `navigator.language`: the former is
 * the browser UI language, the latter may just be the first entry in the page preference
 * list.
 *
 * @returns the guessed locale, or `FALLBACK_LOCALE` if none of them is recognised
 */
export function detectLocale(): Locale {
  const tags: string[] = [];
  const uiLang = globalThis.chrome?.i18n?.getUILanguage?.();
  if (uiLang) tags.push(uiLang);
  if (typeof navigator !== 'undefined' && navigator.language) tags.push(navigator.language);

  for (const tag of tags) {
    const base = tag.toLowerCase().split('-')[0];
    if (base === 'zh' || base === 'en') return base;
  }
  return FALLBACK_LOCALE;
}

// ---------------------------------------------------------------- Rendering (pure functions)

/** Placeholder in a template: `{name}`. The name is made of letters/digits/underscores. */
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Render a `Msg` into human-readable text.
 *
 * The result is plain text: the `**bold**` markers written in the catalog are stripped
 * (see `richText.ts`). For real bold, use `renderMsgMarkup` + `<RichText>`.
 *
 * @param msg the template with its key and params
 * @param locale which locale to render in. Defaults to the current one; pass it
 *   explicitly in unit tests, or when rendering something to store for later
 * @returns the rendered sentence
 */
export function renderMsg(msg: Msg, locale: Locale = current): string {
  return renderKey(msg.key, msg.params, locale);
}

/**
 * Same as `renderMsg`, but takes the key directly.
 *
 * @param key the key in the catalog
 * @param params the params to fill `{name}` with
 * @param locale which locale to render in; defaults to the current one
 * @returns the rendered sentence, markers already stripped
 */
export function renderKey(
  key: MessageKey,
  params: Record<string, MsgParam> | undefined,
  locale: Locale = current,
): string {
  return fill(key, params, locale, false);
}

/**
 * Same as `renderMsg`, but keeps the `**bold**` markers for `<RichText>` to split.
 *
 * @param msg the template with its key and params
 * @param locale which locale to render in; defaults to the current one
 * @returns the sentence with its markers, meant only for `<RichText>`
 */
export function renderMsgMarkup(msg: Msg, locale: Locale = current): string {
  return renderKeyMarkup(msg.key, msg.params, locale);
}

/**
 * Same as `renderKey`, but keeps the `**bold**` markers.
 *
 * @param key the key in the catalog
 * @param params the params to fill `{name}` with
 * @param locale which locale to render in; defaults to the current one
 * @returns the sentence with its markers, meant only for `<RichText>`
 */
export function renderKeyMarkup(
  key: MessageKey,
  params: Record<string, MsgParam> | undefined,
  locale: Locale = current,
): string {
  return fill(key, params, locale, true);
}

/**
 * The shared implementation behind every render function.
 *
 * @param key the key in the catalog
 * @param params the params to fill `{name}` with
 * @param locale which locale to render in
 * @param markup whether to keep the `**` markers. This has to be passed down into nested
 *   params too: `{detail}` in `err.manager.readFailed` is itself a nested `Msg`, and if the
 *   outer call kept the markers while the inner one stripped them, the bold would vanish
 *   halfway through for no good reason
 * @returns the rendered sentence
 */
function fill(
  key: MessageKey,
  params: Record<string, MsgParam> | undefined,
  locale: Locale,
  markup: boolean,
): string {
  // If a key is missing from a catalog, fall back to Chinese rather than showing the user
  // the key: Chinese is the base catalog, and a missing key there can only be a
  // compile-time error (`Catalog` is exhaustive), so it cannot reach this line.
  const template = CATALOGS[locale]?.[key] ?? zh[key] ?? key;
  const filled = !params
    ? template
    : template.replace(PLACEHOLDER, (whole, name: string) => {
        if (!(name in params)) {
          // A placeholder that does not match the call site is a real bug (the template
          // has {count} but nothing passed it). Leaving `{count}` on screen and logging it
          // is easier to track down than quietly showing "undefined".
          console.warn(`[i18n] ${key} 缺少参数 ${name}`);
          return whole;
        }
        return renderParam(params[name], locale, markup);
      });

  return markup ? filled : stripBold(filled);
}

/**
 * Render one interpolation param to text.
 *
 * A number or string goes through as-is, a nested `Msg` is rendered recursively, and a list
 * of `Msg`s becomes one paragraph per entry.
 *
 * @param p the param to render
 * @param locale which locale to render in
 * @param markup whether to keep the `**` markers
 * @returns the rendered text
 */
function renderParam(p: MsgParam, locale: Locale, markup: boolean): string {
  if (typeof p === 'string' || typeof p === 'number') return String(p);
  // One paragraph per entry, i.e. the closed-authorization-window notice listing console
  // pitfalls
  if (Array.isArray(p)) return p.map((m) => fill(m.key, m.params, locale, markup)).join('\n');
  return fill(p.key, p.params, locale, markup);
}

/**
 * Whether this value is a valid key.
 *
 * For reading a value back from storage that may come from an older version: old versions
 * stored a rendered sentence, new ones store a `Msg`, and normalizing has to tell them
 * apart (see normalizeSyncStatus).
 *
 * @param value the value to check
 * @returns whether it is a key present in the base catalog
 */
export function isMessageKey(value: unknown): value is MessageKey {
  return typeof value === 'string' && value in zh;
}

/**
 * "How do you say this in this locale". Core code should only use it to render strings
 * that go back to the user.
 *
 * @param key the key in the catalog
 * @param params the params to fill `{name}` with
 * @returns the sentence in the current locale, markers already stripped
 */
export function t(key: MessageKey, params?: Record<string, MsgParam>): string {
  return renderKey(key, params, current);
}

// ---------------------------------------------------------------- Locale state

/** What the user picked in Settings, initially `auto`. */
let setting: LocaleSetting = 'auto';
/** The locale actually in use, with `auto` already resolved to `zh` / `en`. */
let current: Locale = FALLBACK_LOCALE;

/**
 * `useSyncExternalStore` requires the same state to return the same object, otherwise
 * every comparison fails -> infinite re-renders. So cache an immutable snapshot here and
 * only replace it when something really changed.
 */
let snapshot: { locale: Locale; setting: LocaleSetting } = { locale: current, setting };

/** The subscribers to notify when the locale changes (see subscribeLocale). */
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/**
 * Apply a setting.
 *
 * @param next the new setting; `auto` is resolved to a concrete locale right away
 */
function apply(next: LocaleSetting): void {
  const resolved = next === 'auto' ? detectLocale() : next;
  if (next === setting && resolved === current) return;
  setting = next;
  current = resolved;
  snapshot = { locale: current, setting };
  emit();
}

/** The locale actually in use. */
export function getLocale(): Locale {
  return current;
}

/** What the user picked in Settings, possibly still `auto`. */
export function getLocaleSetting(): LocaleSetting {
  return setting;
}

/**
 * The snapshot for `useSyncExternalStore`.
 *
 * @returns the current locale and setting; the same object as long as nothing changed, so it can be compared directly
 */
export function getLocaleSnapshot(): { locale: Locale; setting: LocaleSetting } {
  return snapshot;
}

/**
 * Subscribe to locale changes.
 *
 * @param l the callback to call on change
 * @returns an unsubscribe function
 */
export function subscribeLocale(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/**
 * Change the locale and persist it. Local state first, then storage: writing is async,
 * and waiting for it before updating the UI would leave a one-frame delay; if the write
 * fails, storage still holds the old value and the next start naturally falls back to it.
 *
 * @param next the new setting
 * @returns resolves once the write to storage has been attempted; the locale is already applied by then
 */
export async function setLocale(next: LocaleSetting): Promise<void> {
  apply(next);
  try {
    await writeKey(LOCALE_KEY, next);
  } catch (e) {
    console.warn('[i18n] 语言设置写入失败', e);
  }
}

/** Startup runs once; further calls return immediately. */
let started = false;

/**
 * Start i18n: set the system language first (so the first frame is not in the wrong
 * language), then read the stored setting on top of it, and finally subscribe -- so a locale
 * change from somewhere else (another page, the Settings page) is picked up here too.
 *
 * Every realm (app page / popup / content script / SW) has its own in-memory state, and
 * this subscription is what keeps them aligned.
 *
 * @returns a Promise that resolves when the state is ready; idempotent, repeat calls have no extra side effects
 */
export async function initLocale(): Promise<void> {
  if (started) return;
  started = true;

  const detected = detectLocale();
  if (detected !== current) {
    current = detected;
    snapshot = { locale: current, setting };
  }

  onKeyChanged(LOCALE_KEY, (raw) => apply(parseSetting(raw)));

  try {
    apply(parseSetting(await readKey(LOCALE_KEY)));
  } catch {
    // No storage outside an extension (unit tests / SSR): the system language is the final answer
  }
}

/** For unit tests only: push the in-memory state back to its initial values and release the `started` lock. */
export function __resetLocaleForTest(): void {
  started = false;
  setting = 'auto';
  current = FALLBACK_LOCALE;
  snapshot = { locale: current, setting };
  listeners.clear();
}

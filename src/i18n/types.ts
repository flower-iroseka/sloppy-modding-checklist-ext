import type { zh } from './zh';

/**
 * The i18n type layer (CODING_PLAN §14).
 *
 * Core code produces a `Msg` ("which sentence + what params"), never a translated sentence,
 * and translation happens only at the point where it is shown. That is because sync errors
 * get stored in storage (`syncStatus.lastError`): an error translated when it was created
 * would still be in the old language after the user switches, leaving the page half in each
 * language.
 */

/** Which keys the catalog has. Derived from the base catalog `zh`. */
export type MessageKey = keyof typeof zh;

/**
 * An interpolation param.
 *
 * It can nest a `Msg`: core code is full of "wrap one error inside another"
 * (`读取远端失败：<内层的错>`), and the inner one has to follow the locale too, resolved
 * recursively at render time; action words (the `{action}` in `无法{action}。`) are passed
 * the same way.
 *
 * It can also be a list of `Msg`s, joined with newlines at render time -- the
 * closed-authorization-window notice lists console pitfalls as a list of paragraphs, and
 * core code should not have to hold a locale just to build it.
 */
export type MsgParam = string | number | Msg | Msg[];

/**
 * A piece of text waiting to be translated: which sentence (key) + what params.
 *
 * It carries no locale itself, so it can cross realms and can be stored now and rendered
 * later.
 */
export interface Msg {
  key: MessageKey;
  /** The params to fill `{name}` in the template. Omit when the template has no placeholders. */
  params?: Record<string, MsgParam>;
}

/**
 * A function that renders a Msg into human-readable text.
 *
 * Core code can render with it (that is how the `message` the SW sends back to the page is
 * produced), but it holds no locale -- the locale is the renderer's business.
 *
 * @param key the key in the catalog
 * @param params the params to fill `{name}` with; omit when the template has no placeholders
 * @returns the sentence in the current locale
 */
export type Translate = (key: MessageKey, params?: Record<string, MsgParam>) => string;

/** Catalog: key -> that sentence in this locale. Every locale must be complete; a missing key shows up in `tsc`. */
export type Catalog = Record<MessageKey, string>;

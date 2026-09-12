import { renderMsg, type Msg } from '../../i18n';

/**
 * Sync errors (CODING_PLAN §7.6 / §14).
 *
 * Carries a structured `msg` instead of a finished sentence: the core layer only says which
 * sentence and what params, and the display side turns that into text. The error can sit in
 * storage for a while, so freezing a translation now would leave the user reading the old
 * language after a switch (see the file header of `src/i18n/types.ts`). Every `msg` has to
 * say "which step, what went wrong, what to do" rather than throw a status code at the user.
 */
export class SyncError extends Error {
  /**
   * Template for the sentence shown to the user. Display goes through `describeError` +
   * `renderMsg`.
   */
  readonly msg: Msg;
  /** HTTP status code (undefined when it isn't an HTTP error). */
  readonly status?: number;
  /**
   * Changing the config / retrying might help (network blip, rate limit) → the UI offers
   * "retry"; otherwise it's a config problem.
   */
  readonly retryable: boolean;
  /**
   * The original exception. Kept in its own field rather than `super(message, { cause })`:
   * the project's `lib` isn't on ES2022 yet, so that overload doesn't exist. It's kept so
   * `console.error` still shows the underlying fetch error.
   */
  readonly detail?: unknown;

  /**
   * @param msg template for the sentence shown to the user
   * @param opts.status HTTP status code; leave it out when it isn't an HTTP error
   * @param opts.retryable pass true when a retry might succeed; the UI then offers "retry"
   * @param opts.cause the original exception, kept for `console.error`
   */
  constructor(msg: Msg, opts: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    // `Error.message` is only for logs and stack traces, so it's pre-rendered in the base
    // language (Chinese) to keep devtools from showing nothing but a key like
    // `err.webdav.notFound`. Don't use it as UI text: after the user switches to English it
    // stays Chinese. Display always goes through `describeError` → the renderer (the page
    // uses `useLocale().tm`, the SW only returns the structure).
    super(renderMsg(msg, 'zh'));
    this.name = 'SyncError';
    this.msg = msg;
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.detail = opts.cause;
  }
}

/**
 * @param e any value
 * @returns whether it's a `SyncError`
 */
export function isSyncError(e: unknown): e is SyncError {
  return e instanceof SyncError;
}

/**
 * Reduce any exception to a `Msg` (not a sentence).
 *
 * `SyncError` hands over its own template; anything else gets wrapped in `err.raw`.
 *
 * @param e any exception
 * @returns a template you can hand straight to `renderMsg`
 */
export function describeError(e: unknown): Msg {
  if (isSyncError(e)) return e.msg;
  if (e instanceof Error) return { key: 'err.raw', params: { detail: e.message } };
  return { key: 'err.raw', params: { detail: String(e) } };
}


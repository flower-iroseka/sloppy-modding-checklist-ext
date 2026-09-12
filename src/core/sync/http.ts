/**
 * The HTTP layer shared by all providers (CODING_PLAN §7.6).
 *
 * It only handles two things: timeouts, and turning network-layer failures into plain
 * language. HTTP status codes are deliberately not translated here -- the same 404 means
 * "you got the subdirectory wrong" for WebDAV but might mean "the file hasn't been created
 * yet" elsewhere, and the next step differs, so each caller translates its own.
 */
import { SyncError } from './errors';

/**
 * Self-hosted WebDAV and cloud drives can both hang without responding; without a timeout,
 * "测试连接" would spin forever.
 */
export const TIMEOUT_MS = 20_000;

/** The injection point for fetch; tests swap in a fake. */
export interface FetchDeps {
  /** Same as `globalThis.fetch`. */
  fetch: typeof fetch;
}

/**
 * Get a URL's host, for error messages.
 *
 * @param url any URL string
 * @returns the host; returns the input as-is when the URL itself is invalid (the error
 *          message has to say something)
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * @param value any string
 * @returns whether it's an http / https URL
 */
export function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * fetch with a timeout.
 *
 * Only rejects on network-layer failures -- DNS failures, TLS errors and timeouts all get
 * folded into the same sentence, with the host name attached: "can't reach
 * api.dropboxapi.com" is what tells the user what to check. HTTP error codes resolve, and are
 * left to the caller.
 *
 * @param deps the injected fetch
 * @param url the request URL
 * @param init same as `RequestInit`; the `signal` in it gets overwritten here
 * @returns the server's response; any status code counts as a successful return
 * @throws {SyncError} network-layer failure or timeout
 */
export async function fetchWithTimeout(
  deps: FetchDeps,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  try {
    return await deps.fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    throw new SyncError(
      {
        key: 'err.http.unreachable',
        params: { host: hostOf(url), detail: e instanceof Error ? e.message : String(e) },
      },
      { retryable: true, cause: e },
    );
  }
}

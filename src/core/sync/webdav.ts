import type { MessageKey, Msg } from '../../i18n';
import { SyncError } from './errors';
import { fetchWithTimeout, hostOf, isHttpUrl, type FetchDeps } from './http';
import type { ProviderConfig, RemoteDoc, SyncProvider, WebDavConfig } from './types';

/**
 * The fixed remote file name (CODING_PLAN §7.2). Changing it means changing the data file,
 * so don't do it lightly.
 */
export const REMOTE_FILE = 'modding-checklist.json';

/** It only depends on `fetch`, and tests just swap in a fake. */
export type WebDavDeps = FetchDeps;

/**
 * By this point the config is definitely a WebDAV shape; `SyncProvider`'s signature only
 * gives a union.
 *
 * @param cfg the provider config
 * @returns the same config, narrowed to `WebDavConfig`
 */
function asWebDav(cfg: ProviderConfig): WebDavConfig {
  return cfg as WebDavConfig;
}

/**
 * Strip slashes and whitespace from both ends.
 *
 * @param s the string to trim
 * @returns the trimmed string
 */
function stripSlashes(s: string): string {
  return s.trim().replace(/^\/+|\/+$/g, '');
}

/**
 * Collection URL = the baseUrl the user entered + the optional subdirectory (without the
 * file name).
 *
 * @param cfg WebDAV config
 * @returns the collection's full URL
 */
export function collectionUrl(cfg: WebDavConfig): string {
  const base = cfg.baseUrl.trim().replace(/\/+$/, '');
  const dir = stripSlashes(cfg.path ?? '');
  return dir ? `${base}/${dir}` : base;
}

/**
 * Build the remote file URL. `baseUrl` is the collection URL (the one the user entered), and
 * the file name is ours to decide.
 *
 * @param cfg WebDAV config
 * @returns the file's full URL
 */
export function remoteUrl(cfg: WebDavConfig): string {
  return `${collectionUrl(cfg)}/${REMOTE_FILE}`;
}

/**
 * The URL's origin (for requesting host permission).
 *
 * @param cfg WebDAV config
 * @returns the origin; null when it won't parse or the protocol isn't http(s)
 */
export function configOrigin(cfg: WebDavConfig): string | null {
  const raw = cfg.baseUrl.trim();
  if (!isHttpUrl(raw)) return null;
  return new URL(raw).origin;
}

/**
 * The match pattern for host permission, like `https://dav.jianguoyun.com/*`.
 *
 * @param cfg WebDAV config
 * @returns the match pattern; null when `configOrigin` can't get an origin
 */
export function configOriginPattern(cfg: WebDavConfig): string | null {
  const origin = configOrigin(cfg);
  return origin ? `${origin}/*` : null;
}

/**
 * Encode text as base64.
 *
 * @param input the text to encode
 * @returns the base64 text
 */
function base64(input: string): string {
  // btoa only takes latin1; when the username or password has non-ASCII, convert to UTF-8
  // first, otherwise `btoa` throws InvalidCharacterError and the user sees "it crashes as
  // soon as I hit save".
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * The basic auth header. Special characters in the username/password are left to base64;
 * don't build the string by hand.
 *
 * @param cfg WebDAV config
 * @returns the whole value of the `Basic xxx` header
 */
export function authHeader(cfg: WebDavConfig): string {
  return `Basic ${base64(`${cfg.username}:${cfg.password}`)}`;
}

/**
 * Whether the config is filled in completely.
 *
 * @param cfg WebDAV config
 * @returns null when it's fine, otherwise the template for the user-facing sentence (the
 *          caller translates it with `renderMsg`)
 */
export function validateConfig(cfg: WebDavConfig): Msg | null {
  if (!cfg.baseUrl.trim()) return { key: 'err.webdav.noBaseUrl' };
  if (!configOrigin(cfg)) return { key: 'err.webdav.badBaseUrl' };
  if (!cfg.username.trim()) return { key: 'err.webdav.noUsername' };
  if (!cfg.password) return { key: 'err.webdav.noPassword' };
  return null;
}

/**
 * Send a request with the basic auth header (timeouts and network errors are handled by
 * `fetchWithTimeout`).
 *
 * @param deps the injected fetch
 * @param cfg WebDAV config
 * @param url the request URL
 * @param init request method and headers
 * @returns the server's response
 */
async function request(
  deps: WebDavDeps,
  cfg: WebDavConfig,
  url: string,
  init: RequestInit & { method: string },
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', authHeader(cfg));
  return fetchWithTimeout(deps, url, { ...init, headers });
}

/**
 * Turn HTTP error codes into a sentence you can act on, instead of throwing a status code at
 * the user.
 *
 * `action` is the action word's key (`action.test` / `action.upload` / `action.download`),
 * not a pre-translated Chinese string -- the same action here and elsewhere has to follow
 * the language.
 *
 * @param status HTTP status code
 * @param action which action is being performed
 * @param url the request URL, used to put the host name in the error
 * @returns a `SyncError` you can throw directly
 */
function httpError(status: number, action: MessageKey, url: string): SyncError {
  const params = { action: { key: action }, host: hostOf(url), status };
  if (status === 401 || status === 403) {
    return new SyncError({ key: 'err.webdav.auth', params }, { status });
  }
  if (status === 404) {
    return new SyncError({ key: 'err.webdav.notFound', params }, { status });
  }
  if (status === 405 || status === 501) {
    return new SyncError({ key: 'err.webdav.unsupported', params }, { status });
  }
  if (status >= 500) {
    return new SyncError({ key: 'err.webdav.server', params }, { status, retryable: true });
  }
  return new SyncError({ key: 'err.webdav.other', params }, { status });
}

/** The minimal PROPFIND body for probing the collection. */
const PROPFIND_BODY =
  '<?xml version="1.0"?><propfind xmlns="DAV:"><prop><resourcetype/></prop></propfind>';

/**
 * Create a WebDAV provider.
 *
 * `test` first sends `PROPFIND Depth: 0` at the collection -- this is the standard WebDAV
 * way to check "is this URL a usable collection", and it separates "wrong credentials"
 * (401) from "wrong path" (404), two errors that need completely different actions from the
 * user. When the server disables PROPFIND (405/501), it falls back to a `GET` on the file:
 * then only 401/403 counts as an error, and a 404 actually means "reachable, the file just
 * hasn't been created yet", which is a state you can sync normally in.
 *
 * @param deps the injected fetch
 * @returns a WebDAV provider implementing `SyncProvider`
 */
export function createWebDavProvider(deps: WebDavDeps): SyncProvider {
  return {
    id: 'webdav',
    displayName: 'provider.webdav',

    isConfigured(cfg) {
      const c = asWebDav(cfg);
      return c.enabled && validateConfig(c) === null;
    },

    async test(cfg) {
      const c = asWebDav(cfg);
      const bad = validateConfig(c);
      if (bad) throw new SyncError(bad);

      const collection = collectionUrl(c);
      const probe = await request(deps, c, collection, {
        method: 'PROPFIND',
        headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
      });

      if (probe.ok || probe.status === 207) return;
      if (probe.status !== 405 && probe.status !== 501) {
        throw httpError(probe.status, 'action.test', collection);
      }

      // The server doesn't accept PROPFIND: fall back to probing the file
      const file = remoteUrl(c);
      const get = await request(deps, c, file, { method: 'GET' });
      if (get.ok || get.status === 404) return;
      throw httpError(get.status, 'action.test', file);
    },

    async read(cfg): Promise<RemoteDoc | null> {
      const c = asWebDav(cfg);
      const url = remoteUrl(c);
      const res = await request(deps, c, url, { method: 'GET' });
      if (res.status === 404) return null; // no remote file yet -- not an error
      if (!res.ok) throw httpError(res.status, 'action.download', url);

      const json = await res.text();
      const lastModified = res.headers.get('last-modified');
      const modifiedAt = lastModified ? Date.parse(lastModified) : Number.NaN;
      return { json, ...(Number.isFinite(modifiedAt) ? { modifiedAt } : {}) };
    },

    async write(cfg, docJson) {
      const c = asWebDav(cfg);
      const url = remoteUrl(c);
      const res = await request(deps, c, url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: docJson,
      });
      if (!res.ok) throw httpError(res.status, 'action.upload', url);
    },
  };
}

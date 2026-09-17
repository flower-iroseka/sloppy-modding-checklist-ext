/**
 * Dropbox (CODING_PLAN §7.3 / §7.6).
 *
 * The app permission is App folder (`/Apps/<app name>/`), so files go in the app's own
 * folder. RPC endpoints (`api.dropboxapi.com`) take params in the JSON body; content
 * endpoints (`content.dropboxapi.com`, upload / download) take them in the `Dropbox-API-Arg`
 * header and leave the body to the file. Mixing the two returns a bare HTTP 500 instead of
 * "params in the wrong place", so "Test connection" looks like Dropbox is down while "Upload now" still
 * works. The shape is pinned by `tests/sync-oauth-providers.test.ts`, not by the smoke script.
 */
import { fetchWithTimeout } from './http';
import { apiError, errorDetail, type OAuthApi } from './oauthProvider';
import { REMOTE_FILE } from './webdav';
import type { OAuthSpec } from './oauth';

export const DROPBOX_SPEC: OAuthSpec = {
  id: 'dropbox',
  displayName: 'provider.dropbox',
  authUrl: 'https://www.dropbox.com/oauth2/authorize',
  tokenUrl: 'https://api.dropboxapi.com/oauth2/token',
  // metadata.read is there for "Test connection" (reading the root folder's metadata), and it's
  // not redundant: without it the only way to test would be "try uploading once", which
  // actually touches the user's data.
  scopes: ['files.content.read', 'files.content.write', 'files.metadata.read'],
  // Without this you get a short-lived token that dies after 4 hours and comes with no
  // refresh_token.
  authParams: { token_access_type: 'offline' },
  requiresSecret: false,
  help: {
    consoleUrl: 'https://www.dropbox.com/developers/apps',
    consoleLabel: 'Dropbox App Console',
    steps: [
      { key: 'help.dropbox.step1' },
      { key: 'help.dropbox.step2' },
      { key: 'help.dropbox.step3' },
      { key: 'help.dropbox.step4' },
    ],
    caution: { key: 'help.dropbox.caution' },
    misconfig: [
      { key: 'help.dropbox.misconfig1' },
      { key: 'help.dropbox.misconfig2' },
      { key: 'help.dropbox.misconfig3' },
    ],
  },
};

const REMOTE_PATH = `/${REMOTE_FILE}`;
/** Prefix for the upload/download endpoints. */
const CONTENT = 'https://content.dropboxapi.com/2/files';
/** Prefix for the RPC endpoints. */
const RPC = 'https://api.dropboxapi.com/2/files';

/**
 * Build the `Dropbox-API-Arg` header.
 *
 * The header value has to be ASCII; non-ASCII in a path has to be escaped as `\uXXXX`.
 *
 * @param value the params to put in the header
 * @returns a headers fragment holding just this one header
 */
function argHeader(value: Record<string, unknown>): Record<string, string> {
  return { 'Dropbox-API-Arg': JSON.stringify(value).replace(/[^\x20-\x7e]/g, (c) =>
    `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) };
}

/** Dropbox's error body. */
interface DropboxError {
  /** Error code path, like `path/not_found/...`. */
  error_summary?: string;
}

/**
 * Is this "file not found"?
 *
 * Dropbox's "file not found" is 409 + `path/not_found`, not 404.
 *
 * @param res the server's response
 * @returns true when it's "file not found"
 */
async function isNotFound(res: Response): Promise<boolean> {
  if (res.status !== 409) return false;
  try {
    const body = (await res.json()) as DropboxError;
    return (body.error_summary ?? '').includes('not_found');
  } catch {
    return false;
  }
}

/** Dropbox's file API. */
export const dropboxApi: OAuthApi = {
  async test(ctx) {
    // Read metadata: touches metadata only, never file contents. A missing file is also
    // 409 not_found, which just means "reachable, authorization works, we just haven't
    // uploaded yet" -- an entirely usable state.
    //
    // Params go in the JSON body (`get_metadata` is an RPC endpoint), not in
    // `Dropbox-API-Arg` -- mixing them up only returns an HTTP 500, which is very hard to
    // track down, see the file header.
    const res = await fetchWithTimeout(ctx, `${RPC}/get_metadata`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ctx.token}` },
      body: JSON.stringify({ path: REMOTE_PATH }),
    });
    if (res.ok) return;
    if (await isNotFound(res)) return;
    throw apiError('action.test', DROPBOX_SPEC, res, await errorDetail(res));
  },

  async read(ctx) {
    const res = await fetchWithTimeout(ctx, `${CONTENT}/download`, {
      method: 'POST',
      headers: { ...argHeader({ path: REMOTE_PATH }), Authorization: `Bearer ${ctx.token}` },
    });
    if (await isNotFound(res)) return null;
    if (!res.ok) throw apiError('action.download', DROPBOX_SPEC, res, await errorDetail(res));

    const json = await res.text();
    // File metadata (including server_modified) is in the response headers, not the body.
    const raw = res.headers.get('Dropbox-API-Result');
    if (!raw) return { json };
    try {
      const meta = JSON.parse(raw) as { server_modified?: string };
      const modifiedAt = meta.server_modified ? Date.parse(meta.server_modified) : Number.NaN;
      return { json, ...(Number.isFinite(modifiedAt) ? { modifiedAt } : {}) };
    } catch {
      return { json };
    }
  },

  async write(ctx, docJson) {
    const res = await fetchWithTimeout(ctx, `${CONTENT}/upload`, {
      method: 'POST',
      headers: {
        ...argHeader({ path: REMOTE_PATH, mode: 'overwrite', mute: true }),
        Authorization: `Bearer ${ctx.token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: docJson,
    });
    if (!res.ok) throw apiError('action.upload', DROPBOX_SPEC, res, await errorDetail(res));
  },
};

/** Domains that need host permission. */
export const DROPBOX_ORIGINS = [
  'https://api.dropboxapi.com/*',
  'https://content.dropboxapi.com/*',
  'https://www.dropbox.com/*',
];

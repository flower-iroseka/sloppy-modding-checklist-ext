/**
 * Assemble "OAuth spec + each provider's API" into one `SyncProvider` (CODING_PLAN §7.6).
 *
 * The authorization part is identical across providers; the file API is not (Dropbox puts
 * params in request headers, and upload / download vs. metadata are two separate conventions,
 * see `dropbox.ts`). So this layer does two things: it hides "the token may need refreshing"
 * from the API layer (`ApiCtx.token` is always fresh), and it turns status codes into a
 * sentence the user can act on. Each provider's API shape stays in its own spec file.
 */
import type { MessageKey, Msg } from '../../i18n';
import { SyncError } from './errors';
import type { FetchDeps } from './http';
import { refreshToken, type OAuthSpec, type TokenSet } from './oauth';
import type { OAuthConfig, ProviderConfig, RemoteDoc, SyncProvider } from './types';

/** The API layer's input. */
export interface ApiCtx {
  /** The injected fetch. */
  fetch: typeof fetch;
  /**
   * The currently valid access token; `createOAuthProvider` guarantees it isn't expired.
   */
  token: string;
}

/**
 * One provider's file API. Each provider's spec file implements it and only knows
 * `{fetch, token}`.
 */
export interface OAuthApi {
  /**
   * "Test connection": reachable and authenticated → resolve.
   *
   * @param ctx fetch and the current access token
   * @throws {SyncError} can't connect, or authentication failed
   */
  test(ctx: ApiCtx): Promise<void>;
  /**
   * Read the remote doc.
   *
   * @param ctx fetch and the current access token
   * @returns the remote doc; null when there's no remote file yet (not an error)
   * @throws {SyncError} the request failed
   */
  read(ctx: ApiCtx): Promise<RemoteDoc | null>;
  /**
   * Write the doc to the remote, overwriting what's there.
   *
   * @param ctx fetch and the current access token
   * @param docJson the raw JSON to write up
   * @throws {SyncError} the request failed
   */
  write(ctx: ApiCtx, docJson: string): Promise<void>;
}

/**
 * Reading, writing and clearing tokens (injected from `tokens.ts`; unit tests swap in an
 * in-memory Map).
 */
export interface TokenStore {
  /**
   * @param id which provider
   * @returns the stored token; undefined when it was never connected
   */
  get(id: OAuthSpec['id']): Promise<TokenSet | undefined>;
  /**
   * @param id which provider
   * @param token the new token, replacing the whole record
   */
  set(id: OAuthSpec['id'], token: TokenSet): Promise<void>;
  /**
   * @param id which provider
   */
  clear(id: OAuthSpec['id']): Promise<void>;
}

/** The dependencies for assembling a spec and a file API into a provider. */
export interface OAuthProviderDeps extends FetchDeps {
  /** Token storage. */
  tokens: TokenStore;
}

/**
 * Fish the sentence the server sent back out, as extra context for the error.
 *
 * Mainly for 5xx. For 4xx we've already translated by status code into plain language; for
 * 5xx the status code alone tells you nothing, and it has two completely different sources:
 * the server really is down (retrying helps), or we sent a bad request ourselves (retrying
 * ten thousand times changes nothing). A real example of the latter is putting an RPC
 * endpoint's params into the `Dropbox-API-Arg` header (see `dropbox.ts#test`) -- Dropbox
 * just returns a 500, so "server error, you can retry later" sends people in entirely the wrong
 * direction. Carrying the raw text at least shows that "Try again later" isn't going to fix it.
 *
 * Truncated to 200 characters: some gateways return a whole page of HTML on error, and that
 * makes the message unreadable.
 *
 * @param res the server's response
 * @returns the response body; undefined when it's empty or can't be read
 */
export async function errorDetail(res: Response): Promise<string | undefined> {
  try {
    const text = (await res.text()).trim();
    if (!text) return undefined;
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return undefined;
  }
}

/**
 * Turn a response into a `SyncError` by status code.
 *
 * @param action which action is being performed (the action word's key)
 * @param spec this provider's spec, used to put a translatable provider name in the message
 * @param res the server's response
 * @param detail the raw text the server sent back; attached to the message when present
 * @returns a `SyncError` you can throw directly
 */
export function apiError(
  action: MessageKey,
  spec: OAuthSpec,
  res: Response,
  detail?: string,
): SyncError {
  const base = { provider: { key: spec.displayName }, action: { key: action }, status: res.status };

  /**
   * "With detail" and "without detail" are two paired sentences, not one sentence plus a
   * switch: the parenthesis has to appear or vanish as a whole, and a template string can't
   * give you a conditional slot (see the note in zh.ts). So picking the sentence happens
   * here, and the punctuation stays in the catalog. detail is the platform's own text (the
   * HTML a gateway returns, Dropbox's English line) and isn't translated.
   */
  const pick = (plain: MessageKey, withDetail: MessageKey): Msg =>
    detail ? { key: withDetail, params: { ...base, detail } } : { key: plain, params: base };

  if (res.status === 401 || res.status === 403) {
    return new SyncError(pick('err.api.auth', 'err.api.authDetail'), { status: res.status });
  }
  if (res.status === 429) {
    return new SyncError(
      { key: 'err.api.rateLimited', params: base },
      { status: res.status, retryable: true },
    );
  }
  if (res.status >= 500) {
    return new SyncError(pick('err.api.server', 'err.api.serverDetail'), {
      status: res.status,
      retryable: true,
    });
  }
  return new SyncError(pick('err.api.other', 'err.api.otherDetail'), { status: res.status });
}

/**
 * Get a currently valid access token.
 *
 * When a refresh fails, delete this provider's record: leaving a record that can't be
 * refreshed means the user hits the same wall on every sync while the settings page still
 * shows "● Connected" -- the most baffling state there is. After deleting it, the settings
 * page goes back to "○ Not connected" and the button goes back to "Save and connect", so the
 * user knows what to click.
 *
 * @param deps token storage and fetch
 * @param spec this provider's spec
 * @returns a function that takes the config and gives you back a fresh token
 * @throws {SyncError} there's no stored token, or the refresh failed
 */
export function makeTokenAccessor(deps: OAuthProviderDeps, spec: OAuthSpec) {
  return async function accessToken(cfg: OAuthConfig): Promise<string> {
    const stored = await deps.tokens.get(spec.id);
    if (!stored) {
      throw new SyncError({
        key: 'err.api.notConnected',
        params: { provider: { key: spec.displayName } },
      });
    }
    if (Date.now() < stored.expiresAt) return stored.accessToken;

    if (!stored.refreshToken) {
      await deps.tokens.clear(spec.id);
      throw new SyncError({ key: 'err.api.expired', params: { provider: { key: spec.displayName } } });
    }
    try {
      const next = await refreshToken(deps, spec, {
        refreshToken: stored.refreshToken,
        clientId: cfg.clientId.trim(),
        ...(cfg.clientSecret ? { clientSecret: cfg.clientSecret } : {}),
      });
      await deps.tokens.set(spec.id, next);
      return next.accessToken;
    } catch (e) {
      await deps.tokens.clear(spec.id);
      throw e;
    }
  };
}

/**
 * Assemble a spec and an API into a `SyncProvider`.
 *
 * @param spec this provider's spec
 * @param api this provider's file API
 * @param deps token storage and fetch
 * @returns an OAuth provider implementing `SyncProvider`
 */
export function createOAuthProvider(
  spec: OAuthSpec,
  api: OAuthApi,
  deps: OAuthProviderDeps,
): SyncProvider {
  const accessToken = makeTokenAccessor(deps, spec);

  const ctx = async (cfg: ProviderConfig): Promise<ApiCtx> => ({
    fetch: deps.fetch,
    token: await accessToken(cfg as OAuthConfig),
  });

  return {
    id: spec.id,
    displayName: spec.displayName,

    /**
     * Only checks whether it's filled in completely, not whether it's authorized -- this
     * method has to be synchronous (that's how the §7.1 interface is defined), and the
     * authorization state is in storage. When not connected, `test` / `read` / `write`
     * throw a "{provider} is not connected yet. Click 'Connect' in Settings first." line,
     * which is more accurate than anything this could say.
     */
    isConfigured(cfg) {
      const c = cfg as OAuthConfig;
      return c.enabled && c.clientId.trim() !== '' && (!spec.requiresSecret || !!c.clientSecret);
    },

    async test(cfg) {
      await api.test(await ctx(cfg));
    },

    read(cfg): Promise<RemoteDoc | null> {
      return ctx(cfg).then((c) => api.read(c));
    },

    write(cfg, docJson) {
      return ctx(cfg).then((c) => api.write(c, docJson));
    },
  };
}

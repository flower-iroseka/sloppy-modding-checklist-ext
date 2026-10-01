/**
 * The shared OAuth 2.0 layer (CODING_PLAN §7.6).
 *
 * All three providers use authorization code + PKCE and differ only in endpoints, scopes and
 * a few fixed params, so authorization, token exchange and refresh are written once and each
 * provider just supplies an `OAuthSpec`. `chrome.identity.getAuthToken` is not an option: it
 * needs the client_id baked into the manifest at build time, which would force the extension
 * author to register a developer project, while this extension expects the user to bring
 * their own account and their own client_id.
 */
import type { MessageKey, Msg } from '../../i18n';
import { SyncError } from './errors';
import { fetchWithTimeout, type FetchDeps } from './http';
import type { OAuthConfig, ProviderId } from './types';

/**
 * One OAuth provider's static spec: endpoints, scopes, whether client_secret is needed,
 * wizard copy.
 */
export interface OAuthSpec {
  /** Which provider this spec is for. */
  id: ProviderId;
  /**
   * Same as `SyncProvider.displayName`: stores a key, not a string; it goes into a
   * sentence's `{provider}`.
   */
  displayName: MessageKey;
  /** Authorization page URL (the one the user sees in the popup). */
  authUrl: string;
  /** URL for exchanging the code for a token. */
  tokenUrl: string;
  /**
   * The permissions to request; joined with spaces into one `scope` param at authorization
   * time.
   */
  scopes: string[];
  /**
   * Extra fixed params on the authorization request. Each provider has its own quirks:
   * Dropbox only hands out a refresh_token with `token_access_type=offline`, Microsoft
   * relies on `offline_access` in the scope.
   */
  authParams?: Record<string, string>;
  /**
   * Whether this provider requires a client_secret. This is a property of the client type
   * (only confidential clients require it); the current Dropbox is a public client, so PKCE
   * is enough (`false`).
   */
  requiresSecret: boolean;
  /** The registration wizard copy on the settings page (display only). */
  help: OAuthHelp;
}

/** The contents of that registration wizard on the settings page. */
export interface OAuthHelp {
  /** Where to create the app. */
  consoleUrl: string;
  /**
   * What that console is called. A brand name, so it doesn't go in the catalog (hard-coded
   * like Dropbox) -- Chinese users see "Dropbox App Console" too.
   */
  consoleLabel: string;
  /**
   * The type to pick / permissions to enable when creating the app, spelled out step by
   * step.
   */
  steps: Msg[];
  /**
   * What this authorization popup asks the user for (be upfront, don't make them guess).
   */
  caution?: Msg;
  /**
   * What the user sees on the authorization page when the console isn't set up right, and
   * what to go back and fix. Listed one by one.
   *
   * This gets its own field because: when the provider errors out on its own page, the page
   * never redirects back to our callback, and `launchWebAuthFlow` just waits until the user
   * closes that error window -- all we get back is an `undefined`, and we never see the
   * error text itself. So the only option is to write up this provider's classic traps
   * beforehand and hand them to the user verbatim to compare against. A real example the
   * user forced out (2026-09-11): Dropbox's "Permissions checked but Submit never clicked"
   * has exactly this shape -- the config looks right, and the authorization page just
   * throws back `No scope requested can be granted for this app`.
   */
  misconfig?: Msg[];
}

/** The token from one authorization. */
export interface TokenSet {
  /** Access token, sent with every request. */
  accessToken: string;
  /**
   * Used to get a new access_token; sometimes the provider only returns access_token, and
   * then there's none.
   */
  refreshToken?: string;
  /** Absolute ms timestamp; treated as expired 60 seconds before it. */
  expiresAt: number;
  /**
   * The scope the provider sent back, for checking whether we under-requested permissions.
   */
  scope?: string;
}

/**
 * How long before expiry to treat it as expired. Leave a little margin so we don't get
 * stuck on "expired the moment it's sent".
 */
const EXPIRY_SKEW_MS = 60_000;

// ---------------------------------------------------------------- PKCE

/**
 * base64url (the alphabet OAuth wants: `+`→`-`, `/`→`_`, and no `=` padding).
 *
 * @param bytes the raw bytes to encode
 * @returns the base64url text
 */
function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A PKCE pair. */
export interface Pkce {
  /** Random string, sent to the provider when exchanging the code. */
  verifier: string;
  /**
   * The verifier's SHA-256 (base64url); this one goes first, at authorization time.
   */
  challenge: string;
}

/**
 * Generate the PKCE verifier / challenge.
 *
 * Public clients (desktop apps, extensions) have no client_secret they can keep, so PKCE is
 * what stops an authorization code intercepted by another program from being traded for a
 * token. All three providers support it.
 *
 * @param cryptoLike the crypto implementation, defaulting to global `crypto`; tests can replace it
 * @returns the verifier and its challenge
 */
export async function createPkce(
  cryptoLike: Pick<Crypto, 'getRandomValues' | 'subtle'> = globalThis.crypto,
): Promise<Pkce> {
  const raw = new Uint8Array(32);
  cryptoLike.getRandomValues(raw);
  const verifier = base64Url(raw);
  const digest = await cryptoLike.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64Url(new Uint8Array(digest)) };
}

// ---------------------------------------------------------------- Authorization URL

/** What's needed to build the authorization URL. */
export interface AuthParams {
  /** The client id the user entered. */
  clientId: string;
  /**
   * The URL the provider redirects back to; must be the one registered in that provider's
   * console.
   */
  redirectUri: string;
  /**
   * Random string against authorization-code injection; compared exactly on callback.
   */
  state: string;
  /** The PKCE challenge. */
  challenge: string;
  /** Params appended one by one (for tests; normal flows don't need it). */
  extra?: Record<string, string>;
}

/**
 * Build the authorization page's URL.
 *
 * @param spec this provider's spec
 * @param p this authorization's params
 * @returns a URL you can hand straight to `launchWebAuthFlow`
 */
export function buildAuthUrl(spec: OAuthSpec, p: AuthParams): string {
  const url = new URL(spec.authUrl);
  const q = url.searchParams;
  q.set('response_type', 'code');
  q.set('client_id', p.clientId);
  q.set('redirect_uri', p.redirectUri);
  q.set('scope', spec.scopes.join(' '));
  q.set('state', p.state);
  q.set('code_challenge', p.challenge);
  q.set('code_challenge_method', 'S256');
  for (const [k, v] of Object.entries(spec.authParams ?? {})) q.set(k, v);
  for (const [k, v] of Object.entries(p.extra ?? {})) q.set(k, v);
  return url.toString();
}

/**
 * Get the `code` out of the redirected URL.
 *
 * Failures have to be told apart: `error=access_denied` means the user clicked decline
 * (not a fault, don't scare them with red text), everything else is a real error.
 *
 * @param redirected the full URL the provider redirected back to
 * @param expectedState the state generated at the start; a mismatch counts as code injection
 * @returns the authorization code for the token exchange
 * @throws {SyncError} the callback won't parse, the state doesn't match, the provider
 *         errored, or there's no code
 */
export function parseRedirect(redirected: string, expectedState: string): string {
  let url: URL;
  try {
    url = new URL(redirected);
  } catch {
    throw new SyncError({ key: 'err.oauth.redirectUnparsable' });
  }
  const q = url.searchParams;
  // Check state first: trading another session's callback for a token is the classic code
  // injection.
  const state = q.get('state');
  if (state !== expectedState) {
    throw new SyncError({ key: 'err.oauth.stateMismatch' }, { retryable: true });
  }
  const error = q.get('error');
  if (error) {
    const desc = q.get('error_description');
    if (error === 'access_denied') {
      throw new SyncError({ key: 'err.oauth.cancelled' });
    }
    // `error` and `error_description` are the provider's own text (English, fixed OAuth2
    // spec vocabulary) and aren't translated; only the wrapper sentence is ours.
    throw new SyncError(
      desc
        ? { key: 'err.oauth.deniedByServerDetail', params: { error, detail: desc } }
        : { key: 'err.oauth.deniedByServer', params: { error } },
    );
  }
  const code = q.get('code');
  if (!code) throw new SyncError({ key: 'err.oauth.noCode' }, { retryable: true });
  return code;
}

// ---------------------------------------------------------------- token

/**
 * The token endpoint's response (standard OAuth2 fields across all three, measured
 * consistent).
 */
interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  error?: unknown;
  error_description?: unknown;
}

/**
 * Turn the token endpoint's response into a `TokenSet`.
 *
 * @param raw the parsed response body
 * @param previousRefresh the previous refresh_token; reused when no new one came back
 * @returns the token
 * @throws {SyncError} the response has no access_token
 */
function asTokenSet(raw: TokenResponse, previousRefresh?: string): TokenSet {
  const accessToken = typeof raw.access_token === 'string' ? raw.access_token : '';
  if (!accessToken) throw new SyncError({ key: 'err.oauth.noAccessToken' }, { retryable: true });
  const expiresIn = typeof raw.expires_in === 'number' ? raw.expires_in : 3600;
  const refreshToken = typeof raw.refresh_token === 'string' ? raw.refresh_token : previousRefresh;
  return {
    accessToken,
    // On refresh the server often doesn't send a refresh_token again, and then the old one
    // has to be reused -- overwriting it with undefined would make the user re-authorize
    // every few hours.
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: Date.now() + Math.max(0, expiresIn) * 1000 - EXPIRY_SKEW_MS,
    ...(typeof raw.scope === 'string' ? { scope: raw.scope } : {}),
  };
}

/**
 * Turn a token endpoint error into a `SyncError`.
 *
 * `invalid_grant` is the only kind the user has to act on (authorization revoked /
 * refresh_token expired) -- the rest are "retry or check the client_id you entered". Folded
 * into one "authentication failed", the user wouldn't know whether to reconnect or go fix
 * the client_id.
 *
 * @param status HTTP status code
 * @param body the parsed response body
 * @param spec this provider's spec, used to put a translatable provider name in the message
 * @returns a `SyncError` you can throw directly
 */
function tokenError(status: number, body: TokenResponse, spec: OAuthSpec): SyncError {
  const code = typeof body.error === 'string' ? body.error : '';
  const desc = typeof body.error_description === 'string' ? body.error_description : '';
  // Wrap the key in a Msg once: all four places below want a translatable provider name,
  // not the key itself.
  const provider: Msg = { key: spec.displayName };
  if (code === 'invalid_grant') {
    return new SyncError({ key: 'err.oauth.tokenInvalid', params: { provider } }, {
      status,
      cause: desc,
    });
  }
  if (code === 'invalid_client') {
    return new SyncError({ key: 'err.oauth.badClient', params: { provider, status } }, {
      status,
      cause: desc,
    });
  }
  if (status >= 500) {
    return new SyncError({ key: 'err.oauth.providerServer', params: { provider, status } }, {
      status,
      retryable: true,
    });
  }
  // `reason` prefers the provider's error code; falls back to the status code. Both are
  // raw text, untranslated.
  const reason = code || `HTTP ${status}`;
  return new SyncError(
    desc
      ? { key: 'err.oauth.exchangeFailedDetail', params: { provider, reason, detail: desc } }
      : { key: 'err.oauth.exchangeFailed', params: { provider, reason } },
    { status },
  );
}

/**
 * Send one token request.
 *
 * @param deps the injected fetch
 * @param spec this provider's spec
 * @param form the form body
 * @param previousRefresh the previous refresh_token, used as a fallback on refresh
 * @returns the token
 * @throws {SyncError} the endpoint errored, or the response has no access_token
 */
async function postToken(
  deps: FetchDeps,
  spec: OAuthSpec,
  form: Record<string, string>,
  previousRefresh?: string,
): Promise<TokenSet> {
  const body = new URLSearchParams(form);
  const res = await fetchWithTimeout(deps, spec.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  let parsed: TokenResponse = {};
  try {
    parsed = (await res.json()) as TokenResponse;
  } catch {
    // Some gateways return HTML on error; below everything is reported by status code.
    parsed = {};
  }
  if (!res.ok) throw tokenError(res.status, parsed, spec);
  return asTokenSet(parsed, previousRefresh);
}

/**
 * Exchange the authorization code for a token.
 *
 * @param deps the injected fetch
 * @param spec this provider's spec
 * @param p.code the authorization code from the callback
 * @param p.clientId the client id the user entered
 * @param p.clientSecret only needed by confidential clients
 * @param p.verifier the PKCE verifier
 * @param p.redirectUri must be the same one used at authorization time
 * @returns the token
 * @throws {SyncError} the endpoint errored, or the response has no access_token
 */
export function exchangeCode(
  deps: FetchDeps,
  spec: OAuthSpec,
  p: {
    code: string;
    clientId: string;
    clientSecret?: string;
    verifier: string;
    redirectUri: string;
  },
): Promise<TokenSet> {
  return postToken(deps, spec, {
    grant_type: 'authorization_code',
    code: p.code,
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    code_verifier: p.verifier,
    ...(p.clientSecret ? { client_secret: p.clientSecret } : {}),
  });
}

/**
 * Exchange the refresh_token for a new access_token.
 *
 * @param deps the injected fetch
 * @param spec this provider's spec
 * @param p.refreshToken the refresh_token from last time
 * @param p.clientId the client id the user entered
 * @param p.clientSecret only needed by confidential clients
 * @returns the new token; reuses the old refresh_token when the server doesn't send a new one
 * @throws {SyncError} the endpoint errored, or the response has no access_token
 */
export function refreshToken(
  deps: FetchDeps,
  spec: OAuthSpec,
  p: { refreshToken: string; clientId: string; clientSecret?: string },
): Promise<TokenSet> {
  return postToken(
    deps,
    spec,
    {
      grant_type: 'refresh_token',
      refresh_token: p.refreshToken,
      client_id: p.clientId,
      ...(p.clientSecret ? { client_secret: p.clientSecret } : {}),
    },
    p.refreshToken,
  );
}

// ---------------------------------------------------------------- Full authorization flow

/** The minimum surface of `chrome.identity.launchWebAuthFlow` (injected for unit tests). */
export interface AuthFlowDeps {
  /**
   * Open the authorization window and wait for the callback; resolves to undefined when the
   * user just closes it.
   */
  launchWebAuthFlow(options: { url: string; interactive: boolean }): Promise<string | undefined>;
}

/**
 * Run a whole authorization: build the URL → open the popup → get the code from the
 * callback → exchange for a token.
 *
 * Returns the token instead of persisting it itself: writing storage is the caller's
 * (service worker's) job, and that way this layer can be tested end to end with a fake
 * `launchWebAuthFlow` + fake `fetch`.
 *
 * @param flow the popup implementation
 * @param deps the injected fetch
 * @param spec this provider's spec
 * @param cfg the config the user entered
 * @param redirectUri the URL the provider redirects back to
 * @returns the token obtained
 * @throws {SyncError} no client_id entered, the window was closed, or the token exchange failed
 */
export async function runAuthFlow(
  flow: AuthFlowDeps,
  deps: FetchDeps,
  spec: OAuthSpec,
  cfg: OAuthConfig,
  redirectUri: string,
): Promise<TokenSet> {
  const clientId = cfg.clientId.trim();
  if (!clientId) {
    throw new SyncError({
      key: 'err.oauth.noClientId',
      params: { provider: { key: spec.displayName } },
    });
  }

  const { verifier, challenge } = await createPkce();
  // state only guards against code injection; it isn't a secret, so the same random
  // generator is enough.
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));
  const url = buildAuthUrl(spec, { clientId, redirectUri, state, challenge });

  const redirected = await flow.launchWebAuthFlow({ url, interactive: true });
  // When the user just closes the popup it's undefined, not a throw -- that's not a fault.
  //
  // But undefined has a second, more common source: the provider errors out on its own page
  // (`redirect_uri_mismatch`, scope not configured, app disabled...), the page never
  // redirects back to our callback, and `launchWebAuthFlow` just waits until the user
  // closes that error window. We can't just say "you didn't finish connecting" -- that
  // blames the user for a configuration error, when they have no idea what to go fix.
  //
  // The trouble is we never see the error text itself (the window belongs to the provider,
  // the callback is the only output, and it didn't happen). So we do two things here: hand
  // them the redirect URI we sent, so they can compare it character by character; and list
  // this provider's classic traps (`help.misconfig`) verbatim, to compare against that line
  // on the authorization page.
  if (!redirected) {
    const misconfig = spec.help.misconfig ?? [];
    // This is a multi-paragraph message; the renderer joins the paragraphs with newlines
    // (see the note in i18n/types.ts about MsgParam allowing Msg[]): the core layer
    // shouldn't hold a language just to assemble this.
    throw new SyncError({
      key: 'err.oauth.windowClosed',
      params: {
        hints: [
          misconfig.length
            ? { key: 'err.oauth.windowClosedIntro', params: { provider: { key: spec.displayName } } }
            : { key: 'err.oauth.windowClosedNoHints' },
          ...misconfig.map(
            (hint, i): Msg => ({
              key: 'err.oauth.windowClosedHintLine',
              params: { n: i + 1, hint },
            }),
          ),
        ],
        redirect: { key: 'err.oauth.windowClosedRedirect', params: { redirectUri } },
      },
    });
  }

  const code = parseRedirect(redirected, state);
  return exchangeCode(deps, spec, {
    code,
    clientId,
    verifier,
    redirectUri,
    ...(cfg.clientSecret ? { clientSecret: cfg.clientSecret } : {}),
  });
}

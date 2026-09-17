import { describe, expect, it } from 'vitest';
import { SyncError } from '../src/core/sync/errors';
import {
  buildAuthUrl,
  createPkce,
  exchangeCode,
  parseRedirect,
  refreshToken,
  runAuthFlow,
} from '../src/core/sync/oauth';
import { makeTokenAccessor, type TokenStore } from '../src/core/sync/oauthProvider';
import { DROPBOX_SPEC } from '../src/core/sync/dropbox';
import { OAUTH_SPECS } from '../src/core/sync/registry';
import type { OAuthConfig } from '../src/core/sync/types';
import { renderMsg } from '../src/i18n';

const cfg: OAuthConfig = { enabled: true, clientId: 'cid', clientSecret: 'sec' };

/**
 * The OAuth layer: PKCE, the authorization URL, redirect parsing, the token exchange and
 * refresh, and the whole runAuthFlow.
 *
 * The failure paths get as much room as the happy path: every code a provider can return
 * maps to a specific message, and that wording decides whether the user retries,
 * reconnects, or goes back to the console to fix a setting.
 */

interface Call {
  /** Request URL. */
  url: string;
  /** HTTP method; recorded as GET when not set. */
  method: string;
  /** Request headers. */
  headers: Headers;
  /** Request body; undefined when not passed. */
  body?: unknown;
}

/**
 * Fake fetch: hand out preset responses in call order, recording every request.
 *
 * Once the response list runs out, the last one is reused. Functions are used instead of
 * Response objects because a Response body can only be read once.
 *
 * @param responses the preset responses
 * @returns the recorded calls, and the fetch wrapped as `deps`
 */
function fakeFetch(responses: (Response | (() => Response))[]) {
  const calls: Call[] = [];
  let i = 0;
  const fn = async (url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      method: String(init.method ?? 'GET'),
      headers: new Headers(init.headers),
      body: init.body,
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (typeof next === 'function') return next();
    return next.clone();
  };
  return { calls, deps: { fetch: fn as unknown as typeof fetch } };
}

/**
 * Build a JSON response, 200 + application/json by default.
 *
 * @param body the response body, passed through JSON.stringify
 * @param init overrides the default status / headers
 * @returns the built Response
 */
function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

/**
 * Parse the form body out of one request.
 *
 * @param call the call recorded by the fake fetch
 * @returns the form parsed from the request body
 */
function form(call: Call): URLSearchParams {
  return new URLSearchParams(String(call.body));
}

// ---------------------------------------------------------------- PKCE

describe('createPkce', () => {
  it('both the verifier and the challenge are base64url (none of + / =)', async () => {
    const { verifier, challenge } = await createPkce();
    for (const v of [verifier, challenge]) {
      expect(v).not.toMatch(/[+/=]/);
      expect(v.length).toBeGreaterThan(20);
    }
  });

  it('the challenge really is the SHA-256 of the verifier (that is how the server checks it)', async () => {
    const { verifier, challenge } = await createPkce();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    let binary = '';
    for (const b of new Uint8Array(digest)) binary += String.fromCharCode(b);
    const expected = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });

  it('two of them differ (the verifier is not reused)', async () => {
    const a = await createPkce();
    const b = await createPkce();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

// ---------------------------------------------------------------- Auth URL

describe('buildAuthUrl', () => {
  const params = {
    clientId: 'cid',
    redirectUri: 'https://abc.chromiumapp.org/',
    state: 'st',
    challenge: 'ch',
  };

  it('carries the four PKCE parts and a fixed response_type', () => {
    const url = new URL(buildAuthUrl(DROPBOX_SPEC, params));
    expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://abc.chromiumapp.org/');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('code_challenge')).toBe('ch');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('scope is joined with spaces', () => {
    const url = new URL(buildAuthUrl(DROPBOX_SPEC, params));
    expect(url.searchParams.get('scope')).toBe(
      'files.content.read files.content.write files.metadata.read',
    );
  });

  // Without this param, the access_token obtained expires after 4 hours and there's no
  // refresh_token, so the user would inexplicably be asked to re-authorize every few hours.
  it('the per-provider extra params are there (token_access_type for Dropbox)', () => {
    const url = new URL(buildAuthUrl(DROPBOX_SPEC, params));
    expect(url.searchParams.get('token_access_type')).toBe('offline');
  });
});

// ---------------------------------------------------------------- Redirect parsing

describe('parseRedirect', () => {
  it('a normal callback yields the code', () => {
    expect(parseRedirect('https://x.chromiumapp.org/?code=abc&state=st', 'st')).toBe('abc');
  });

  // A mismatched state means this redirect wasn't started by us, and exchanging it for a
  // token would be handing the authorization code to someone else.
  it('a mismatched state is rejected outright', () => {
    expect(() => parseRedirect('https://x.chromiumapp.org/?code=abc&state=other', 'st')).toThrow(
      /state 不匹配/,
    );
  });

  // The user clicking "deny" isn't a failure, so don't scare them with wording like "authorization failed".
  it('the user clicked deny -> the wording is "cancelled", not "failed"', () => {
    const run = () => parseRedirect('https://x.chromiumapp.org/?error=access_denied&state=st', 'st');
    expect(run).toThrow(/已取消/);
    expect(() => run()).not.toThrow(/失败/);
  });

  it('other errors carry the error code out', () => {
    expect(() =>
      parseRedirect('https://x.chromiumapp.org/?error=invalid_scope&error_description=bad&state=st', 'st'),
    ).toThrow(/invalid_scope.*bad/);
  });

  it('neither code nor error -> tell the user to retry', () => {
    expect(() => parseRedirect('https://x.chromiumapp.org/?state=st', 'st')).toThrow(/没有返回 code/);
  });
});

// ---------------------------------------------------------------- Exchanging the token

describe('exchangeCode', () => {
  const args = {
    code: 'c0de',
    clientId: 'cid',
    clientSecret: 'sec',
    verifier: 'ver',
    redirectUri: 'https://x.chromiumapp.org/',
  };

  it('POSTs the form to tokenUrl with code_verifier', async () => {
    const { calls, deps } = fakeFetch([json({ access_token: 'at', expires_in: 3600 })]);
    await exchangeCode(deps, DROPBOX_SPEC, args);

    expect(calls[0].url).toBe('https://api.dropboxapi.com/oauth2/token');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    const body = form(calls[0]);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('c0de');
    expect(body.get('code_verifier')).toBe('ver');
    expect(body.get('redirect_uri')).toBe('https://x.chromiumapp.org/');
    expect(body.get('client_secret')).toBe('sec');
  });

  // Public clients (Microsoft / Dropbox) have no secret at all, so don't stuff an empty string in.
  it('the field is absent from the form when client_secret is not filled in', async () => {
    const { calls, deps } = fakeFetch([json({ access_token: 'at' })]);
    await exchangeCode(deps, DROPBOX_SPEC, { ...args, clientSecret: undefined });
    expect(form(calls[0]).has('client_secret')).toBe(false);
  });

  it('expires_in becomes an absolute time, with 60 seconds of margin', async () => {
    const { deps } = fakeFetch([json({ access_token: 'at', expires_in: 3600 })]);
    const now = Date.now();
    const token = await exchangeCode(deps, DROPBOX_SPEC, args);
    expect(token.expiresAt).toBeGreaterThan(now + 3500 * 1000);
    expect(token.expiresAt).toBeLessThanOrEqual(now + 3600 * 1000);
  });

  it('no access_token -> throw instead of storing an empty token', async () => {
    const { deps } = fakeFetch([json({ token_type: 'Bearer' })]);
    await expect(exchangeCode(deps, DROPBOX_SPEC, args)).rejects.toThrow(/access_token/);
  });
});

describe('refreshToken', () => {
  const args = { refreshToken: 'rt', clientId: 'cid', clientSecret: 'sec' };

  it('grant_type is refresh_token', async () => {
    const { calls, deps } = fakeFetch([json({ access_token: 'at2', expires_in: 3600 })]);
    await refreshToken(deps, DROPBOX_SPEC, args);
    const body = form(calls[0]);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('rt');
  });

  // The server often stops returning a refresh_token on refresh. Losing it means the user
  // has to reconnect by hand next time.
  it('keeps the old refresh_token when the response has none', async () => {
    const { deps } = fakeFetch([json({ access_token: 'at2', expires_in: 3600 })]);
    const token = await refreshToken(deps, DROPBOX_SPEC, args);
    expect(token.refreshToken).toBe('rt');
  });

  it('uses the new one when one comes back (Dropbox rotates it)', async () => {
    const { deps } = fakeFetch([json({ access_token: 'at2', refresh_token: 'rt2' })]);
    expect((await refreshToken(deps, DROPBOX_SPEC, args)).refreshToken).toBe('rt2');
  });

  it('invalid_grant -> tell the user to reconnect, and do not mark it "retryable"', async () => {
    const { deps } = fakeFetch([json({ error: 'invalid_grant' }, { status: 400 })]);
    const err = await refreshToken(deps, DROPBOX_SPEC, args).catch((e) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect(err.message).toMatch(/授权已失效/);
    expect(err.retryable).toBe(false);
  });

  it('invalid_client -> point at client_id / client_secret', async () => {
    const { deps } = fakeFetch([json({ error: 'invalid_client' }, { status: 401 })]);
    await expect(refreshToken(deps, DROPBOX_SPEC, args)).rejects.toThrow(/client_id/);
  });

  it('5xx is marked retryable', async () => {
    const { deps } = fakeFetch([new Response('boom', { status: 503 })]);
    const err = await refreshToken(deps, DROPBOX_SPEC, args).catch((e) => e);
    expect(err.retryable).toBe(true);
  });

  // Some gateways return HTML on error, and `res.json()` throws. Don't let that mask the
  // real status code.
  it('still reports by status code when the response body is not JSON', async () => {
    const { deps } = fakeFetch([
      new Response('<html>nope</html>', { status: 400, headers: { 'Content-Type': 'text/html' } }),
    ]);
    await expect(refreshToken(deps, DROPBOX_SPEC, args)).rejects.toThrow(/HTTP 400/);
  });
});

// ---------------------------------------------------------------- The full auth flow

describe('runAuthFlow', () => {
  const redirectUri = 'https://abc.chromiumapp.org/';

  /**
   * Fake launchWebAuthFlow: just return the given redirect address.
   *
   * @param returned the address the authorization side supposedly redirected back to; undefined simulates the popup being closed
   * @param seen records the URL actually opened
   * @returns a deps object usable as launchWebAuthFlow
   */
  function flow(returned: string | undefined, seen: { url?: string } = {}) {
    return {
      launchWebAuthFlow: async (o: { url: string }) => {
        seen.url = o.url;
        return returned;
      },
    };
  }

  it('the state in the built URL is the same one used to exchange the token', async () => {
    const seen: { url?: string } = {};
    let launchedState = '';
    const flowDeps = {
      launchWebAuthFlow: async (o: { url: string }) => {
        seen.url = o.url;
        launchedState = new URL(o.url).searchParams.get('state') ?? '';
        return `https://abc.chromiumapp.org/?code=c0de&state=${launchedState}`;
      },
    };
    const { deps } = fakeFetch([json({ access_token: 'at' })]);
    await runAuthFlow(flowDeps, deps, DROPBOX_SPEC, cfg, redirectUri);
    expect(seen.url).toContain('code_challenge=');
  });

  // The user just closes the popup: nothing comes back, which isn't a failure, so say it
  // in plain words.
  it('the popup was closed -> say "the connection was not completed"', async () => {
    const { deps } = fakeFetch([json({})]);
    await expect(runAuthFlow(flow(undefined), deps, DROPBOX_SPEC, cfg, redirectUri)).rejects.toThrow(
      /窗口被关闭/,
    );
  });

  // `undefined` has a second source too: the authorization side errors on its own page
  // (typically redirect_uri_mismatch), never redirects back, and so we wait until the user
  // closes that error window -- which looks exactly like "the user closed it themselves".
  // So that message has to include the address we sent, otherwise the user thinks they
  // didn't finish the steps and has no idea they need to change something in the console.
  it('writes the actual redirect address into the hint (otherwise redirect_uri_mismatch has nowhere to be looked up)', async () => {
    const { deps } = fakeFetch([json({})]);
    const err = (await runAuthFlow(flow(undefined), deps, DROPBOX_SPEC, cfg, redirectUri).catch(
      (e: Error) => e,
    )) as Error;
    expect(err.message).toContain(redirectUri);
    expect(err.message).toMatch(/redirect_uri_mismatch/);
    expect(err.message).toMatch(/斜杠/);
  });

  // The test above used to have an extra note about "the one thing this provider most often
  // gets wrong in the redirect address" (`OAuthHelp.redirectTrap`), which had only one user
  // -- the "Authorized JavaScript origins" field in Google Cloud Console -- and was deleted
  // along with that field when Google Drive was cut (2026-09-11). The reason written at the
  // time was "the remaining two providers have no trap that fails even when done right", and
  // that was proved wrong the same day: users hit `No scope requested can be granted for
  // this app` even with Dropbox, which is exactly the same shape. So it came back as
  // `OAuthHelp.misconfig`.
  it('lists the classic misconfigurations of this provider in the hint (the raw error is invisible to us, so it has to be given ahead of time)', async () => {
    const { deps } = fakeFetch([json({})]);
    const err = (await runAuthFlow(flow(undefined), deps, DROPBOX_SPEC, cfg, redirectUri).catch(
      (e: Error) => e,
    )) as Error;
    // Every one is there, and numbered in a list -- the user takes this message to the
    // authorization page to match things up. `hint` is now a `Msg` (since M9), while
    // `err.message` is the log string SyncError rendered in the base language (see the
    // constructor in errors.ts): both have to be in zh for the comparison to work.
    for (const hint of DROPBOX_SPEC.help.misconfig ?? []) {
      const text = renderMsg(hint, 'zh');
      expect(err.message, text).toContain(text);
    }
    expect(err.message).toMatch(/No scope requested/);
  });

  it('a callback from another session (state does not match) cannot get in', async () => {
    const { deps } = fakeFetch([json({ access_token: 'at' })]);
    await expect(
      runAuthFlow(flow('https://abc.chromiumapp.org/?code=x&state=someone-else'), deps, DROPBOX_SPEC, cfg, redirectUri),
    ).rejects.toThrow(/state 不匹配/);
  });

  it('does not even open the popup when client_id is missing', async () => {
    let opened = false;
    const flowDeps = {
      launchWebAuthFlow: async () => {
        opened = true;
        return undefined;
      },
    };
    const { deps } = fakeFetch([json({})]);
    await expect(
      runAuthFlow(flowDeps, deps, DROPBOX_SPEC, { enabled: true, clientId: '  ' }, redirectUri),
    ).rejects.toThrow(/client_id/);
    expect(opened).toBe(false);
  });
});

// ---------------------------------------------------------------- Registration guide copy

// After OneDrive was deleted on 2026-09-11, this group only has Dropbox left running.
// The assertions are still written as "loop over OAUTH_SPECS" -- they're a checklist for
// adding a third provider, not written for this one.
describe('OAuthSpec.help', () => {
  // When the user opens this card, they're looking at a path that starts with "go register
  // an app first". They deserve to know what that path costs before starting -- not to
  // connect for three days, find they have to reconnect, and come back to the docs.
  it('every provider says what this authorization will ask of the user (be upfront, do not make them guess)', () => {
    for (const spec of OAUTH_SPECS) {
      expect(spec.help.caution, spec.id).toBeTruthy();
    }
  });

  // This is why this whole block exists: the file lands somewhere the user can't see and
  // wouldn't think of (Dropbox's `/Apps/<app name>/`), nothing on the console page says so,
  // and after the first sync the user may go looking for that file in their own drive.
  // So every provider's caution has to answer "where does the thing land".
  it('the caution of every provider says where the file will end up', () => {
    for (const spec of OAUTH_SPECS) {
      // The catalog value is a `Msg`, so translate it to Chinese before checking -- it's
      // what the user reads in the README and on the settings page.
      const caution = spec.help.caution ? renderMsg(spec.help.caution, 'zh') : '';
      expect(caution, spec.id).toMatch(/文件夹|Apps\//);
    }
  });

  // The "misconfigured" checklist has to be written per provider. This isn't formalism:
  // `misconfig` is only read on the one branch where the popup errors, and on that branch
  // all we have is the provider itself -- an empty checklist means that provider's users
  // see nothing but a bare "the authorization window was closed".
  it('every provider says where to look when the config is wrong', () => {
    for (const spec of OAUTH_SPECS) {
      expect(spec.help.misconfig?.length ?? 0, spec.id).toBeGreaterThan(0);
    }
  });

  // The other half: don't advertise another provider on your own card -- those two hints
  // are written per provider, and copy-paste easily brings the previous one's copy along.
  it('the caution of each provider mentions only that provider', () => {
    for (const spec of OAUTH_SPECS) {
      for (const other of OAUTH_SPECS) {
        if (other.id === spec.id) continue;
        expect(spec.help.caution ?? '', `${spec.id} 提到了 ${other.displayName}`).not.toContain(
          other.displayName,
        );
      }
    }
  });
});

// ---------------------------------------------------------------- Token storage

/**
 * In-memory token store, also counting how many times set / clear were called.
 *
 * @param initial the token stored up front; omit it for "never connected"
 * @returns `state` is the current token and call counts, `store` is the implementation usable in production code
 */
function memoryStore(initial?: { accessToken: string; refreshToken?: string; expiresAt: number }) {
  const state: { token?: typeof initial; sets: number; clears: number } = {
    token: initial,
    sets: 0,
    clears: 0,
  };
  const store: TokenStore = {
    async get() {
      return state.token;
    },
    async set(_id, t) {
      state.sets += 1;
      state.token = t;
    },
    async clear() {
      state.clears += 1;
      state.token = undefined;
    },
  };
  return { state, store };
}

describe('makeTokenAccessor', () => {
  const future = () => Date.now() + 10 * 60 * 1000;
  const past = () => Date.now() - 1000;

  it('uses it directly when not expired, sending no request at all', async () => {
    const { store } = memoryStore({ accessToken: 'live', expiresAt: future() });
    const { calls, deps } = fakeFetch([]);
    const access = makeTokenAccessor({ ...deps, tokens: store }, DROPBOX_SPEC);
    expect(await access(cfg)).toBe('live');
    expect(calls).toEqual([]);
  });

  it('when expired, exchanges the refresh_token for a new one and writes it back', async () => {
    const { state, store } = memoryStore({
      accessToken: 'stale',
      refreshToken: 'rt',
      expiresAt: past(),
    });
    const { deps } = fakeFetch([json({ access_token: 'fresh', expires_in: 3600 })]);
    const access = makeTokenAccessor({ ...deps, tokens: store }, DROPBOX_SPEC);

    expect(await access(cfg)).toBe('fresh');
    expect(state.sets).toBe(1);
    expect(state.token?.accessToken).toBe('fresh');
  });

  it('never connected -> send the user to the settings page to click connect', async () => {
    const { store } = memoryStore(undefined);
    const { deps } = fakeFetch([]);
    const access = makeTokenAccessor({ ...deps, tokens: store }, DROPBOX_SPEC);
    await expect(access(cfg)).rejects.toThrow(/还没有连接/);
  });

  // When the authorization side gives no refresh_token (only an access_token), there's no
  // way forward once it expires and the user has to reconnect -- leaving an unrefreshable
  // record would look "connected", which is the most confusing state of all.
  it('expired with no refresh_token -> clear the record and ask the user to reconnect', async () => {
    const { state, store } = memoryStore({ accessToken: 'stale', expiresAt: past() });
    const { deps } = fakeFetch([]);
    const access = makeTokenAccessor({ ...deps, tokens: store }, DROPBOX_SPEC);

    await expect(access(cfg)).rejects.toThrow(/重新连接/);
    expect(state.clears).toBe(1);
  });

  it('refresh rejected (invalid_grant) -> clears the record the same way', async () => {
    const { state, store } = memoryStore({
      accessToken: 'stale',
      refreshToken: 'rt',
      expiresAt: past(),
    });
    const { deps } = fakeFetch([json({ error: 'invalid_grant' }, { status: 400 })]);
    const access = makeTokenAccessor({ ...deps, tokens: store }, DROPBOX_SPEC);

    await expect(access(cfg)).rejects.toThrow(/授权已失效/);
    expect(state.clears).toBe(1);
  });
});

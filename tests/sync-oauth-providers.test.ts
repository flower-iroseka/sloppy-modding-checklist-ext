import { describe, expect, it } from 'vitest';
import { DROPBOX_SPEC, dropboxApi } from '../src/core/sync/dropbox';
import { createOAuthProvider, type OAuthApi, type TokenStore } from '../src/core/sync/oauthProvider';
import type { OAuthSpec } from '../src/core/sync/oauth';
import type { OAuthConfig, SyncProvider } from '../src/core/sync/types';

const cfg: OAuthConfig = { enabled: true, clientId: 'cid' };
const DOC = '{"schemaVersion":1,"deviceId":"d","cells":{}}';

/**
 * A provider built on the OAuth layer (dropboxApi today): the shape of the requests it
 * sends, the remote file's metadata, and the isConfigured rules shared by all of them.
 *
 * Each shape assertion has a "what must not appear" half as well, because a test that
 * only checks "the value is in there somewhere" also passes an implementation that puts
 * it in the wrong place -- which is how the get_metadata bug below got out.
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
 * @returns the recorded calls, and a function usable directly as fetch
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
  return { calls, fetch: fn as unknown as typeof fetch };
}

/**
 * An "already connected" token store: 10 minutes left before it expires.
 *
 * @returns a store that only returns this one token; set / clear are no-ops
 */
function loginStore(): TokenStore {
  return {
    async get() {
      return { accessToken: 'tok', expiresAt: Date.now() + 600_000 };
    },
    async set() {},
    async clear() {},
  };
}

/**
 * Assemble a connected OAuth provider with a fake fetch.
 *
 * @param api this provider's API implementation, e.g. `dropboxApi`
 * @param spec this provider's OAuth spec
 * @param responses the responses the fake fetch should hand out, see fakeFetch
 * @returns the recorded calls, and the provider used as a SyncProvider
 */
function provider(api: OAuthApi, spec: OAuthSpec, responses: (Response | (() => Response))[]) {
  const f = fakeFetch(responses);
  const p = createOAuthProvider(spec, api, { fetch: f.fetch, tokens: loginStore() });
  return { calls: f.calls, p: p as SyncProvider };
}

// ---------------------------------------------------------------- Dropbox

describe('Dropbox', () => {
  const notFound = () =>
    new Response(JSON.stringify({ error_summary: 'path/not_found/..' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });

  // This test was originally written backwards: it asserted the params were in the
  // `Dropbox-API-Arg` header, but `get_metadata` is an RPC endpoint on
  // `api.dropboxapi.com` and the params belong in the JSON body. So the test and the
  // implementation made the same mistake and stayed green together -- until a user
  // clicked "测试连接" on a real machine and hit an HTTP 500.
  //
  // Lesson: a test that pins down a request's shape must also pin down "what shouldn't
  // appear". Asserting only that the path is in the header says nothing about "the body is
  // the right place", and any implementation passes it. The `not.toBeNull()` line below is
  // the half that actually blocks a regression.
  it('测试连接走 RPC 约定：参数在正文里，不在 Dropbox-API-Arg 头里', async () => {
    const { calls, p } = provider(dropboxApi, DROPBOX_SPEC, [new Response('{}', { status: 200 })]);
    await p.test(cfg);
    expect(calls[0].url).toBe('https://api.dropboxapi.com/2/files/get_metadata');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(calls[0].body))).toEqual({ path: '/modding-checklist.json' });

    // The half about mixing up the two conventions: this header belongs only to the
    // content endpoint, so appearing here is wrong.
    expect(calls[0].headers.get('Dropbox-API-Arg')).toBeNull();
  });

  // The control group is the "upload with mode=overwrite" test below: it goes to
  // `content.dropboxapi.com`, where the params belong in the `Dropbox-API-Arg` header.
  // Looking at both together shows this test can tell the two conventions apart, rather
  // than happening to be lax on both sides.

  // Dropbox's "file doesn't exist" is 409 + path/not_found, not 404 -- checking for 404
  // would report an error forever.
  it('还没传过文件（409 path/not_found）算连得上', async () => {
    const { p } = provider(dropboxApi, DROPBOX_SPEC, [notFound()]);
    await expect(p.test(cfg)).resolves.toBeUndefined();
  });

  it('读不到文件 → null', async () => {
    const { p } = provider(dropboxApi, DROPBOX_SPEC, [notFound()]);
    expect(await p.read(cfg)).toBeNull();
  });

  // This is the guardrail left by that real incident. For "you used the wrong convention"
  // Dropbox only returns a bare 500, and from the status code alone you'd read it as "the
  // server is down, retry later" -- except retrying makes no difference, ever. Carrying
  // the raw body through at least shows this isn't something waiting can fix.
  it('5xx 把服务端原文带进错误里', async () => {
    const { p } = provider(dropboxApi, DROPBOX_SPEC, [
      new Response('{"error_summary":"invalid_request ..."}', { status: 500 }),
    ]);
    const err = await p.test(cfg).catch((e) => e);
    expect(err.message).toMatch(/HTTP 500/);
    expect(err.message).toMatch(/invalid_request/);
    expect(err.retryable).toBe(true);
  });

  // Some gateways return a whole page of HTML on error, which is unreadable if pasted
  // into the message as-is.
  it('5xx 原文过长时截断', async () => {
    const { p } = provider(dropboxApi, DROPBOX_SPEC, [
      new Response('x'.repeat(5000), { status: 500 }),
    ]);
    const err = await p.test(cfg).catch((e) => e);
    expect(err.message.length).toBeLessThan(400);
    expect(err.message).toMatch(/…/);
  });

  it('5xx 但正文是空的：不硬塞一对空括号', async () => {
    const { p } = provider(dropboxApi, DROPBOX_SPEC, [new Response('', { status: 500 })]);
    const err = await p.test(cfg).catch((e) => e);
    expect(err.message).toMatch(/HTTP 500）/);
  });

  // File metadata lives in the response headers, not the body -- the body is the file itself.
  it('从 Dropbox-API-Result 响应头取 server_modified', async () => {
    const { calls, p } = provider(dropboxApi, DROPBOX_SPEC, [
      new Response(DOC, {
        status: 200,
        headers: {
          'Dropbox-API-Result': JSON.stringify({ server_modified: '2026-09-03T01:02:03Z' }),
        },
      }),
    ]);

    const remote = await p.read(cfg);
    expect(remote?.json).toBe(DOC);
    expect(remote?.modifiedAt).toBe(Date.parse('2026-09-03T01:02:03Z'));
    expect(calls[0].url).toBe('https://content.dropboxapi.com/2/files/download');
  });

  it('响应头缺失或不是 JSON 时只给正文，不炸', async () => {
    const { p } = provider(dropboxApi, DROPBOX_SPEC, [
      new Response(DOC, { status: 200, headers: { 'Dropbox-API-Result': 'not json' } }),
    ]);
    expect(await p.read(cfg)).toEqual({ json: DOC });
  });

  it('上传带 mode=overwrite，正文是 octet-stream', async () => {
    const { calls, p } = provider(dropboxApi, DROPBOX_SPEC, [new Response('{}', { status: 200 })]);
    await p.write(cfg, DOC);

    expect(calls[0].url).toBe('https://content.dropboxapi.com/2/files/upload');
    expect(JSON.parse(String(calls[0].headers.get('Dropbox-API-Arg')))).toEqual({
      path: '/modding-checklist.json',
      mode: 'overwrite',
      mute: true,
    });
    expect(calls[0].headers.get('Content-Type')).toBe('application/octet-stream');
    expect(calls[0].body).toBe(DOC);
  });
});

// ---------------------------------------------------------------- Shared behavior

describe('OAuth provider 的共同行为', () => {
  it('client_id 没填（或只有空白）就不算配置完整', () => {
    const { p } = provider(dropboxApi, DROPBOX_SPEC, []);
    expect(p.isConfigured({ enabled: true, clientId: '  ' })).toBe(false);
    expect(p.isConfigured(cfg)).toBe(true);
  });

  it('enabled 为 false 时也不算', () => {
    const { p } = provider(dropboxApi, DROPBOX_SPEC, []);
    expect(p.isConfigured({ enabled: false, clientId: 'cid' })).toBe(false);
  });

  // The only one in the catalog (Dropbox) is a public client (using PKCE), but
  // `requiresSecret` is a property of the client type, and the `||` that checks it is
  // still in the product code (`isConfigured`, OAuthCard's required-field star). Use a
  // synthetic "confidential client" spec to guard this branch -- if a provider that needs
  // a secret is added someday, we won't have to rethink how to write the test. (Google's
  // "Web application" was that kind, and it was cut entirely on 2026-09-11.)
  it('机密客户端缺 secret 就不完整', () => {
    const confidential: OAuthSpec = { ...DROPBOX_SPEC, requiresSecret: true };
    const { p } = provider(dropboxApi, confidential, []);
    expect(p.isConfigured({ enabled: true, clientId: 'cid' })).toBe(false);
    expect(p.isConfigured({ enabled: true, clientId: 'cid', clientSecret: 's' })).toBe(true);
  });

  it('不需要 secret 的那家缺 secret 也完整', () => {
    const { p } = provider(dropboxApi, DROPBOX_SPEC, []);
    expect(p.isConfigured({ enabled: true, clientId: 'cid' })).toBe(true);
  });

  it('没连接过时给的是「去设置页点连接」，而不是晦涩的 401', async () => {
    const f = fakeFetch([]);
    const p = createOAuthProvider(DROPBOX_SPEC, dropboxApi, {
      fetch: f.fetch,
      tokens: {
        async get() {
          return undefined;
        },
        async set() {},
        async clear() {},
      },
    });
    await expect(p.read(cfg)).rejects.toThrow(/还没有连接/);
    expect(f.calls).toHaveLength(0);
  });
});

import { describe, expect, it } from 'vitest';
import { SyncError } from '../src/core/sync/errors';
import {
  authHeader,
  collectionUrl,
  configOrigin,
  configOriginPattern,
  createWebDavProvider,
  remoteUrl,
  validateConfig,
} from '../src/core/sync/webdav';
import type { WebDavConfig } from '../src/core/sync/types';
import { renderMsg } from '../src/i18n';

const cfg: WebDavConfig = {
  enabled: true,
  baseUrl: 'https://dav.example.com/dav',
  username: 'me',
  password: 'pw',
};

/**
 * The WebDAV provider: URL assembly, config validation, and test / read / write.
 *
 * Servers disagree about which methods they support, so the negotiation is the part worth
 * pinning down: a 405 or 501 on PROPFIND has to fall back to probing the file, and the
 * error wording has to point at the real cause -- auth, path, or something retryable.
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
 * Fake fetch: hand out preset responses in call order, record every request, and build
 * a WebDAV provider on the side.
 *
 * Once the response list runs out, the last one is reused. Functions are used instead of
 * Response objects because a Response body can only be read once.
 *
 * @param responses the preset responses
 * @returns the recorded calls, and a provider wired to this fake fetch
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
    return typeof next === 'function' ? next() : next.clone();
  };
  return { calls, provider: createWebDavProvider({ fetch: fn as unknown as typeof fetch }) };
}

describe('URL joining and validation', () => {
  it('the collection URL has no file name, the file URL does', () => {
    expect(collectionUrl(cfg)).toBe('https://dav.example.com/dav');
    expect(remoteUrl(cfg)).toBe('https://dav.example.com/dav/modding-checklist.json');
  });

  it('extra slashes on either end of the subfolder are normalized away', () => {
    expect(collectionUrl({ ...cfg, path: '/osu/' })).toBe('https://dav.example.com/dav/osu');
  });

  it('a trailing slash on baseUrl does not produce a double slash', () => {
    expect(collectionUrl({ ...cfg, baseUrl: 'https://a.com/dav/' })).toBe('https://a.com/dav');
  });

  it('configOrigin only accepts http(s)', () => {
    expect(configOrigin(cfg)).toBe('https://dav.example.com');
    expect(configOrigin({ ...cfg, baseUrl: 'ftp://a.com/x' })).toBeNull();
    expect(configOrigin({ ...cfg, baseUrl: 'dav.example.com' })).toBeNull();
    expect(configOriginPattern(cfg)).toBe('https://dav.example.com/*');
  });

  it('validateConfig names each missing item', () => {
    expect(validateConfig(cfg)).toBeNull();
    // The return value is a `Msg` (since M9), so render it to Chinese before looking for
    // the word -- that rendered sentence is what the user sees. Rendering here also pins
    // down that the return value isn't already a sentence.
    /**
     * Render the error copy, checking along the way that it comes back as a Msg and not a
     * string.
     *
     * @param c the config to validate
     * @returns the error copy in Chinese
     */
    const say = (c: typeof cfg) => {
      const msg = validateConfig(c);
      expect(typeof msg, '不过配置时该返回 Msg，不是渲染好的字符串').toBe('object');
      return renderMsg(msg!, 'zh');
    };
    expect(say({ ...cfg, baseUrl: '' })).toMatch(/服务器地址/);
    expect(say({ ...cfg, baseUrl: 'dav.example.com' })).toMatch(/http/);
    expect(say({ ...cfg, username: '' })).toMatch(/账号/);
    expect(say({ ...cfg, password: '' })).toMatch(/密码/);
  });

  it('a disabled provider does not count as configured', () => {
    const { provider } = fakeFetch([]);
    expect(provider.isConfigured({ ...cfg, enabled: false })).toBe(false);
  });

  // btoa can't handle non-ASCII and throws InvalidCharacterError, which the user sees as
  // "clicking save crashes".
  it('non-ASCII credentials do not make authHeader throw', () => {
    expect(() => authHeader({ ...cfg, username: '中文', password: '密码' })).not.toThrow();
    const decoded = Buffer.from(authHeader({ ...cfg, username: '中文', password: '密码' }).slice(6), 'base64').toString('utf8');
    expect(decoded).toBe('中文:密码');
  });
});

describe('test()', () => {
  it('PROPFIND gets 207 -> passes', async () => {
    const { calls, provider } = fakeFetch([new Response('', { status: 207 })]);
    await provider.test(cfg);
    expect(calls[0].method).toBe('PROPFIND');
    expect(calls[0].url).toBe('https://dav.example.com/dav');
    expect(calls[0].headers.get('Depth')).toBe('0');
    expect(calls[0].headers.get('Authorization')).toBe(authHeader(cfg));
  });

  it('PROPFIND gets 401 -> say auth was rejected, not "path not found"', async () => {
    const { provider } = fakeFetch([new Response('', { status: 401 })]);
    await expect(provider.test(cfg)).rejects.toThrow(/认证/);
  });

  it('PROPFIND gets 404 -> point at the path/subfolder', async () => {
    const { provider } = fakeFetch([new Response('', { status: 404 })]);
    await expect(provider.test(cfg)).rejects.toThrow(/路径/);
  });

  it('server rejects PROPFIND (405) -> fall back to a probe file; a 404 file means "reachable, just not created yet"', async () => {
    const { calls, provider } = fakeFetch([
      new Response('', { status: 405 }),
      new Response('', { status: 404 }),
    ]);
    await provider.test(cfg);
    expect(calls.map((c) => c.method)).toEqual(['PROPFIND', 'GET']);
    expect(calls[1].url).toContain('modding-checklist.json');
  });

  it('PROPFIND 501 falls back the same way, and an existing file (200) also passes', async () => {
    const { provider } = fakeFetch([
      new Response('', { status: 501 }),
      new Response('{}', { status: 200 }),
    ]);
    await expect(provider.test(cfg)).resolves.toBeUndefined();
  });

  it('still 401 after the fallback -> throws an auth error', async () => {
    const { provider } = fakeFetch([
      new Response('', { status: 405 }),
      new Response('', { status: 401 }),
    ]);
    await expect(provider.test(cfg)).rejects.toThrow(/认证/);
  });

  it('does not go to the network when the config is incomplete, it throws right away', async () => {
    const { calls, provider } = fakeFetch([]);
    await expect(provider.test({ ...cfg, password: '' })).rejects.toThrow(/密码/);
    expect(calls).toEqual([]);
  });

  it('when it cannot connect the error carries the host name and is marked retryable', async () => {
    const provider = createWebDavProvider({
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch,
    });
    const err = await provider.test(cfg).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncError);
    expect((err as SyncError).message).toContain('dav.example.com');
    expect((err as SyncError).retryable).toBe(true);
  });
});

describe('read()', () => {
  it('404 -> null (no file on the remote yet is not an error)', async () => {
    const { provider } = fakeFetch([new Response('', { status: 404 })]);
    expect(await provider.read(cfg)).toBeNull();
  });

  it('200 -> the body plus Last-Modified as the fallback clock', async () => {
    const { provider } = fakeFetch([
      new Response('{"a":1}', {
        status: 200,
        headers: { 'Last-Modified': 'Wed, 01 Jan 2025 00:00:00 GMT' },
      }),
    ]);
    const doc = await provider.read(cfg);
    expect(doc?.json).toBe('{"a":1}');
    expect(doc?.modifiedAt).toBe(Date.parse('Wed, 01 Jan 2025 00:00:00 GMT'));
  });

  it('does not make up a time when there is no Last-Modified', async () => {
    const { provider } = fakeFetch([new Response('{"a":1}', { status: 200 })]);
    expect((await provider.read(cfg))?.modifiedAt).toBeUndefined();
  });

  it('500 -> throws and is marked retryable', async () => {
    const { provider } = fakeFetch([new Response('', { status: 500 })]);
    const err = await provider.read(cfg).catch((e: unknown) => e);
    expect((err as SyncError).retryable).toBe(true);
  });
});

describe('write()', () => {
  it('PUTs to the file URL with a JSON content-type and basic auth', async () => {
    const { calls, provider } = fakeFetch([new Response('', { status: 201 })]);
    await provider.write(cfg, '{"a":1}');

    expect(calls[0].method).toBe('PUT');
    expect(calls[0].url).toBe('https://dav.example.com/dav/modding-checklist.json');
    expect(calls[0].headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(calls[0].headers.get('Authorization')).toBe(authHeader(cfg));
    expect(calls[0].body).toBe('{"a":1}');
  });

  it('403 -> throws, suggesting a check of the username and password', async () => {
    const { provider } = fakeFetch([new Response('', { status: 403 })]);
    await expect(provider.write(cfg, '{}')).rejects.toThrow(/认证/);
  });

  it('a non-ASCII password goes through the whole path without throwing', async () => {
    const { provider } = fakeFetch([new Response('', { status: 201 })]);
    await expect(
      provider.write({ ...cfg, username: '用户', password: '密' }, '{}'),
    ).resolves.toBeUndefined();
  });
});

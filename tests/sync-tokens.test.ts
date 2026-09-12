import { describe, expect, it } from 'vitest';
import { normalizeTokens } from '../src/core/sync/tokens';

/**
 * Token normalization, the read path for the single `syncTokens` storage key.
 *
 * The layer looks thin, but it's the only place that can clean up abandoned credentials:
 * `clearToken` needs an id to delete anything, and nothing calls it for a provider that
 * has already left the catalog. That is the Google Drive refresh_token still sitting in
 * old profiles (cut 2026-09-11) -- no code reads it, and nothing would ever delete it.
 */

/** A valid token with every field present. */
const ok = { accessToken: 'at', expiresAt: 123, refreshToken: 'rt', scope: 's' };

describe('normalizeTokens', () => {
  it('正常的记录原样读回来', () => {
    expect(normalizeTokens({ dropbox: ok })).toEqual({ dropbox: ok });
  });

  it('可选字段缺了就不出现（不是留个 undefined 的洞）', () => {
    expect(normalizeTokens({ dropbox: { accessToken: 'at', expiresAt: 1 } })).toEqual({
      dropbox: { accessToken: 'at', expiresAt: 1 },
    });
  });

  // This is why this block exists: Google Drive is no longer in PROVIDER_IDS, but the
  // refresh_token in old profiles is still there. No code reads it, so unless this drops
  // it, it stays forever -- a credential nobody uses and nobody would remember to delete.
  it('目录里已经没有的 provider → 丢掉（比如被砍掉的 googleDrive）', () => {
    expect(normalizeTokens({ dropbox: ok, googleDrive: { accessToken: 'old', expiresAt: 1 } })).toEqual({
      dropbox: ok,
    });
  });

  // The other half of the same thing: if that provider is ever added back, the old record
  // must not be taken as "already connected".
  it('只剩废弃 id 时 → 空对象，而不是「还留着一条」', () => {
    expect(normalizeTokens({ googleDrive: { accessToken: 'old', expiresAt: 1 } })).toEqual({});
  });

  it('缺 accessToken 或 expiresAt 不是数字 → 丢掉', () => {
    expect(normalizeTokens({ dropbox: { accessToken: 'at' } })).toEqual({});
    expect(normalizeTokens({ dropbox: { accessToken: 'at', expiresAt: '123' } })).toEqual({});
    expect(normalizeTokens({ dropbox: { expiresAt: 1 } })).toEqual({});
  });

  it('垃圾输入 → 空对象（不是抛错）', () => {
    for (const raw of [null, undefined, 0, 'x', [], { dropbox: null }]) {
      expect(normalizeTokens(raw)).toEqual({});
    }
  });
});

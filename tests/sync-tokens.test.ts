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
  it('a normal record reads back unchanged', () => {
    expect(normalizeTokens({ dropbox: ok })).toEqual({ dropbox: ok });
  });

  it('a missing optional field just does not appear (no undefined hole left behind)', () => {
    expect(normalizeTokens({ dropbox: { accessToken: 'at', expiresAt: 1 } })).toEqual({
      dropbox: { accessToken: 'at', expiresAt: 1 },
    });
  });

  // This is why this block exists: Google Drive is no longer in PROVIDER_IDS, but the
  // refresh_token in old profiles is still there. No code reads it, so unless this drops
  // it, it stays forever -- a credential nobody uses and nobody would remember to delete.
  it('a provider no longer in the catalog -> dropped (e.g. the retired googleDrive)', () => {
    expect(normalizeTokens({ dropbox: ok, googleDrive: { accessToken: 'old', expiresAt: 1 } })).toEqual({
      dropbox: ok,
    });
  });

  // The other half of the same thing: if that provider is ever added back, the old record
  // must not be taken as "already connected".
  it('only a retired id left -> empty object, not "one record still there"', () => {
    expect(normalizeTokens({ googleDrive: { accessToken: 'old', expiresAt: 1 } })).toEqual({});
  });

  it('missing accessToken, or expiresAt not a number -> dropped', () => {
    expect(normalizeTokens({ dropbox: { accessToken: 'at' } })).toEqual({});
    expect(normalizeTokens({ dropbox: { accessToken: 'at', expiresAt: '123' } })).toEqual({});
    expect(normalizeTokens({ dropbox: { expiresAt: 1 } })).toEqual({});
  });

  it('garbage input -> empty object (not a throw)', () => {
    for (const raw of [null, undefined, 0, 'x', [], { dropbox: null }]) {
      expect(normalizeTokens(raw)).toEqual({});
    }
  });
});

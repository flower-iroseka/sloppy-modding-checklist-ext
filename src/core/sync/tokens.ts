/**
 * Persisting OAuth tokens (CODING_PLAN §7.6).
 *
 * Tokens get their own key because they're runtime data: only the service worker reads and
 * writes them, and they must never show up in exported settings. `SyncSettings` is meant to
 * be edited, exported and imported by the user, so mixing the two would sooner or later sweep
 * the tokens into some "export all settings" feature. Writes go one record per provider, not
 * read-all-then-write-all, so refreshing one token can't bury another's newer record.
 */
import { onKeyChanged, readKey, removeKey, writeKey } from '../storage';
import { PROVIDER_IDS } from './settings';
import type { ProviderId } from './types';
import type { TokenSet } from './oauth';

/** The `chrome.storage` key holding the tokens. */
export const SYNC_TOKENS_KEY = 'syncTokens';

/** Each provider's current token; providers never connected have no key. */
export type TokenMap = Partial<Record<ProviderId, TokenSet>>;

/**
 * These two are `TokenSet`'s required fields; having them makes it a usable record.
 *
 * @param raw the raw value read from storage
 * @returns whether it's a usable token
 */
function isTokenSet(raw: unknown): raw is TokenSet {
  if (!raw || typeof raw !== 'object') return false;
  const o = raw as Record<string, unknown>;
  return typeof o.accessToken === 'string' && typeof o.expiresAt === 'number';
}

/**
 * Normalize. Iterates over `PROVIDER_IDS` rather than over storage's keys -- ids no longer
 * in the catalog get dropped (added when M7 cut Google Drive). Two reasons: a deleted
 * provider's refresh_token is a credential nobody will ever clear again, and keeping it
 * means no code can read it anyway, so it's pure dead weight; worse, if it's ever added back
 * we'd read out a ticket from years ago, show "● Connected" straight away, and that ticket expired
 * long ago.
 *
 * @param raw the raw value read from storage
 * @returns only the tokens of providers the catalog recognizes
 */
export function normalizeTokens(raw: unknown): TokenMap {
  if (!raw || typeof raw !== 'object') return {};
  const src = raw as Record<string, unknown>;
  const out: TokenMap = {};
  for (const id of PROVIDER_IDS) {
    const value = src[id];
    if (!isTokenSet(value)) continue;
    out[id] = {
      accessToken: value.accessToken,
      ...(typeof value.refreshToken === 'string' ? { refreshToken: value.refreshToken } : {}),
      expiresAt: value.expiresAt,
      ...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
    };
  }
  return out;
}

/**
 * @returns each provider's current token
 */
export async function readTokens(): Promise<TokenMap> {
  return normalizeTokens(await readKey(SYNC_TOKENS_KEY));
}

/**
 * @param id which provider
 * @returns that provider's token; undefined when it was never connected
 */
export async function getToken(id: ProviderId): Promise<TokenSet | undefined> {
  return (await readTokens())[id];
}

/**
 * Write one provider's token. Read, then merge, but touch only that provider's key -- if
 * another provider is refreshed between those two steps, its new value is still in storage
 * and won't be buried by this snapshot.
 *
 * @param id which provider
 * @param token the new token, replacing the whole record
 */
export async function setToken(id: ProviderId, token: TokenSet): Promise<void> {
  const all = await readTokens();
  await writeKey(SYNC_TOKENS_KEY, { ...all, [id]: token });
}

/**
 * Delete one provider's token; when that empties it out, drop the whole key too.
 *
 * @param id which provider
 */
export async function clearToken(id: ProviderId): Promise<void> {
  const all = await readTokens();
  delete all[id];
  if (Object.keys(all).length === 0) {
    await removeKey(SYNC_TOKENS_KEY);
    return;
  }
  await writeKey(SYNC_TOKENS_KEY, all);
}

/**
 * Whether this provider is connected. Returns only a boolean, never the token -- the
 * settings page uses it to render "● Connected / ○ Not connected", so the "pages don't touch
 * credentials" constraint doesn't need an exception.
 *
 * @param id which provider
 * @returns true when a non-empty token is stored
 */
export async function hasToken(id: ProviderId): Promise<boolean> {
  const t = await getToken(id);
  return t !== undefined && t.accessToken !== '';
}

/**
 * Notify when tokens change (the settings page refreshes its "● Connected" text from this). Again
 * only booleans.
 *
 * @param cb the ids of providers that currently have a token, received after a change
 * @returns an unsubscribe function
 */
export function onTokensChanged(cb: (changed: ProviderId[]) => void): () => void {
  return onKeyChanged(SYNC_TOKENS_KEY, (raw) => {
    const ids = Object.keys(normalizeTokens(raw)) as ProviderId[];
    cb(ids);
  });
}

import { isMessageKey, type MessageKey, type Msg, type MsgParam } from '../../i18n';
import { onKeyChanged, readKey, writeKey } from '../storage';
import type {
  LocalFolderConfig,
  OAuthConfig,
  ProviderConfig,
  ProviderId,
  SyncSettings,
  SyncStatus,
  SyncStrategy,
  WebDavConfig,
} from './types';

/** The `chrome.storage` key holding the settings. */
export const SYNC_SETTINGS_KEY = 'syncSettings';
/** The `chrome.storage` key holding the sync status. */
export const SYNC_STATUS_KEY = 'syncStatus';

/**
 * Same order as `PROVIDER_CATALOG` (that one drives display, this one drives iteration
 * order when persisting).
 */
export const PROVIDER_IDS: ProviderId[] = ['localFolder', 'webdav', 'dropbox'];

/**
 * Display names for the conflict strategies. Keys, not strings -- the same dropdown lives on
 * the settings page, and the user can switch languages at any time (see
 * `src/i18n/types.ts`).
 *
 * There used to be a `PROVIDER_LABEL` here too (the providers' Chinese names) and it's been
 * deleted: it duplicated `registry.PROVIDER_CATALOG`'s `labelKey`, and with two copies,
 * changing one and forgetting the other throws no error -- it just leaves the dropdown's
 * names disagreeing with everywhere else.
 */
export const STRATEGY_LABEL_KEY: Record<SyncStrategy, MessageKey> = {
  'newest-wins': 'strategy.newest-wins',
  'local-wins': 'strategy.local-wins',
  'remote-wins': 'strategy.remote-wins',
  ask: 'strategy.ask',
};

/**
 * An empty settings object; `normalizeSyncSettings` uses it as the fallback.
 *
 * @returns the default settings
 */
export function defaultSyncSettings(): SyncSettings {
  return {
    activeProvider: null,
    config: {},
    autoSync: false,
    pullOnStart: false,
    strategy: 'newest-wins',
  };
}

/**
 * Anything that isn't a string counts as an empty string.
 *
 * @param v the raw value read from storage
 * @returns the string; an empty one when it isn't a string
 */
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Only a real `true` counts as true.
 *
 * @param v the raw value read from storage
 * @returns true only for a real `true`
 */
function bool(v: unknown): boolean {
  return v === true;
}

/**
 * Normalize WebDAV config: baseUrl drops its trailing slash (added uniformly when joining
 * the file name), path drops slashes at both ends.
 *
 * @param raw the raw value read from storage
 * @returns the normalized config
 */
export function normalizeWebDavConfig(raw: unknown): WebDavConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: bool(o.enabled),
    baseUrl: str(o.baseUrl).trim().replace(/\/+$/, ''),
    username: str(o.username).trim(),
    password: str(o.password),
    path: str(o.path).trim().replace(/^\/+|\/+$/g, ''),
  };
}

/**
 * Normalize OAuth config. client_secret has leading/trailing whitespace trimmed but not
 * internal whitespace (it might genuinely contain spaces).
 *
 * @param raw the raw value read from storage
 * @returns the normalized config
 */
function normalizeOAuthConfig(raw: unknown): OAuthConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const extra = o.extra;
  const secret = str(o.clientSecret).trim();
  return {
    enabled: bool(o.enabled),
    clientId: str(o.clientId).trim(),
    ...(secret ? { clientSecret: secret } : {}),
    ...(extra && typeof extra === 'object' && !Array.isArray(extra)
      ? { extra: extra as Record<string, string> }
      : {}),
  };
}

/**
 * Normalize local sync folder config. It keeps only a name for display -- the handle isn't
 * here, it lives in IndexedDB (§7.7).
 *
 * @param raw the raw value read from storage
 * @returns the normalized config
 */
export function normalizeLocalFolderConfig(raw: unknown): LocalFolderConfig {
  const o = (raw ?? {}) as Record<string, unknown>;
  const name = str(o.folderName).trim();
  return { enabled: bool(o.enabled), ...(name ? { folderName: name } : {}) };
}

/**
 * Dispatch to each provider's normalize function.
 *
 * @param id which provider
 * @param raw the raw value read from storage
 * @returns the normalized config
 */
function normalizeConfig(id: ProviderId, raw: unknown): ProviderConfig {
  if (id === 'localFolder') return normalizeLocalFolderConfig(raw);
  return id === 'webdav' ? normalizeWebDavConfig(raw) : normalizeOAuthConfig(raw);
}

/**
 * @param v the raw value read from storage
 * @returns a recognized strategy; falls back to the default `newest-wins` when unrecognized
 */
function normalizeStrategy(v: unknown): SyncStrategy {
  return v === 'local-wins' || v === 'remote-wins' || v === 'ask' || v === 'newest-wins'
    ? v
    : 'newest-wins';
}

/**
 * @param v the raw value read from storage
 * @returns the id if the catalog recognizes it; otherwise null
 */
function normalizeProviderId(v: unknown): ProviderId | null {
  return typeof v === 'string' && (PROVIDER_IDS as string[]).includes(v)
    ? (v as ProviderId)
    : null;
}

/**
 * Normalize settings. Same idea as `normalizeDoc`: storage might hold an old version or
 * JSON someone edited by hand, so everything is normalized before it enters memory, and
 * "missing field / wrong type" is dealt with in one layer. Unknown fields are dropped (this
 * includes other providers' configs: even when activeProvider is webdav, they have to be
 * read back, otherwise switching provider once would wipe what the others had filled in).
 *
 * @param raw the raw value read from storage
 * @returns the normalized settings
 */
export function normalizeSyncSettings(raw: unknown): SyncSettings {
  const base = defaultSyncSettings();
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Record<string, unknown>;

  const cfgRaw = (o.config ?? {}) as Record<string, unknown>;
  const config: Partial<Record<ProviderId, ProviderConfig>> = {};
  for (const id of PROVIDER_IDS) {
    if (cfgRaw[id] !== undefined) config[id] = normalizeConfig(id, cfgRaw[id]);
  }

  return {
    activeProvider: normalizeProviderId(o.activeProvider),
    config,
    autoSync: bool(o.autoSync),
    pullOnStart: bool(o.pullOnStart),
    strategy: normalizeStrategy(o.strategy),
  };
}

/**
 * Backward-compatible read for `lastError`.
 *
 * Before M9 it stored a rendered Chinese string; after that it stores a `Msg`. Old data gets
 * wrapped in `err.raw` and keeps working: that sentence was rendered in the language of the
 * time and can't be mapped back to a key, but an upgrade shouldn't make that error vanish
 * from the settings page (the user would think the problem fixed itself). It gets cleared
 * normally on the next successful sync.
 *
 * @param raw the raw value read from storage
 * @returns the error's `Msg`; null when it can't be read
 */
function normalizeStoredError(raw: unknown): Msg | null {
  if (typeof raw === 'string' && raw) return { key: 'err.raw', params: { detail: raw } };
  if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    // The key has to be a real key in the catalog, otherwise rendering degrades to printing
    // the key
    if (isMessageKey(o.key)) {
      return { key: o.key, ...(o.params ? { params: o.params as Record<string, MsgParam> } : {}) };
    }
  }
  return null;
}

/**
 * Normalize status; a missing or wrongly-typed field means that entry gets dropped.
 *
 * @param raw the raw value read from storage
 * @returns the normalized status
 */
export function normalizeSyncStatus(raw: unknown): SyncStatus {
  if (!raw || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const pending = o.pendingConflict as Record<string, unknown> | undefined;
  const lastError = normalizeStoredError(o.lastError);
  return {
    ...(typeof o.lastSyncAt === 'number' ? { lastSyncAt: o.lastSyncAt } : {}),
    ...(lastError ? { lastError } : {}),
    ...(o.lastAction === 'push' || o.lastAction === 'pull' ? { lastAction: o.lastAction } : {}),
    ...(pending && typeof pending.remoteJson === 'string' && (pending.kind === 'push' || pending.kind === 'pull')
      ? {
          pendingConflict: {
            kind: pending.kind,
            remoteJson: pending.remoteJson,
            remoteUpdatedAt: typeof pending.remoteUpdatedAt === 'number' ? pending.remoteUpdatedAt : 0,
            localUpdatedAt: typeof pending.localUpdatedAt === 'number' ? pending.localUpdatedAt : 0,
          },
        }
      : {}),
  };
}

/**
 * Read the settings (normalize on the way out).
 *
 * @returns the current settings
 */
export async function readSyncSettings(): Promise<SyncSettings> {
  return normalizeSyncSettings(await readKey(SYNC_SETTINGS_KEY));
}

/**
 * Write the settings.
 *
 * @param settings the settings to store
 */
export async function writeSyncSettings(settings: SyncSettings): Promise<void> {
  await writeKey(SYNC_SETTINGS_KEY, settings);
}

/**
 * Read the sync status (normalize on the way out).
 *
 * @returns the current status
 */
export async function readSyncStatus(): Promise<SyncStatus> {
  return normalizeSyncStatus(await readKey(SYNC_STATUS_KEY));
}

/**
 * Write the sync status.
 *
 * @param status the status to store
 */
export async function writeSyncStatus(status: SyncStatus): Promise<void> {
  await writeKey(SYNC_STATUS_KEY, status);
}

/**
 * Subscribe to settings changes.
 *
 * @param cb the (normalized) settings received after a change
 * @returns an unsubscribe function
 */
export function onSyncSettingsChanged(cb: (s: SyncSettings) => void): () => void {
  return onKeyChanged(SYNC_SETTINGS_KEY, (raw) => cb(normalizeSyncSettings(raw)));
}

/**
 * Subscribe to status changes.
 *
 * @param cb the (normalized) status received after a change
 * @returns an unsubscribe function
 */
export function onSyncStatusChanged(cb: (s: SyncStatus) => void): () => void {
  return onKeyChanged(SYNC_STATUS_KEY, (raw) => cb(normalizeSyncStatus(raw)));
}

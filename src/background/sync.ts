// The scheduling side of sync (CODING_PLAN §7.2).
//
// Networking, tokens and timers all live in the service worker; the page only sends messages,
// since it never touches credentials and a scheduled job like "pull every 60 minutes" can only be
// attached to the SW anyway.
import type { Msg } from '../i18n';
import { getStorageArea, readDoc, removeKey, writeDoc, writeKey } from '../core/storage';
import type { ChecklistDoc } from '../core/types';
import { describeError, SyncError } from '../core/sync/errors';
import { folderPermission, loadFolderHandle } from '../core/sync/folderHandle';
import {
  bindProvider,
  runPull,
  runPush,
  type BackupSide,
  type SyncDeps,
  type SyncOutcome,
} from '../core/sync/manager';
import { runAuthFlow, type TokenSet } from '../core/sync/oauth';
import { createProviders, findSpec, getProvider, providerLabelMsg } from '../core/sync/registry';
import { readSyncSettings, readSyncStatus, writeSyncStatus } from '../core/sync/settings';
import { clearToken, getToken, setToken } from '../core/sync/tokens';
import type { OAuthConfig, ProviderConfig, ProviderId, SyncProvider, SyncSettings } from '../core/sync/types';

/** Alarm name for the periodic pull. */
export const SYNC_ALARM = 'mc-sync-periodic';
/** Interval of the periodic pull. Multi-device drift isn't a realtime need, an hour is plenty, and it's less likely to trip the server's rate limit. */
export const SYNC_INTERVAL_MINUTES = 60;
/** Minimum gap for "pull when the extension opens": if we pulled within the last ten minutes, don't pull again. */
export const PULL_ON_START_MIN_GAP_MS = 10 * 60 * 1000;
/** Alarm name for the debounced auto-push. */
export const AUTOPUSH_ALARM = 'mc-sync-autopush';
/**
 * How long to wait after a local change before pushing.
 *
 * 0.5 minutes = 30 seconds, which is also Chrome's minimum granularity for alarms (anything
 * smaller gets clamped up). The checklist is edited while you read it: ticking a box and writing
 * a note are each one write, and the debounce folds a string of changes into one push.
 */
export const AUTOPUSH_DEBOUNCE_MINUTES = 0.5;
/** How many backups to keep (counted separately for local/remote). Backups are insurance, not history. */
const KEEP_BACKUPS = 5;

/**
 * Runtime deps for the providers, assembled only in the service worker: `launchWebAuthFlow` and
 * token reads/writes all stay on this side, so the page never gets credentials (§7.6).
 *
 * Pulled out into a constant instead of inlined because both the auth flow (`syncConnect`) and the
 * providers themselves need the same object -- if each wrote its own `fetch` wrapper, tests would
 * have two injection points to replace.
 */
const providerDeps = {
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  launchWebAuthFlow: (options: { url: string; interactive: boolean }) =>
    chrome.identity.launchWebAuthFlow(options),
  tokens: {
    get: getToken,
    set: setToken,
    clear: clearToken,
  },
  // Picking a folder can only happen in an extension page (`showDirectoryPicker` doesn't exist
  // in the SW), but the handle lives in same-origin IndexedDB, so the background can fetch it back
  // and read/write directly -- none of the existing sync / upload / download logic needs a change
  // for it (§7.7).
  folder: {
    load: loadFolderHandle,
    permissionOf: folderPermission,
  },
};

/** All provider implementations, indexed by `ProviderId`. */
const providers = createProviders(providerDeps);

/** Get the current time, fed to `SyncDeps.now`. */
function now(): number {
  return Date.now();
}

/**
 * "This DOC_KEY change was sync writing back to itself, don't treat it as a user edit."
 *
 * A pull writes remote content into local, which is also a storage change -- without blocking it,
 * every pull would schedule an auto-push right after, and the user would see "Uploading…" pop up
 * the moment the pull finishes. When the content is identical the push is a no-op (`planPush`
 * returns `none` and writes nothing), but it still has to make a network request to compare.
 *
 * A counter rather than a boolean, so that when the paired writes pile up we don't miss the later
 * one. A failed write has to give the slot back: that write didn't happen, so no `onChanged` will
 * come to consume it.
 */
let selfWrites = 0;

/**
 * Write the doc back to local and record "this one was ours". See `selfWrites`.
 *
 * @param doc the doc to write
 * @throws whatever `writeDoc` throws; the counter is rolled back first, so the failed write
 *   doesn't leave a slot behind for an `onChanged` that will never come
 */
async function writeLocalDocQuietly(doc: ChecklistDoc): Promise<void> {
  selfWrites += 1;
  try {
    await writeDoc(doc);
  } catch (e) {
    selfWrites -= 1;
    throw e;
  }
}

// ---------------------------------------------------------------- Backups

/**
 * List the backup keys for one side, oldest to newest.
 *
 * @param prefix prefix of the backup keys, see `backup`
 * @returns the sorted list of keys
 */
async function listBackupKeys(prefix: string): Promise<string[]> {
  const all = await getStorageArea().get(null);
  return Object.keys(all)
    .filter((k) => k.startsWith(prefix))
    // `checklist-backup-<ts>`: ts is a millisecond timestamp, so string order is time order
    .sort();
}

/**
 * Save a JSON blob as a backup and delete the oldest ones beyond `KEEP_BACKUPS` while we're at it.
 *
 * @param side which side is being backed up, decides which prefix the key uses
 * @param json what to back up
 * @returns the backup key
 */
async function backup(side: BackupSide, json: string): Promise<string> {
  const prefix = side === 'local' ? 'checklist-backup-' : 'checklist-remote-backup-';
  const key = `${prefix}${now()}`;
  await writeKey(key, json);

  const keys = await listBackupKeys(prefix);
  for (const stale of keys.slice(0, Math.max(0, keys.length - KEEP_BACKUPS))) {
    await removeKey(stale);
  }
  return key;
}

// ---------------------------------------------------------------- deps

/**
 * Get the currently active provider and its config, or throw a plain-language error if it isn't set up.
 *
 * @param settings current sync settings
 * @returns the configured provider and its config
 * @throws {SyncError} no provider, or this one isn't fully configured yet
 */
function requireReady(settings: SyncSettings): { config: ProviderConfig; provider: SyncProvider } {
  const provider = getProvider(providers, settings.activeProvider);
  if (!provider) throw new SyncError({ key: 'err.bg.noProvider' });
  const config = settings.activeProvider ? settings.config[settings.activeProvider] : undefined;
  if (!config || !provider.isConfigured(config)) {
    throw new SyncError({
      key: 'err.bg.notConfigured',
      params: { provider: { key: provider.displayName } },
    });
  }
  return { config, provider };
}

/**
 * Assemble the deps one sync run needs, based on the current settings.
 *
 * @param settings current sync settings
 * @returns the deps `runPush` / `runPull` want
 */
function makeDeps(settings: SyncSettings): SyncDeps {
  const { config, provider } = requireReady(settings);
  return {
    provider: bindProvider(provider, config),
    strategy: settings.strategy,
    now,
    readLocalDoc: async () => {
      const doc = await readDoc();
      if (!doc) throw new SyncError({ key: 'err.bg.noLocalDoc' });
      return doc;
    },
    writeLocalDoc: writeLocalDocQuietly,
    backup,
  };
}

// ---------------------------------------------------------------- Status

/**
 * Record a successful action.
 *
 * The whole status object is rebuilt, so `lastError` gets cleared for free (this run succeeded).
 * But `pendingConflict` can't be cleared unconditionally: `action: 'none'` may just mean "nothing
 * to sync", and the conflict the user hasn't answered yet is still hanging there -- wiping it
 * before the question was even asked.
 *
 * @param outcome the sync result that just finished
 */
async function record(outcome: SyncOutcome): Promise<void> {
  const prev = await readSyncStatus();
  const action = outcome.action === 'none' ? prev.lastAction : outcome.action;
  const pending = outcome.conflict ?? (outcome.action === 'none' ? prev.pendingConflict : undefined);
  await writeSyncStatus({
    lastSyncAt: now(),
    ...(action ? { lastAction: action } : {}),
    ...(pending ? { pendingConflict: pending } : {}),
  });
}

/**
 * Record a failure.
 *
 * Only touch `lastError`, don't rebuild the status into a new one: an unrelated failure (say a
 * typo in the password while testing the connection) shouldn't wipe `lastSyncAt` (the settings
 * page would suddenly show "—", and `autoPull('start')`'s ten-minute throttle would break) or the
 * user's unanswered `pendingConflict` (the prompt vanishes out of nowhere while the conflict itself
 * is still there).
 *
 * @param e the caught error
 */
async function recordError(e: unknown): Promise<void> {
  const prev = await readSyncStatus();
  await writeSyncStatus({ ...prev, lastError: describeError(e) });
}

// ---------------------------------------------------------------- Public actions

/**
 * Try a connection once, only verifying credentials and paths, without touching data. On success
 * it also clears the last error while it's at it.
 *
 * @returns whether it worked, plus the message to show the user
 */
export async function syncTest(): Promise<{ ok: boolean; message: Msg }> {
  try {
    const settings = await readSyncSettings();
    const { config, provider } = requireReady(settings);
    await provider!.test(config);
    // Clear the last error on a successful test too, otherwise the red dot just stays there
    const prev = await readSyncStatus();
    await writeSyncStatus({ ...prev, lastError: undefined });
    return {
      ok: true,
      message: { key: 'sync.testOk', params: { provider: { key: provider!.displayName } } },
    };
  } catch (e) {
    const message = describeError(e);
    await recordError(e);
    return { ok: false, message };
  }
}

/**
 * Push, and record the result in the sync status.
 *
 * @param opts.force when there's already a conflict, true means the user confirmed overwriting the remote
 * @returns the result of this sync
 * @throws the error from the failed sync, rethrown to the caller (a copy is already recorded in the status)
 */
export async function syncPush(opts: { force?: boolean } = {}): Promise<SyncOutcome> {
  try {
    const settings = await readSyncSettings();
    const outcome = await runPush(makeDeps(settings), opts);
    await record(outcome);
    return outcome;
  } catch (e) {
    await recordError(e);
    throw e;
  }
}

/**
 * Pull, and record the result in the sync status.
 *
 * @param opts.force when there's already a conflict, true means the user confirmed overwriting the local copy
 * @param opts.remoteJsonOverride use this remote raw text directly instead of reading the remote again
 * @returns the result of this sync
 * @throws the error from the failed sync, rethrown to the caller (a copy is already recorded in the status)
 */
export async function syncPull(
  opts: { force?: boolean; remoteJsonOverride?: string } = {},
): Promise<SyncOutcome> {
  try {
    const settings = await readSyncSettings();
    const outcome = await runPull(makeDeps(settings), opts);
    await record(outcome);
    return outcome;
  } catch (e) {
    await recordError(e);
    throw e;
  }
}

/** Called when the user closes the conflict panel, so the SW forgets this conflict too. */
export async function clearPendingConflict(): Promise<void> {
  const prev = await readSyncStatus();
  const { pendingConflict: _drop, ...rest } = prev;
  await writeSyncStatus(rest);
}

// ---------------------------------------------------------------- OAuth connect

/**
 * The extension's fixed redirect URL (`https://<extension ID>.chromiumapp.org/`).
 *
 * This is exactly what the user has to register in the Google / Microsoft / Dropbox console, so
 * the settings page must show it explicitly for the user to copy -- expecting people to guess the
 * extension ID isn't realistic.
 *
 * @returns the redirect URL for this extension
 */
export function redirectUri(): string {
  return chrome.identity.getRedirectURL();
}

/**
 * Run the auth flow once and store the token we get. After connecting it also clears the last error.
 *
 * Only callable from the service worker: `launchWebAuthFlow` works in an extension page too, but
 * then the token would land in the page's hands, which conflicts with the "the page never touches
 * credentials" rule (§7.6).
 *
 * @param id which provider to connect
 * @returns whether it worked, plus the message to show the user
 */
export async function syncConnect(id: ProviderId): Promise<{ ok: boolean; message: Msg }> {
  try {
    const spec = findSpec(id);
    if (!spec) throw new SyncError({ key: 'err.bg.notOAuth' });

    const settings = await readSyncSettings();
    const cfg = settings.config[id] as OAuthConfig | undefined;
    if (!cfg?.clientId?.trim()) {
      throw new SyncError({
        key: 'err.bg.noClientId',
        params: { provider: { key: spec.displayName } },
      });
    }

    const token: TokenSet = await runAuthFlow(
      providerDeps,
      providerDeps,
      spec,
      cfg,
      redirectUri(),
    );
    await setToken(id, token);
    // Clear the last error once connected -- otherwise the settings page would show "● Connected"
    // and a red message at the same time.
    const prev = await readSyncStatus();
    await writeSyncStatus({ ...prev, lastError: undefined });
    return {
      ok: true,
      message: { key: 'sync.connected', params: { provider: { key: spec.displayName } } },
    };
  } catch (e) {
    const message = describeError(e);
    await recordError(e);
    return { ok: false, message };
  }
}

/**
 * Disconnect: delete the token. The next sync will show the user "○ Not connected".
 *
 * @param id which provider to disconnect
 * @returns always success, plus the message to show the user
 */
export async function syncDisconnect(id: ProviderId): Promise<{ ok: boolean; message: Msg }> {
  const provider = providerLabelMsg(id);
  await clearToken(id);
  return {
    ok: true,
    message: { key: 'sync.disconnected', params: { provider } },
  };
}

// ---------------------------------------------------------------- Timers

/**
 * The periodic pull is only armed when "auto sync" is on. Not arming it based on "a provider is
 * configured" is deliberate: users who only push manually don't want the background pulling on its
 * own -- that would quietly change their local content while they aren't looking.
 */
export async function armSyncAlarm(): Promise<void> {
  const settings = await readSyncSettings();
  if (settings.autoSync && settings.activeProvider) {
    // periodInMinutes only takes effect on creation; an existing alarm doesn't get its period
    // updated, so clear first and create again, otherwise an old alarm keeps running on the old
    // period after the interval was changed.
    await chrome.alarms.clear(SYNC_ALARM);
    chrome.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MINUTES });
  } else {
    await chrome.alarms.clear(SYNC_ALARM);
    // When auto-push is turned off, cancel the pending debounce too: it would get blocked again
    // in `autoPush` (that also checks autoSync), but leaving an alarm we know won't do anything
    // only makes the next person debugging think auto-push is still on.
    await chrome.alarms.clear(AUTOPUSH_ALARM);
  }
}

/**
 * A pull triggered by a timer / automatically: fails silently, errors only go into the status
 * (nobody is waiting to see a popup).
 *
 * @param reason what triggered it: the alarm, or the SW just starting
 */
export async function autoPull(reason: 'alarm' | 'start'): Promise<void> {
  try {
    const settings = await readSyncSettings();
    if (!settings.autoSync) return;

    if (reason === 'start') {
      if (!settings.pullOnStart) return;
      const status = await readSyncStatus();
      if (status.lastSyncAt && now() - status.lastSyncAt < PULL_ON_START_MIN_GAP_MS) return;
    }
    await syncPull();
  } catch {
    // recordError already happened inside syncPull; throwing again here would become an unhandled rejection
  }
}

/** On SW startup: arm the alarms + pull if it's due. */
export async function initSync(): Promise<void> {
  await armSyncAlarm();
  await autoPull('start');
}

/** Settings changed (the user edited them on the settings page): re-arm the alarms. */
export async function onSyncSettingsChanged(): Promise<void> {
  await armSyncAlarm();
}

// ---------------------------------------------------------------- Auto-push

/**
 * Local data changed -> schedule an auto-push (if it's on).
 *
 * The entry point lives here instead of in the `index.ts` listener so that the "which changes
 * count" decision sits right next to the scheduling -- a pull writing back to local is a change to
 * the same key too, and has to be blocked at `selfWrites`.
 */
export function onLocalDocChanged(): void {
  if (selfWrites > 0) {
    selfWrites -= 1;
    return;
  }
  void scheduleAutoPush();
}

/**
 * Schedule an auto-push (debounced, it only actually pushes when the time is up).
 *
 * An alarm instead of `setTimeout`: an idle MV3 SW gets recycled after about 30 seconds, and the
 * `setTimeout` dies with it -- the user ticks a box and navigates away, and that push never happens,
 * leaving no trace. An alarm survives recycling and wakes the SW when it fires. Creating an alarm
 * with the same name replaces rather than stacks, so there's no timer handle to manage.
 */
export async function scheduleAutoPush(): Promise<void> {
  // When auto-push is off, or no sync method is chosen yet, don't even schedule the alarm.
  const settings = await readSyncSettings();
  if (!settings.autoSync || !settings.activeProvider) return;
  chrome.alarms.create(AUTOPUSH_ALARM, { delayInMinutes: AUTOPUSH_DEBOUNCE_MINUTES });
}

/** The debounce fired: actually push once. Fails silently, errors only go into the status (nobody is waiting for the result). */
export async function autoPush(): Promise<void> {
  try {
    const settings = await readSyncSettings();
    if (!settings.autoSync || !settings.activeProvider) return;

    // Don't stack another push on top of a conflict nobody has answered. The condition for the
    // conflict is "The remote copy is newer"; pushing again reaches the same conclusion and
    // just records the same notice over and over -- and what the user sees is a box that
    // appears on its own, disappears, and comes back.
    const status = await readSyncStatus();
    if (status.pendingConflict) return;

    await syncPush();
  } catch {
    // recordError already happened inside syncPush; throwing again here would become an unhandled rejection
  }
}

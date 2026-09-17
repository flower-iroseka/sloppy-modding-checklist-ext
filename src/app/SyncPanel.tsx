import { useEffect, useState } from 'react';
import { Announce } from '../components/Announce';
import { RichText } from '../components/RichText';
import { mergeDocs, parseDocJson } from '../core/exchange';
import { flushPersist } from '../core/persist';
import { checklistStore } from '../core/store';
import { describeError, SyncError } from '../core/sync/errors';
import {
  clearFolderHandle,
  folderPermission,
  loadFolderHandle,
  requestFolderPermission,
  saveFolderHandle,
  type FolderPermission,
} from '../core/sync/folderHandle';
import { PROVIDER_CATALOG, catalogEntry, providerLabelMsg } from '../core/sync/registry';
import {
  STRATEGY_LABEL_KEY,
  normalizeSyncSettings,
  onSyncSettingsChanged,
  onSyncStatusChanged,
  readSyncSettings,
  readSyncStatus,
  writeSyncSettings,
} from '../core/sync/settings';
import { hasToken, onTokensChanged } from '../core/sync/tokens';
import type {
  LocalFolderConfig,
  OAuthConfig,
  PendingConflict,
  ProviderId,
  SyncSettings,
  SyncStatus,
  SyncStrategy,
  WebDavConfig,
} from '../core/sync/types';
import { configOriginPattern, validateConfig } from '../core/sync/webdav';
import type { MessageKey, Msg } from '../i18n';
import { useLocale } from '../i18n/react';
import {
  MSG_SYNC_CLEAR_CONFLICT,
  MSG_SYNC_CONNECT,
  MSG_SYNC_DISCONNECT,
  MSG_SYNC_PULL,
  MSG_SYNC_PUSH,
  MSG_SYNC_TEST,
  type SyncResponse,
} from '../shared/messages';
import { LocalFolderCard } from './LocalFolderCard';
import { OAuthCard, type OAuthDraft } from './OAuthCard';

/**
 * Sync settings panel (CODING_PLAN §9).
 *
 * The page only fills in config, requests host permissions (only the page can do that, and
 * only inside a user gesture) and sends messages -- the network requests and tokens all live
 * in the service worker. Our own text goes through `t()`; what the SW hands back stays in
 * `Msg` form and is translated with `tm()` at render time, since the two realms can be on
 * different languages.
 */
export function SyncPanel() {
  const { t, tm, tmMarkup, locale } = useLocale();
  const [settings, setSettings] = useState<SyncSettings | null>(null);
  const [status, setStatus] = useState<SyncStatus>({});
  const [draft, setDraft] = useState<WebDavConfig | null>(null);
  const [oauthDrafts, setOauthDrafts] = useState<Record<string, OAuthDraft>>({});
  const [connected, setConnected] = useState<Partial<Record<ProviderId, boolean>>>({});
  // Folder permission is "state that changes", so it's stored apart from the config: it isn't
  // in storage and has to be asked for fresh every time the page opens.
  const [folderPermissionState, setFolderPermissionState] = useState<FolderPermission | null>(null);
  /**
   * The action currently running, e.g. `'test'` / `'push'` / `'connect:dropbox'`.
   *
   * It's an identifier for the machine, not text -- the "Testing…" on the button comes from
   * `t('sync.testBusy')`, so it doesn't go into the catalog (putting it there would create a
   * mismatch like "a Chinese busy label in an English UI").
   */
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Msg>();
  const [error, setError] = useState<Msg>();
  const [conflict, setConflict] = useState<PendingConflict>();

  // Read the settings from storage first; after that we follow storage events
  // (when the SW writes sync status / tokens, this refreshes automatically, no polling)
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [s, st] = await Promise.all([readSyncSettings(), readSyncStatus()]);
      if (!alive) return;
      setSettings(s);
      setStatus(st);
      setDraft(webdavDraft(s));
      setOauthDrafts(oauthDraftsFrom(s));
      setConflict(st.pendingConflict);
      void refreshConnected(setConnected);
      // Permission is only accurate at "the moment the page opens": the browser may have
      // revoked it after the last close, and that doesn't fire any storage event. So we ask
      // fresh on every mount.
      void refreshFolderPermission(setFolderPermissionState);
    })();
    const stopSettings = onSyncSettingsChanged((s) => {
      if (!alive) return;
      setSettings(s);
    });
    const stopStatus = onSyncStatusChanged((st) => {
      if (!alive) return;
      setStatus(st);
      setConflict(st.pendingConflict);
    });
    // Tokens changed (connected / disconnected / expired after a SW refresh) -> ask again
    // which providers are connected. The event only carries the provider id list, not the
    // tokens -- the page doesn't need them.
    const stopTokens = onTokensChanged(() => {
      if (alive) void refreshConnected(setConnected);
    });
    return () => {
      alive = false;
      stopSettings();
      stopStatus();
      stopTokens();
    };
  }, []);

  if (!settings || !draft) {
    return (
      <section className="panel">
        <h2 className="panel__title">{t('sync.title')}</h2>
        <p className="panel__body muted">{t('sync.loading')}</p>
      </section>
    );
  }

  // When no sync method has been picked yet, show the first entry in the catalog (local sync
  // folder) but without a selected state -- as soon as the user hits "Save and test connection"
  // / "Choose folder" it really becomes the active method. Being first is intentional: it's the
  // only method that needs no app registration and works out of the box (§7.7).
  const active: ProviderId = settings.activeProvider ?? PROVIDER_CATALOG[0].id;
  const desc = catalogEntry(active);
  const isWebDav = active === 'webdav';
  const isFolder = active === 'localFolder';
  const canPickFolder = pickerFn() !== undefined;
  const folderCfg = settings.config.localFolder as LocalFolderConfig | undefined;

  /**
   * "Does this one count as connected". The two OAuth providers are judged by whether a
   * token exists; the local folder by "picked + permission still there". They're combined
   * into one function because the dropdown has to show them as the same sentence, and the
   * user doesn't care about the internal difference.
   *
   * @param id the provider to judge
   * @returns true when it can be treated as connected
   */
  const providerReady = (id: ProviderId): boolean =>
    id === 'localFolder'
      ? Boolean(folderCfg?.folderName) && folderPermissionState === 'granted'
      : connected[id] === true;

  /**
   * Run an action, handling "busy flag / clear old notices / turn an exception into one
   * sentence" in one place.
   *
   * @param busyKey the identifier for the `busy` state (see its comment), not text to display
   * @param fn the thing that actually runs. Everything thrown in the page is a `SyncError`
   *   (carrying a catalog key), so `describeError` can get the template for that sentence
   */
  const run = async (busyKey: string, fn: () => Promise<void>) => {
    setBusy(busyKey);
    setError(undefined);
    setNotice(undefined);
    try {
      await fn();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Write settings only, no permissions involved (toggle-style changes go through here).
   *
   * @param patch the fields to change; merged with the current settings and then normalized
   */
  const applySettings = async (patch: Partial<SyncSettings>) => {
    const next = normalizeSyncSettings({ ...settings, ...patch });
    await writeSyncSettings(next);
    setSettings(next);
  };

  /**
   * Persist the WebDAV config from the form and request the host permission for that server.
   *
   * It has to be called inside a user gesture: `permissions.request` requires being in a user
   * gesture, so it goes first in the click handler with no other await in between -- one more
   * await is one more chance the gesture expires.
   *
   * @throws {SyncError} the user didn't grant the host permission for this server
   */
  const saveWebDav = async () => {
    const pattern = configOriginPattern(draft);
    const granted = pattern ? await chrome.permissions.request({ origins: [pattern] }) : false;
    if (!granted) throw new SyncError({ key: 'sync.err.noHostPermission' });
    const next = normalizeSyncSettings({
      ...settings,
      activeProvider: 'webdav',
      config: { ...settings.config, webdav: { ...draft, enabled: true } },
    });
    await writeSyncSettings(next);
    setSettings(next);
  };

  /**
   * Save config for the two OAuth providers. There's no permission request step -- their
   * domains are fixed and already declared statically in the manifest's `host_permissions`
   * (§7.6), granted at install time. That's the only difference between them and WebDAV.
   */
  const saveOAuth = async () => {
    const id = active;
    const d = oauthDrafts[id] ?? { clientId: '', clientSecret: '' };
    const next = normalizeSyncSettings({
      ...settings,
      activeProvider: id,
      config: {
        ...settings.config,
        [id]: {
          enabled: true,
          clientId: d.clientId.trim(),
          ...(d.clientSecret ? { clientSecret: d.clientSecret } : {}),
        } satisfies OAuthConfig,
      },
    });
    await writeSyncSettings(next);
    setSettings(next);
  };

  /**
   * Persist the current provider's form before sending an action.
   *
   * The local sync folder has no form; its config is written as a side effect of picking the
   * folder, so nothing has to be done here -- just don't touch any other provider's config.
   */
  const saveBeforeNetwork = () => {
    if (isFolder) return Promise.resolve();
    return isWebDav ? saveWebDav() : saveOAuth();
  };

  /**
   * Pick a folder.
   *
   * `showDirectoryPicker` has to be started synchronously on this line: it requires the
   * browser to still be in the "user just clicked something" state (transient activation),
   * and one extra `await` in between can make it throw as a non-user action. That's why it
   * isn't tucked into `run(...)`: we grab the promise first, then hand it to `run` to await.
   */
  const pickFolder = () => {
    const pick = pickerFn();
    if (!pick) {
      setError({ key: 'sync.err.pickerUnsupported' });
      return;
    }
    const picked = pick({ id: FOLDER_PICKER_ID, mode: 'readwrite' });
    void run('folder', async () => {
      let handle: FileSystemDirectoryHandle;
      try {
        handle = await picked;
      } catch (e) {
        // The user hit cancel in the system dialog -- that's not a failure.
        if ((e as { name?: string }).name === 'AbortError') {
          throw new SyncError({ key: 'sync.err.pickCancelled' });
        }
        throw e;
      }
      await saveFolderHandle(handle);
      const next = normalizeSyncSettings({
        ...settings,
        activeProvider: 'localFolder',
        config: {
          ...settings.config,
          localFolder: { enabled: true, folderName: handle.name } satisfies LocalFolderConfig,
        },
      });
      await writeSyncSettings(next);
      setSettings(next);
      setFolderPermissionState(await folderPermission(handle));
      setNotice({ key: 'sync.folderPicked', params: { name: handle.name } });
    });
  };

  /**
   * Re-authorize.
   *
   * Same "has to be inside a user gesture" category: `requestPermission` shows a system
   * dialog and the browser only allows it to start from a real click, so there can't be a
   * single await here either.
   */
  const reauthorizeFolder = () => {
    const asking = (async () => {
      const handle = await loadFolderHandle();
      if (!handle) throw new SyncError({ key: 'sync.err.handleLost' });
      return { handle, state: await requestFolderPermission(handle) };
    })();
    void run('folder', async () => {
      const { state } = await asking;
      setFolderPermissionState(state);
      if (state === 'granted') setNotice({ key: 'sync.folderRestored' });
      else setError({ key: 'sync.err.folderDenied' });
    });
  };

  /**
   * Disconnect: clear the extension's records (the handle + the name in the config).
   *
   * Doesn't delete that JSON file -- the copy in the user's cloud drive is theirs and the
   * extension has no business deleting it for them. Pick the same folder again next time and
   * the content is still there, and one comparison reconnects the two sides.
   */
  const forgetFolder = () =>
    run('folder', async () => {
      await clearFolderHandle();
      const next = normalizeSyncSettings({
        ...settings,
        config: { ...settings.config, localFolder: { enabled: false } satisfies LocalFolderConfig },
      });
      await writeSyncSettings(next);
      setSettings(next);
      setFolderPermissionState(null);
      setNotice({ key: 'sync.folderForgotten' });
    });

  /**
   * Put the background's response onto the panel: open the conflict panel when there's a
   * conflict, otherwise land it in the notice or error slot by success/failure.
   *
   * @param res the response the background sent back
   */
  const applyResponse = (res: SyncResponse) => {
    if (res.conflict) {
      setConflict(res.conflict);
      setNotice(res.message);
      return;
    }
    setConflict(undefined);
    if (res.ok) setNotice(res.message);
    else setError(res.message);
  };

  /** Close the conflict panel and make the SW forget this conflict too. */
  const clearConflict = async () => {
    await sendSync(MSG_SYNC_CLEAR_CONFLICT);
    setConflict(undefined);
  };

  /** Test connection: persist the form first, then have the background try once. */
  const testConnection = () =>
    run('test', async () => {
      await saveBeforeNetwork();
      applyResponse(await sendSync(MSG_SYNC_TEST));
    });

  /**
   * Push: push the local copy to the remote.
   *
   * @param force when a conflict already exists, true means the user confirmed overwriting the remote
   */
  const push = (force = false) =>
    run('push', async () => {
      await saveBeforeNetwork();
      // What gets uploaded is the copy in storage; the page may still have unsaved changes, so flush first
      await flushPersist();
      applyResponse(await sendSync(MSG_SYNC_PUSH, { force }));
    });

  /**
   * Pull: fetch the remote copy and overwrite the local one.
   *
   * @param opts.force when a conflict already exists, true means the user confirmed overwriting the local copy
   * @param opts.remoteJsonOverride use this remote text directly instead of reading the remote again
   */
  const pull = (opts: { force?: boolean; remoteJsonOverride?: string } = {}) =>
    run('pull', async () => {
      await saveBeforeNetwork();
      await flushPersist();
      applyResponse(await sendSync(MSG_SYNC_PULL, opts));
    });

  /**
   * Connect to an OAuth provider (opens an authorization window).
   *
   * @param id the one to connect
   * @throws {SyncError} not connected, and no existing token could be found either
   */
  const connect = (id: ProviderId) =>
    run(`connect:${id}`, async () => {
      await saveOAuth();
      // This one isn't auto-retried: `launchWebAuthFlow` opens a real authorization window,
      // so a retry opens another one. When the SW gets killed mid-flight the response is lost
      // on the way, but the authorization itself may have completed -- so ask "is the token
      // there" first; if it is, treat it as success, and only if it isn't let the user retry.
      const res = await sendSync(MSG_SYNC_CONNECT, { provider: id }, { retry: false });
      if (res.ok) {
        await refreshConnected(setConnected);
        setNotice(res.message);
        return;
      }
      if (res.unreachable && (await hasToken(id))) {
        await refreshConnected(setConnected);
        setNotice({ key: 'sync.connected', params: { provider: providerLabelMsg(id) } });
        return;
      }
      throw new SyncError(res.message);
    });

  /**
   * Disconnect an OAuth provider and clear its token.
   *
   * @param id the one to disconnect
   */
  const disconnect = (id: ProviderId) =>
    run(`disconnect:${id}`, async () => {
      const res = await sendSync(MSG_SYNC_DISCONNECT, { provider: id });
      await refreshConnected(setConnected);
      if (res.ok) setNotice(res.message);
      else setError(res.message);
    });

  /** Choose "merge both" in a conflict: compute it in the page, write it locally, and leave it to the user whether to upload. */
  const mergeInstead = () =>
    run('merge', async () => {
      if (!conflict) return;
      const { doc: incoming } = parseDocJson(conflict.remoteJson);
      const merged = mergeDocs(checklistStore.getState().doc, incoming);
      checklistStore.getState().replaceDoc(merged.doc);
      await flushPersist();
      await clearConflict();
      setNotice({
        key: 'sync.merged',
        params: { added: merged.added, skipped: merged.skipped },
      });
    });

  /** Choose "keep local" in a conflict: write nothing, just close the conflict panel. */
  const keepLocal = () =>
    run('keep', async () => {
      await clearConflict();
      setNotice({ key: 'sync.keptLocal' });
    });

  /** A field in the WebDAV form changed. */
  const patchDraft = (patch: Partial<WebDavConfig>) => setDraft({ ...draft, ...patch });
  /** A field in one OAuth form changed. */
  const patchOAuth = (id: ProviderId, patch: Partial<OAuthDraft>) =>
    setOauthDrafts((prev) => {
      const cur = prev[id] ?? { clientId: '', clientSecret: '' };
      return { ...prev, [id]: { ...cur, ...patch } };
    });

  const configError: Msg | null = isFolder
    ? folderCfg?.folderName
      ? folderPermissionState === 'granted'
        ? null
        : { key: 'sync.err.folderNeedsReauth' }
      : { key: 'sync.err.noFolderChosen' }
    : isWebDav
      ? validateConfig(draft)
      : oauthConfigError(oauthDrafts[active]);
  const disabled = busy !== null || configError !== null;

  // The three conflict sentences are used in three places (announcement, headline, body), so compute once.
  const conflictHeadline = conflict ? t(CONFLICT_HEADLINE_KEY[conflict.kind]) : '';
  const conflictReason = conflict ? t(CONFLICT_REASON_KEY[conflict.kind]) : '';

  return (
    <section className="panel">
      <h2 className="panel__title">{t('sync.title')}</h2>
      <p className="panel__body">{t('sync.intro')}</p>

      {/* Two persistent announce regions (for screen readers; `position: absolute` so they
          take no layout). Kept here rather than next to the visible line: `<SyncResult>` is
          rendered once in each provider branch, and hanging them there would unmount and
          rebuild the live region every time the provider switches -- but it has to stay in
          the DOM the whole time (region first, text later, otherwise screen readers miss the
          whole thing, see §12.1). The visible line is rendered by `<SyncResult>`, right below
          the three action buttons. */}
      <Announce kind="polite" text={notice ? tm(notice) : ''} />
      <Announce kind="assertive" text={error ? tm(error) : ''} />

      <div className="row sync__block">
        <label className="mc-field__label" htmlFor="provider">
          {t('sync.providerLabel')}
        </label>
        <select
          id="provider"
          className="mc-input sync__select"
          value={active}
          disabled={busy !== null}
          onChange={(e) => void run('save', () => applySettings({ activeProvider: e.target.value as ProviderId }))}
        >
          {PROVIDER_CATALOG.map((p) => (
            <option key={p.id} value={p.id}>
              {t(p.labelKey)}
              {providerReady(p.id) ? t('sync.providerConnected') : ''}
            </option>
          ))}
        </select>
      </div>

      {isFolder ? (
        <LocalFolderCard
          folderName={folderCfg?.folderName}
          permission={folderPermissionState}
          supported={canPickFolder}
          busy={busy === 'folder'}
          disabled={disabled}
          onPick={pickFolder}
          onReauthorize={reauthorizeFolder}
          onForget={() => void forgetFolder()}
        />
      ) : isWebDav ? (
        <WebDavForm
          draft={draft}
          busy={busy}
          disabled={disabled}
          configError={configError}
          error={error}
          notice={notice}
          onChange={patchDraft}
          onTest={() => void testConnection()}
          onPush={() => void push(false)}
          onPull={() => void pull()}
        />
      ) : desc?.oauth ? (
        <OAuthCard
          spec={desc.oauth}
          origins={desc.origins ?? []}
          redirectUri={redirectUri()}
          draft={oauthDrafts[active] ?? { clientId: '', clientSecret: '' }}
          connected={connected[active] === true}
          busy={busy}
          disabled={disabled}
          onChange={(patch) => patchOAuth(active, patch)}
          onConnect={() => void connect(active)}
          onDisconnect={() => void disconnect(active)}
        />
      ) : null}

      {!isWebDav && (
        // `data-action` / `data-role` are the anchors the smoke test recognizes (same as OAuthCard), don't change them casually.
        <div className="row sync__block" data-role="sync-actions">
          <button
            type="button"
            className="btn btn--accent"
            data-action="sync-test"
            disabled={disabled}
            onClick={() => void testConnection()}
          >
            {busy === 'test' ? t('sync.testBusy') : t('sync.test')}
          </button>
          <button
            type="button"
            className="btn"
            data-action="sync-push"
            disabled={disabled}
            onClick={() => void push(false)}
          >
            {busy === 'push' ? t('sync.pushBusy') : t('sync.push')}
          </button>
          <button
            type="button"
            className="btn"
            data-action="sync-pull"
            disabled={disabled}
            onClick={() => void pull()}
          >
            {busy === 'pull' ? t('sync.pullBusy') : t('sync.pull')}
          </button>
          {configError && (
            <span className="muted">
              <RichText text={tmMarkup(configError)} />
            </span>
          )}
        </div>
      )}
      {/* The result sits right below the buttons (see the notes on SyncResult); this button
          row only shows for non-WebDAV, while the WebDAV one is rendered under its own
          buttons inside `WebDavForm`. */}
      {!isWebDav && <SyncResult error={error} notice={notice} />}

      <div className="row sync__row">
        <label className="sync__check">
          <input
            type="checkbox"
            checked={settings.autoSync}
            disabled={busy !== null}
            onChange={() => void run('save', () => applySettings({ autoSync: !settings.autoSync }))}
          />
          {t('sync.autoSync')}
        </label>
        <label className="sync__check">
          <input
            type="checkbox"
            checked={settings.pullOnStart}
            disabled={busy !== null}
            onChange={() =>
              void run('save', () => applySettings({ pullOnStart: !settings.pullOnStart }))
            }
          />
          {t('sync.pullOnStart')}
        </label>
      </div>

      <div className="row sync__row">
        <label className="mc-field__label" htmlFor="strategy">
          {t('sync.strategyLabel')}
        </label>
        <select
          id="strategy"
          className="mc-input sync__select"
          value={settings.strategy}
          disabled={busy !== null}
          onChange={(e) =>
            void run('save', () => applySettings({ strategy: e.target.value as SyncStrategy }))
          }
        >
          {(Object.keys(STRATEGY_LABEL_KEY) as SyncStrategy[]).map((s) => (
            <option key={s} value={s}>
              {t(STRATEGY_LABEL_KEY[s])}
            </option>
          ))}
        </select>
      </div>

      {/* The conflict panel uses assertive: it isn't a casual mention but a question that
          blocks the flow and waits for an answer -- no answer means no push and no pull. The
          user may well have switched to another window while the sync was running and come
          back to find nothing changed, so this one has to be able to interrupt the screen
          reader. */}
      <Announce
        kind="assertive"
        text={
          conflict ? t('sync.conflict.announce', { headline: conflictHeadline, reason: conflictReason }) : ''
        }
      />

      {conflict && (
        <div className="mc-alert sync__conflict">
          <strong>{conflictHeadline}</strong>
          <p>{conflictReason}</p>
          <div className="row">
            {conflict.kind === 'push' ? (
              <>
                <button type="button" className="btn btn--danger" onClick={() => void push(true)}>
                  {t('sync.conflict.overwrite')}
                </button>
                <button type="button" className="btn" onClick={() => void keepLocal()}>
                  {t('sync.conflict.cancel')}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn" onClick={() => void keepLocal()}>
                  {t('sync.conflict.keepLocal')}
                </button>
                <button
                  type="button"
                  className="btn btn--accent"
                  onClick={() => void pull({ force: true })}
                >
                  {t('sync.conflict.takeRemote')}
                </button>
                <button type="button" className="btn" onClick={() => void mergeInstead()}>
                  {t('sync.conflict.merge')}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <dl className="stats">
        <div className="stats__item">
          <dt>{t('sync.stats.lastSync')}</dt>
          {/* The time is formatted in the current UI language too: only after switching to
              English does "09/11/2026, 3:04 PM" match the English around it (`locale` is just
              `'zh'` / `'en'`, used directly as BCP-47). */}
          <dd>{status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString(locale) : '—'}</dd>
        </div>
        <div className="stats__item">
          <dt>{t('sync.stats.lastAction')}</dt>
          <dd>
            {status.lastAction === 'push'
              ? t('sync.stats.actionPush')
              : status.lastAction === 'pull'
                ? t('sync.stats.actionPull')
                : '—'}
          </dd>
        </div>
        <div className="stats__item">
          <dt>{t('sync.stats.status')}</dt>
          <dd>
            {status.lastError ? (
              <span className="error-text">{t('sync.stats.failed')}</span>
            ) : settings.activeProvider ? (
              <span className="ok-text">{t('sync.stats.ok')}</span>
            ) : (
              t('sync.stats.disabled')
            )}
          </dd>
        </div>
      </dl>

      {/* Deliberately not a live region: this is almost always the same sentence as the
          `error` above (the SW records `status.lastError` at the same time the page gets the
          message from the response), and announcing both reads the same sentence twice. It
          stays here so "status: failed" has a readable reason -- visible is enough. */}
      {status.lastError && (
        <p className="error-text">{t('sync.stats.lastError', { detail: status.lastError })}</p>
      )}
    </section>
  );
}

/** The conflict panel's headline, kept apart from the body: the announcement reads the two together. */
const CONFLICT_HEADLINE_KEY: Record<PendingConflict['kind'], MessageKey> = {
  push: 'sync.conflict.pushHeadline',
  pull: 'sync.conflict.pullHeadline',
};

/** Conflict body. The two kinds of conflict ask differently (see the comment on `PendingConflict.kind`). */
const CONFLICT_REASON_KEY: Record<PendingConflict['kind'], MessageKey> = {
  push: 'sync.conflict.pushReason',
  pull: 'sync.conflict.pullReason',
};

// ---------------------------------------------------------------- WebDAV form

interface WebDavFormProps {
  /** The config being edited in the form (the value of the controlled inputs). */
  draft: WebDavConfig;
  /** The identifier of the action currently running; buttons show a busy state when not null. */
  busy: string | null;
  /** Whether the three action buttons are disabled (busy, or the config has an error). */
  disabled: boolean;
  /** The config error blocking the actions; buttons are disabled when not null. */
  configError: Msg | null;
  /** Failure from the last action; goes to the `<SyncResult>` below the buttons (see the notes there). */
  error?: Msg;
  /** Success notice from the last action; same slot as `error`. */
  notice?: Msg;
  /** A field in the form changed. */
  onChange(patch: Partial<WebDavConfig>): void;
  /** Save and test the connection. */
  onTest(): void;
  /** Push right away. */
  onPush(): void;
  /** Pull from the remote. */
  onPull(): void;
}

/**
 * The WebDAV form. It takes up half the panel, so it's a separate component -- left inside
 * `SyncPanel`, that function would have to juggle four things at once: "which provider",
 * "the form", "messages" and "conflicts".
 *
 * The `#dav-*` ids are anchors recognized by the outside (the smoke test, user scripts),
 * don't change them casually.
 */
function WebDavForm({
  draft,
  busy,
  disabled,
  configError,
  error,
  notice,
  onChange,
  onTest,
  onPush,
  onPull,
}: WebDavFormProps) {
  const { t, tmMarkup } = useLocale();
  return (
    <>
      <div className="mc-field sync__block">
        <label className="mc-field__label" htmlFor="dav-base">
          {t('sync.dav.baseUrl')}
        </label>
        <input
          id="dav-base"
          className="mc-input"
          type="url"
          placeholder="https://dav.jianguoyun.com/dav/"
          value={draft.baseUrl}
          onChange={(e) => onChange({ baseUrl: e.target.value })}
        />
        {/* This sentence has a `<strong>` in the middle, so it's split into three keys built around the tag (see the notes in zh.ts). */}
        <span className="mc-field__hint">
          {t('sync.dav.baseUrlHint1')}
          <strong>{t('sync.dav.baseUrlHintStrong')}</strong>
          {t('sync.dav.baseUrlHint2')}
        </span>
      </div>

      <div className="sync__grid">
        <div className="mc-field">
          <label className="mc-field__label" htmlFor="dav-user">
            {t('sync.dav.username')}
          </label>
          <input
            id="dav-user"
            className="mc-input"
            autoComplete="username"
            value={draft.username}
            onChange={(e) => onChange({ username: e.target.value })}
          />
        </div>
        <div className="mc-field">
          <label className="mc-field__label" htmlFor="dav-pass">
            {t('sync.dav.password')}
          </label>
          <input
            id="dav-pass"
            className="mc-input"
            type="password"
            autoComplete="current-password"
            value={draft.password}
            onChange={(e) => onChange({ password: e.target.value })}
          />
        </div>
      </div>

      <div className="mc-field sync__block">
        <label className="mc-field__label" htmlFor="dav-path">
          {t('sync.dav.path')}
        </label>
        <input
          id="dav-path"
          className="mc-input"
          placeholder={t('sync.dav.pathPlaceholder')}
          value={draft.path ?? ''}
          onChange={(e) => onChange({ path: e.target.value })}
        />
      </div>

      <p className="panel__body muted sync__warn">{t('sync.dav.plaintextWarning')}</p>

      <div className="row">
        <button type="button" className="btn btn--accent" disabled={disabled} onClick={onTest}>
          {busy === 'test' ? t('sync.testBusy') : t('sync.testAndSave')}
        </button>
        <button type="button" className="btn" disabled={disabled} onClick={onPush}>
          {busy === 'push' ? t('sync.pushBusy') : t('sync.push')}
        </button>
        <button type="button" className="btn" disabled={disabled} onClick={onPull}>
          {busy === 'pull' ? t('sync.pullBusy') : t('sync.pull')}
        </button>
        {configError && (
          <span className="muted">
            <RichText text={tmMarkup(configError)} />
          </span>
        )}
      </div>

      {/* The three buttons in this form are those three actions (the button text is
          "Save and test connection"), so the result grows here too (see the notes on SyncResult). */}
      <SyncResult error={error} notice={notice} />
    </>
  );
}

// ---------------------------------------------------------------- Helpers

/**
 * The results of the three action buttons (test connection / push now / pull from remote),
 * right below them.
 *
 * Empty by default but taking up one line's height (`.sync__result`'s `min-height`): when a
 * result appears it shouldn't push the toggles and conflict strategy below it down as a
 * block -- click a button and the page jumps, which looks like a misclick.
 *
 * There's only one slot here and `error` wins over `notice`: when both sentences are present
 * (the last success notice hasn't cleared yet and this one failed), the error is the one the
 * user needs to see.
 *
 * The body goes through `tmMarkup` + `<RichText>` because errors can carry bold markers (the
 * only marker allowed in the catalog, see `i18n/richText.ts`); the two announcements for
 * screen readers go through `tm`, where an asterisk would just be read out loud. Each
 * provider branch renders one copy, but only one is in the DOM at any moment.
 */
function SyncResult({ error, notice }: { error?: Msg; notice?: Msg }) {
  const { tmMarkup } = useLocale();
  return (
    <div className="sync__result" data-role="sync-result">
      {error ? (
        <p className="error-text">
          <RichText text={tmMarkup(error)} />
        </p>
      ) : notice ? (
        <p className="ok-text">
          <RichText text={tmMarkup(notice)} />
        </p>
      ) : null}
    </div>
  );
}

/**
 * Form draft: flatten the saved WebDAV config into a shape that always has values (the form
 * can't have undefined).
 *
 * @param settings the current settings
 * @returns a config that can be fed straight to the controlled inputs
 */
function webdavDraft(settings: SyncSettings): WebDavConfig {
  const saved = settings.config.webdav as WebDavConfig | undefined;
  return {
    enabled: true,
    baseUrl: saved?.baseUrl ?? '',
    username: saved?.username ?? '',
    password: saved?.password ?? '',
    path: saved?.path ?? '',
  };
}

/**
 * Form drafts for the two providers. Ones that were never saved get empty strings --
 * controlled inputs can't be undefined.
 *
 * @param settings the current settings
 * @returns a map from provider id to draft, covering only the OAuth-capable providers
 */
function oauthDraftsFrom(settings: SyncSettings): Record<string, OAuthDraft> {
  const out: Record<string, OAuthDraft> = {};
  for (const p of PROVIDER_CATALOG) {
    if (!p.oauth) continue;
    const saved = settings.config[p.id] as OAuthConfig | undefined;
    out[p.id] = { clientId: saved?.clientId ?? '', clientSecret: saved?.clientSecret ?? '' };
  }
  return out;
}

/**
 * Give a notice when client_id is missing.
 *
 * @param draft this provider's form draft; undefined if no draft has been built yet
 * @returns the notice when there's something to say, null when it's fine
 */
function oauthConfigError(draft: OAuthDraft | undefined): Msg | null {
  if (!draft || draft.clientId.trim() === '') return { key: 'sync.err.noClientId' };
  return null;
}

/**
 * `chrome.identity` is always there in an automated extension page; fall back to an empty
 * string when it isn't, rather than letting the whole panel blow up.
 *
 * @returns the extension's OAuth redirect URI; an empty string when it can't be read
 */
function redirectUri(): string {
  try {
    return chrome.identity.getRedirectURL();
  } catch {
    return '';
  }
}

/**
 * Getting hold of `showDirectoryPicker`.
 *
 * Fetched dynamically rather than `window.showDirectoryPicker` directly: that function isn't
 * declared in `lib.dom`'s types (it's part of the File System Access supplemental spec), and
 * it doesn't exist at all on Firefox / Safari -- writing it directly would both fail tsc and
 * crash on other browsers.
 *
 * @returns the function when the browser supports it, undefined when it doesn't
 */
function pickerFn():
  | ((options?: { id?: string; mode?: 'read' | 'write' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>)
  | undefined {
  if (typeof window === 'undefined') return undefined;
  const fn = (window as unknown as Record<string, unknown>).showDirectoryPicker;
  return typeof fn === 'function'
    ? (fn as (o?: { id?: string; mode?: 'read' | 'write' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>)
    : undefined;
}

/** The id passed to `showDirectoryPicker`: Chrome uses it to remember "which directory was
 *  picked last time" and stops there when the picker opens next. Changing it means making
 *  every user find their folder again. */
const FOLDER_PICKER_ID = 'mc-sync-folder';

/**
 * Ask for the folder permission once, read-only. Ask but don't request --
 * `requestPermission` needs a user gesture and can only be triggered by a button; here we
 * just want to know whether to show "Re-authorize".
 *
 * @param set callback with the state; null when the handle can't be read (that counts as a state too)
 */
async function refreshFolderPermission(
  set: (v: FolderPermission | null) => void,
): Promise<void> {
  try {
    const handle = await loadFolderHandle();
    set(handle ? await folderPermission(handle) : null);
  } catch {
    // Not being able to read the handle (the database was cleared) counts as a state too:
    // show it as "needs picking again".
    set(null);
  }
}

/**
 * "Which providers are connected". Only booleans are asked for; the page doesn't read the
 * tokens themselves (§7.6).
 *
 * @param set callback with the result
 */
async function refreshConnected(
  set: (v: Partial<Record<ProviderId, boolean>>) => void,
): Promise<void> {
  const entries = await Promise.all(
    PROVIDER_CATALOG.filter((p) => p.oauth).map(
      async (p) => [p.id, await hasToken(p.id)] as const,
    ),
  );
  set(Object.fromEntries(entries));
}

/** Result of sending a sync message. `unreachable` means it never got an answer, not that the background said "failed". */
interface SendResult extends SyncResponse {
  unreachable?: boolean;
}

/**
 * Send a sync message, turning "the SW didn't answer" into a human sentence too.
 *
 * MV3 service workers get killed at any moment (idle, or dragged down by a long authorization
 * window), and then `sendMessage` gets `undefined` back -- the message wasn't handled, so
 * resending once is right. The smoke test always had this retry layer, and the product code
 * was the one missing it.
 *
 * Only if the retry doesn't get through either do we report an error; and we report "no
 * answer" rather than "failed", because what the user can do about those two differs (retry
 * vs change the config).
 *
 * @param type the message type, see `shared/messages.ts`
 * @param body the parameters attached to the message
 * @param opts.retry false means don't resend (e.g. the one that opens an authorization window)
 * @returns the background's response; `unreachable` being true means it didn't get through this time
 */
async function sendSync(
  type: string,
  body: Record<string, unknown> = {},
  opts: { retry?: boolean } = {},
): Promise<SendResult> {
  const { retry = true } = opts;
  for (let attempt = 0; ; attempt++) {
    let res: SyncResponse | undefined;
    try {
      res = (await chrome.runtime.sendMessage({ type, ...body })) as SyncResponse | undefined;
    } catch (e) {
      // The port died outright (the SW isn't up / is terminating) -- same category as "no
      // answer", so the same retry.
      if (attempt === 0 && retry) {
        await delay(300);
        continue;
      }
      return {
        ok: false,
        unreachable: true,
        message: {
          key: 'err.bg.commFailed',
          params: { detail: e instanceof Error ? e.message : String(e) },
        },
      };
    }
    if (res) return res;
    if (attempt === 0 && retry) {
      await delay(300);
      continue;
    }
    return { ok: false, unreachable: true, message: { key: 'sync.err.bgNoResponse' } };
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

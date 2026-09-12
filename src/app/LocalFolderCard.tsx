import { REMOTE_FILE } from '../core/sync/webdav';
import type { FolderPermission } from '../core/sync/folderHandle';
import { useLocale } from '../i18n/react';

/**
 * Settings card for the "local sync folder" (CODING_PLAN §7.7).
 *
 * Separate from the other providers because the interaction differs: those are "fill in some
 * fields -> save", while this one is "click -> directory picker -> pick", plus one extra state
 * -- permission revoked. The picker and permission calls need a user gesture and live in
 * `SyncPanel`, so this component only renders and fires callbacks, never awaits.
 */
export interface LocalFolderCardProps {
  /** The folder name remembered in settings; undefined if never picked. */
  folderName?: string;
  /** The handle's current permission state; null if not checked yet. */
  permission: FolderPermission | null;
  /** Whether this browser has File System Access (Chrome / Edge 86+ only). */
  supported: boolean;
  /** The directory picker is open, so the main button shows "选择中…". */
  busy: boolean;
  /** An operation is running or the current config has an error, so all buttons are dead. */
  disabled: boolean;
  /** Click the main button: pick a directory, or switch to a different one. */
  onPick(): void;
  /** Click "重新授权": ask the browser once more after the permission was revoked. */
  onReauthorize(): void;
  /** Click "忘记": clear the remembered folder. */
  onForget(): void;
}

/** Render the local folder picker and its permission state. */
export function LocalFolderCard({
  folderName,
  permission,
  supported,
  busy,
  disabled,
  onPick,
  onReauthorize,
  onForget,
}: LocalFolderCardProps) {
  const { t } = useLocale();

  if (!supported) {
    return <p className="panel__body">{t('folder.unsupported')}</p>;
  }

  const needsPermission = Boolean(folderName) && permission !== 'granted';

  return (
    <>
      <div className="mc-field sync__block">
        <label className="mc-field__label">{t('folder.label')}</label>
        {/* This paragraph has two `<strong>`s in it, so it's split into five segments built around the tags (see the notes in zh.ts). */}
        <p className="mc-field__hint">
          {t('folder.intro1')}
          <strong>{t('folder.introStrong1')}</strong>
          {t('folder.intro2', { file: REMOTE_FILE })}
          <strong>{t('folder.introStrong2')}</strong>
          {t('folder.intro3')}
        </p>
      </div>

      <p className="panel__body sync__folder-state">
        {folderName ? (
          <>
            {t('folder.current')}
            <strong>{folderName}</strong>
            {permission === 'granted' && <span className="ok-text">{t('folder.statusGranted')}</span>}
            {permission === 'prompt' && <span className="muted">{t('folder.statusPrompt')}</span>}
            {permission === 'denied' && (
              <span className="error-text">{t('folder.statusDenied')}</span>
            )}
          </>
        ) : (
          <span className="muted">{t('folder.none')}</span>
        )}
      </p>

      {needsPermission && (
        <p className="panel__body muted sync__warn">{t('folder.permissionNotice')}</p>
      )}

      {/* `data-action` is the anchor the smoke test recognizes, don't change it casually. */}
      <div className="row">
        <button
          type="button"
          className="btn btn--accent"
          data-action="pick-folder"
          disabled={disabled}
          onClick={onPick}
        >
          {busy ? t('folder.picking') : folderName ? t('folder.change') : t('folder.pick')}
        </button>
        {needsPermission && (
          <button
            type="button"
            className="btn"
            data-action="reauth-folder"
            disabled={disabled}
            onClick={onReauthorize}
          >
            {t('folder.reauthorize')}
          </button>
        )}
        {folderName && (
          <button
            type="button"
            className="btn"
            data-action="forget-folder"
            disabled={disabled}
            onClick={onForget}
          >
            {t('folder.forget')}
          </button>
        )}
      </div>

      <p className="panel__body muted sync__warn">
        {t('folder.tip1')}
        <strong>{t('folder.tipStrong')}</strong>
        {t('folder.tip2')}
      </p>
    </>
  );
}

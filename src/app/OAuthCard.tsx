import { RichText } from '../components/RichText';
import { showToast } from '../components/toast';
import type { OAuthSpec } from '../core/sync/oauth';
import { t } from '../i18n';
import { useLocale } from '../i18n/react';

/**
 * The credentials the user fills in on the UI.
 */
export interface OAuthDraft {
  /** The id you get when registering the app in the provider's console. */
  clientId: string;
  /** App secret; not needed for public clients, leave it empty. */
  clientSecret: string;
}

/**
 * Settings card for one OAuth provider (CODING_PLAN §9).
 *
 * Every provider's card looks the same because the steps are the same: register an app in the
 * console, paste the redirect URI in, fill the client_id back in, click connect. The endpoints,
 * scopes and guide text all live in `OAuthSpec`, so nothing here branches per provider.
 */
interface Props {
  /** This provider's endpoints, scopes and guide text. */
  spec: OAuthSpec;
  /** The host permissions this provider needs (already declared statically in the manifest; listed here for reference). */
  origins: string[];
  /** The redirect URI to paste into the provider's console. */
  redirectUri: string;
  /** The client_id / client_secret the user is editing. */
  draft: OAuthDraft;
  /** Whether this provider is already authorized. */
  connected: boolean;
  /** The busy action currently running (see `busy` in SyncPanel); inputs stay frozen even if it isn't this provider. */
  busy: string | null;
  /** An operation is running or the current config has an error, so the buttons are dead. */
  disabled: boolean;
  /** An input changed, merge the change into draft. */
  onChange(patch: Partial<OAuthDraft>): void;
  /** Click "连接": start the OAuth authorization. */
  onConnect(): void;
  /** Click "断开": clear this provider's credentials. */
  onDisconnect(): void;
}

/** Render one provider's connection settings. */
export function OAuthCard({
  spec,
  origins,
  redirectUri,
  draft,
  connected,
  busy,
  disabled,
  onChange,
  onConnect,
  onDisconnect,
}: Props) {
  const { t, tmMarkup } = useLocale();
  const id = spec.id;
  const missing = draft.clientId.trim() === '' || (spec.requiresSecret && !draft.clientSecret);

  return (
    <section className="panel sync__provider" data-provider={id}>
      <h3 className="panel__subtitle">
        {t(spec.displayName)}
        <span className={connected ? 'ok-text sync__badge' : 'muted sync__badge'}>
          {connected ? t('oauth.status.connected') : t('oauth.status.disconnected')}
        </span>
      </h3>

      <ol className="sync__steps">
        {spec.help.steps.map((step) => {
          // The key is the rendered sentence itself: the steps are a fixed few and don't repeat
          // within one provider, and when the language changes the key changes with it, which
          // makes React remount the whole list (cheap here anyway).
          const text = tmMarkup(step);
          // Go through RichText instead of putting text straight into the <li>: these guide
          // steps contain things like `**必须点 Submit**` that have to be bold, so the markers
          // need to become real <strong> here (see RichText.tsx).
          return (
            <li key={text}>
              <RichText text={text} />
            </li>
          );
        })}
      </ol>
      <p className="panel__body muted">
        {t('oauth.registerUrl')}
        {/* There has to be a space between the label and the link: the Chinese sentence ends
            with a full-width colon ("注册地址："), which gives visual separation on its own,
            while the English `Register at:` puts the link right up against it
            ("Register at:Dropbox App Console"). The space lives here rather than in the
            catalog, because trailing whitespace in a value is too easily stripped by an
            editor or some translation pass. */}
        {' '}
        <a href={spec.help.consoleUrl} target="_blank" rel="noreferrer">
          {spec.help.consoleLabel}
        </a>
      </p>

      <div className="mc-field">
        <label className="mc-field__label" htmlFor={`oauth-${id}-redirect`}>
          {t('oauth.redirectUri')}
        </label>
        <div className="row">
          <input
            id={`oauth-${id}-redirect`}
            className="mc-input sync__readonly"
            readOnly
            value={redirectUri}
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            className="btn"
            data-action="copy-redirect"
            onClick={() => void copyRedirect(redirectUri)}
            title={t('oauth.copy')}
          >
            {t('oauth.copy')}
          </button>
        </div>
      </div>

      <div className="sync__grid">
        <div className="mc-field">
          <label className="mc-field__label" htmlFor={`oauth-${id}-client`}>
            client_id
          </label>
          <input
            id={`oauth-${id}-client`}
            className="mc-input"
            value={draft.clientId}
            onChange={(e) => onChange({ clientId: e.target.value })}
          />
        </div>
        <div className="mc-field">
          <label className="mc-field__label" htmlFor={`oauth-${id}-secret`}>
            client_secret{spec.requiresSecret ? '' : t('oauth.secretOptional')}
          </label>
          <input
            id={`oauth-${id}-secret`}
            className="mc-input"
            type="password"
            value={draft.clientSecret}
            onChange={(e) => onChange({ clientSecret: e.target.value })}
          />
        </div>
      </div>

      <p className="panel__body muted">
        {t('oauth.scopes', {
          scopes: spec.scopes
            .map((s) => s.split('/').pop())
            .join(t('common.listSeparator')),
        })}
      </p>
      {spec.help.caution && (
        <p className="panel__body muted sync__warn">
          <RichText text={tmMarkup(spec.help.caution)} />
        </p>
      )}
      <p className="panel__body muted sync__warn">
        {t('oauth.credentialsNote')}
        {origins.length > 0 && (
          <>
            {' '}
            {t('oauth.originsNote', {
              origins: origins.map(hostOfPattern).join(t('common.listSeparator')),
            })}
          </>
        )}
      </p>

      <div className="row" data-role="oauth-actions">
        {connected ? (
          <>
            <button
              type="button"
              className="btn"
              data-action="disconnect"
              disabled={busy !== null}
              onClick={onDisconnect}
            >
              {t('oauth.disconnect')}
            </button>
            <span className="muted">{t('oauth.authorized')}</span>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--accent"
              data-action="connect"
              disabled={disabled || missing}
              onClick={onConnect}
            >
              {busy === `connect:${id}` ? t('oauth.connecting') : t('oauth.connect')}
            </button>
            {missing && <span className="muted">{t('oauth.needClientId')}</span>}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * `https://api.dropboxapi.com/*` -> `api.dropboxapi.com` (no need for the wildcard in the
 * explanation text).
 *
 * @param pattern the host permission pattern from the manifest
 * @returns just the host name
 */
function hostOfPattern(pattern: string): string {
  return pattern.replace(/^https?:\/\//, '').replace(/\/\*$/, '');
}

/**
 * Copy to the clipboard and report success or failure honestly.
 *
 * This address has to be pasted into another provider's console, and typing an extension ID
 * by hand isn't realistic, so "it didn't copy" is something the user has to know right away --
 * a silent failure makes them paste stale content and think it's our fault. (`clipboard`
 * rejects when the tab isn't visible, the page isn't https, or the user denied clipboard
 * permission; the fallback is that selecting all in the input and copying works, but a toast
 * has to say so.)
 *
 * @param text the text to copy
 * @returns whether the copy succeeded
 */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * What the copy button does: say something on both success and failure, and on failure spell
 * out the fallback (select it by hand).
 *
 * This uses the module-level `t` rather than `useLocale()`: a toast is a "click and it shows
 * for 3 seconds" thing, unrelated to component re-renders, and `t` reads the same live
 * language state. Inside components you have to use `useLocale()`, because there a language
 * change has to make React redraw.
 *
 * @param redirectUri the redirect URI to copy
 */
async function copyRedirect(redirectUri: string): Promise<void> {
  const ok = await copy(redirectUri);
  showToast(ok ? t('toast.copied') : t('toast.copyFailed'), ok ? 'info' : 'error');
}

import { useLocale } from '../i18n/react';

/** Author handle, as it appears on GitHub. */
const AUTHOR = 'flower-iroseka';

/** The project's own repo. Private for now; the link starts working once it goes public. */
const REPO_URL = 'https://github.com/flower-iroseka/sloppy-modding-checklist-ext';

/**
 * Electoz's osu! user page. The numeric id is the canonical URL; `/users/Electoz` redirects
 * to the same page.
 */
const ELECTOZ_USER_URL = 'https://osu.ppy.sh/users/6485263';

/** Where the guide itself downloads from (the banner at the top of that user page). */
const ELECTOZ_GUIDE_URL = 'https://electoz.s-ul.eu/N7Y53Jaj';

/**
 * Attribution and license, the last block on the settings page.
 *
 * Kept out of the panels above because none of it is a setting: the user never comes here to
 * change something, only to find out where the thing came from.
 */
export function AboutPanel() {
  const { t } = useLocale();

  return (
    <section className="panel panel--muted" data-panel="about">
      <h2 className="panel__title">{t('about.title')}</h2>

      <p className="panel__body">
        {t('about.author', { author: AUTHOR })}
        {' · '}
        {t('about.license')}
      </p>
      <p className="panel__body">{t('about.aiNote')}</p>

      <div className="row sync__row">
        <a className="btn" href={REPO_URL} target="_blank" rel="noreferrer">
          {t('about.repo')}
        </a>
      </div>

      <p className="panel__note">
        {t('about.electoz')}{' '}
        <a href={ELECTOZ_USER_URL} target="_blank" rel="noreferrer">
          {t('about.electozUser')}
        </a>
        {' · '}
        <a href={ELECTOZ_GUIDE_URL} target="_blank" rel="noreferrer">
          {t('about.electozGuide')}
        </a>
      </p>
    </section>
  );
}

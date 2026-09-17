import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STRATEGY_LABEL_KEY } from '../src/core/sync/settings';
import { OAUTH_SPECS, PROVIDER_CATALOG, allOrigins } from '../src/core/sync/registry';
import { renderKeyMarkup, renderMsgMarkup, type Locale } from '../src/i18n';

/**
 * README against the code (CODING_PLAN §11 M8).
 *
 * Two things in the README are copied out of the code: the OAuth registration guide and
 * the permission list. Users follow both and drift gives no signal -- one extra domain
 * promises a domain that is never accessed, a missing one sends requests out behind their
 * back. Add a provider and forget the README, this file goes red.
 *
 * There are two READMEs: `README.md` in English (the default, the one GitHub shows) and
 * `README.zh.md` in Chinese. Both carry the same copied-out text in their own language, so
 * both get checked -- against `en` and `zh` respectively. Every assertion below runs twice.
 */
const READMES: ReadonlyArray<{ name: string; locale: Locale; text: string }> = [
  { name: 'README.md', locale: 'en', text: read('README.md') },
  { name: 'README.zh.md', locale: 'zh', text: read('README.zh.md') },
];

/**
 * @param file README file name, relative to the repository root
 * @returns its text
 */
function read(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
}

const manifest = JSON.parse(
  readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'),
) as { host_permissions: string[] };

for (const readme of READMES) {
  describe(readme.name, () => {
    /** Assert this exact text appears in this README. */
    function contains(needle: string): void {
      expect(readme.text.includes(needle), `${readme.name} 里找不到这段原文：\n${needle}`).toBe(true);
    }

    /**
     * Render a catalog key in this README's language, which is the phrase it should contain.
     *
     * Uses the markup variant: the default rendering strips `**bold**`, which then can't match
     * the bold in the README. Everything compared here goes through this or `renderMsgMarkup`
     * for the same reason.
     *
     * @param key the copy key
     * @returns that key's text, keeping the `**` markers
     */
    function t(key: Parameters<typeof renderKeyMarkup>[0]): string {
      return renderKeyMarkup(key, undefined, readme.locale);
    }

    function tm(msg: Parameters<typeof renderMsgMarkup>[0]): string {
      return renderMsgMarkup(msg, readme.locale);
    }

    it('the other language README is linked from here', () => {
      // The switcher line at the top. Without it the Chinese one is unreachable from GitHub.
      const other = readme.locale === 'en' ? 'README.zh.md' : 'README.md';
      contains(other);
    });

    describe('OAuth registration walkthrough', () => {
      // Loop over the providers instead of hardcoding Dropbox: add another OAuth provider
      // later and forget the README, and this goes red.
      for (const spec of OAUTH_SPECS) {
        describe(t(spec.displayName), () => {
          it('both the registration URL and the link text are there', () => {
            contains(spec.help.consoleUrl);
            contains(spec.help.consoleLabel);
          });

          it('every walkthrough step appears word for word', () => {
            for (const step of spec.help.steps) contains(tm(step));
          });

          it('the caution appears word for word', () => {
            // Only check when present: this step shouldn't fail just because a provider has no caution.
            if (spec.help.caution) contains(tm(spec.help.caution));
          });

          // This group matters most: they're the only thing users can check against when the
          // authorization page errors out. Miss one, and the user is stuck staring at an error
          // window with no way back.
          it('every classic misconfig appears word for word', () => {
            for (const hint of spec.help.misconfig ?? []) contains(tm(hint));
          });
        });
      }
    });

    describe('provider catalog', () => {
      it('every provider name from the catalog appears in the README', () => {
        for (const desc of PROVIDER_CATALOG) contains(t(desc.labelKey));
      });

      it('the wording for all four conflict strategies is there (the README table)', () => {
        for (const key of Object.values(STRATEGY_LABEL_KEY)) contains(t(key));
      });
    });

    describe('manifest permissions', () => {
      // Compare against the manifest's exact text one by one, rather than assembling our own
      // -- if we assembled our own, both being wrong would still pass.
      it('every host_permissions entry is listed in the README', () => {
        for (const pattern of manifest.host_permissions) contains(pattern);
      });

      it('the README has no domain that is outside the manifest and owned by no provider', () => {
        // The other half. An extra domain doesn't break anything, so this kind of leftover
        // gives no signal -- only a test can catch it (same as the one in tests/manifest.test.ts).
        const foreign = allOrigins().filter((o) => !manifest.host_permissions.includes(o));
        expect(foreign).toEqual([]);
      });
    });

    describe('does not mention removed sync methods', () => {
      /**
       * Sync methods that have been removed. After deleting a provider, this is the thing
       * most likely to stay behind in the README -- the user reads a detailed registration
       * guide, follows it, then can't find that option in the settings page.
       *
       * The list is hardcoded rather than derived from the code: you can't derive something
       * that isn't in the code, and it only ever grows when something is deleted.
       */
      const REMOVED = [
        'Google Drive',
        'GoogleDrive',
        'drive.google.com',
        'googleapis.com',
        'OneDrive',
        'onedrive',
        'sharepoint',
        'Azure',
      ];

      it.each(REMOVED)('the README does not contain "%s"', (word) => {
        expect(readme.text.includes(word), `README 里提到了已经删掉的同步方式：${word}`).toBe(false);
      });
    });
  });
}

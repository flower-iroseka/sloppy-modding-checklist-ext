import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { STRATEGY_LABEL_KEY } from '../src/core/sync/settings';
import { OAUTH_SPECS, PROVIDER_CATALOG, allOrigins } from '../src/core/sync/registry';
import { renderKeyMarkup, renderMsgMarkup } from '../src/i18n';

/**
 * README against the code (CODING_PLAN §11 M8).
 *
 * Two things in the README are copied out of the code: the OAuth registration guide and
 * the permission list. Users follow both and drift gives no signal -- one extra domain
 * promises a domain that is never accessed, a missing one sends requests out behind their
 * back. Add a provider and forget the README, this file goes red.
 */
const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

const manifest = JSON.parse(
  readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'),
) as { host_permissions: string[] };

/**
 * Assert this exact text appears in the README.
 *
 * @param needle the string to find verbatim in the README; it's included in the assertion message on failure
 */
function contains(needle: string): void {
  expect(readme.includes(needle), `README 里找不到这段原文：\n${needle}`).toBe(true);
}

/**
 * Render a catalog key to Chinese, which is the phrase the README should contain.
 *
 * Uses the markup variant: the README is Chinese, and the default rendering strips
 * `**bold**`, which then can't match the bold in the README. Everything compared here
 * goes through this or `renderMsgMarkup` for the same reason.
 *
 * @param key the copy key
 * @returns the Chinese version, keeping the `**` markers
 */
function zh(key: Parameters<typeof renderKeyMarkup>[0]): string {
  return renderKeyMarkup(key, undefined, 'zh');
}

describe('README 与 OAuth 注册向导', () => {
  // Loop over the providers instead of hardcoding Dropbox: add another OAuth provider
  // later and forget the README, and this goes red.
  for (const spec of OAUTH_SPECS) {
    describe(zh(spec.displayName), () => {
      it('注册地址与链接文字都在', () => {
        contains(spec.help.consoleUrl);
        contains(spec.help.consoleLabel);
      });

      it('每一步向导文案都逐字出现', () => {
        for (const step of spec.help.steps) contains(renderMsgMarkup(step, 'zh'));
      });

      it('提醒（caution）逐字出现', () => {
        // Only check when present: this step shouldn't fail just because a provider has no caution.
        if (spec.help.caution) contains(renderMsgMarkup(spec.help.caution, 'zh'));
      });

      // This group matters most: they're the only thing users can check against when the
      // authorization page errors out. Miss one, and the user is stuck staring at an error
      // window with no way back.
      it('每条经典配置坑（misconfig）都逐字出现', () => {
        for (const hint of spec.help.misconfig ?? []) contains(renderMsgMarkup(hint, 'zh'));
      });
    });
  }
});

describe('README 与 provider 目录', () => {
  it('目录里每一家的名字都在 README 里出现过', () => {
    for (const desc of PROVIDER_CATALOG) contains(zh(desc.labelKey));
  });

  it('四种冲突策略的文案都在（README 那张表）', () => {
    for (const key of Object.values(STRATEGY_LABEL_KEY)) contains(zh(key));
  });
});

describe('README 与 manifest 权限', () => {
  // Compare against the manifest's exact text one by one, rather than assembling our own
  // -- if we assembled our own, both being wrong would still pass.
  it('host_permissions 里每一项都在 README 里列了出来', () => {
    for (const pattern of manifest.host_permissions) contains(pattern);
  });

  it('README 里没有 manifest 之外、也不属于任何 provider 的域', () => {
    // The other half. An extra domain doesn't break anything, so this kind of leftover
    // gives no signal -- only a test can catch it (same as the one in tests/manifest.test.ts).
    const foreign = allOrigins().filter((o) => !manifest.host_permissions.includes(o));
    expect(foreign).toEqual([]);
  });
});

describe('README 不提已经删掉的同步方式', () => {
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

  it.each(REMOVED)('README 里没有「%s」', (word) => {
    expect(readme.includes(word), `README 里提到了已经删掉的同步方式：${word}`).toBe(false);
  });
});

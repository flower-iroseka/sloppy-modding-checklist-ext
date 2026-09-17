// M9 smoke: UI language (i18n).
//
// M9 only moves the strings out, so the only question is "after the move, is anything still
// showing its face that shouldn't be". Three kinds of assertion: the switch really takes
// effect, it really lands in storage (still that language after a reload), and the whole
// page's text has no escaped `{placeholders}` / keys / `undefined` / `[object Object]` (nor
// Han characters in the English UI). All three fail silently, looking like a normal render.
// We judge by the UI text, not the `zh`/`en` catalogs -- catalog consistency is the unit
// tests' job (tests/i18n.test.ts, exhaustive types + per-key comparison); the wiring is what
// is checked here.
//
// Usage: node scripts/smoke-m9.mjs <debugPort> <extensionId> [discussionUrl]
import { clickSelector } from './cdp.mjs';

const [port, extId, discussionUrl] = process.argv.slice(2);
if (!port || !extId) {
  console.error('usage: node scripts/smoke-m9.mjs <debugPort> <extensionId> [discussionUrl]');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
/**
 * Assert one thing: print PASS/FAIL, and remember the failures for the final exit code.
 *
 * @param label the assertion name, also used in the summary at the end
 * @param ok whether it passed
 * @param detail extra text printed after the arrow; optional
 */
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : '  →  ' + detail}`);
  if (!ok) failures.push(label);
}

// ---------------------------------------------------------------- CDP

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const target = list.find((t) => t.type === 'page');
if (!target) {
  console.error('no usable tab');
  process.exit(2);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let idc = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};
function send(method, params = {}) {
  const id = ++idc;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result.value;
}

await send('Page.enable');
await send('Runtime.enable');
// The real site page is long; give it a normal viewport so noise like "element is outside the viewport" stays out of the way (same as smoke-m3).
await send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

const APP = `chrome-extension://${extId}/app.html`;
const POPUP = `chrome-extension://${extId}/popup.html`;

async function goto(url, readySel) {
  await send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    const ready = await evaluate(
      `document.readyState === 'complete' && !!document.querySelector(${JSON.stringify(readySel)})`,
    ).catch(() => false);
    if (ready) break;
  }
  await sleep(350);
}

// ---------------------------------------------------------------- Reading values

const text = (sel) =>
  evaluate(`(document.querySelector(${JSON.stringify(sel)})?.textContent ?? '').trim()`);
const exists = (sel) => evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
const click = (sel) =>
  clickSelector(send, evaluate, `document.querySelector(${JSON.stringify(sel)})`, { sleep });

/**
 * The whole page's visible text (no blind spots from reading element by element).
 *
 * `textContent` rather than `innerText`: the latter needs layout, and when the tab is
 * occluded the layout is broken, so `innerText` returns an empty string and the assertions go
 * falsely green "because nothing was read".
 *
 * Drop the `select` completely: the language selector's options are supposed to be written in
 * each language's own spelling (the English UI has a "中文" one too), and leaving it in would
 * make the "no Han characters in the English UI" check red forever.
 *
 * @returns the page text, with whitespace collapsed
 */
async function pageText() {
  return evaluate(`(() => {
    const clone = document.body.cloneNode(true);
    for (const n of clone.querySelectorAll('select, script, style')) n.remove();
    return clone.textContent.replace(/\\s+/g, ' ').trim();
  })()`);
}

/** Switch to the settings page and wait for the data panel (the tab text changes, so find it by data-tab). */
async function openSettings() {
  await evaluate(`document.querySelector('.app__tab[data-tab="settings"]')?.click()`);
  for (let i = 0; i < 40; i++) {
    await sleep(120);
    if (await exists('[data-panel="data"]')) break;
  }
}

/**
 * Set a <select>'s value and dispatch change (native setter, so React notices).
 *
 * @param sel CSS selector
 * @param value the option value to select
 * @returns the value from before the change; 'missing' if the element isn't there
 */
async function setSelect(sel, value) {
  return evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'missing';
    const before = el.value;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
      .set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return before;
  })()`);
}

/** The "which language is it now" check: just the current value of the settings page's language dropdown. */
const currentSetting = () => evaluate(`document.querySelector('[data-role="locale-select"]')?.value ?? null`);

/**
 * Assert that the whole page has no leftover i18n junk.
 *
 * @param label scenario description in front of the assertion name
 * @param allowCjk true only for the Chinese UI; the English UI also gets checked for Han characters
 */
async function checkNoLeaks(label, allowCjk) {
  const body = await pageText();
  // Only check the prefixes that look like keys. Two narrowings, both forced by real false
  // positives:
  //   * not preceded by a letter or hyphen -- otherwise the file `modding-checklist.json`
  //     gets caught as the "key" `checklist.json` (hit on the very first run);
  //   * the same guard also blocks URLs (`dav` in `dav.jianguoyun.com` isn't in the prefix
  //     list, but a domain that was would no longer be a false positive either).
  const KEYISH =
    /(?<![-\w])(?:err|sync|checklist|card|entry|data|popup|content|folder|oauth|settings|nav|common|scope|source|difficulty|provider|strategy|plan|help|toast|action)\.[a-zA-Z][\w.-]*/;
  check(`${label}: no unreplaced placeholders`, !/\{[a-zA-Z_]+\}/.test(body), body.match(/\{[a-zA-Z_]+\}/)?.[0]);
  check(`${label}: no keys printed verbatim`, !KEYISH.test(body), body.match(KEYISH)?.[0]);
  // The `**bold**` markup in the catalog only gets rendered by `<RichText>`. Miss that step
  // and a pair of asterisks shows up on the page -- like the three checks above, a failure that
  // looks like a normal render (`**Submit**` just reads as a few extra symbols), so it gets
  // swept in with the rest.
  check(`${label}: no leaked ** markup`, !/\*\*/.test(body), body.match(/\S*\*\*\S*/)?.[0]);
  check(
    `${label}: no undefined / [object Object]`,
    !/undefined|\[object Object\]/.test(body),
    body.match(/undefined|\[object Object\]/)?.[0],
  );
  if (!allowCjk) {
    check(`${label}: no leftover Han characters`, !/[一-鿿]/.test(body), body.match(/[一-鿿][^ ]*/)?.[0]);
  }
}

/**
 * Seed a pure-ASCII checklist.
 *
 * It has to be seeded: the list page's UI text (counts, drag hints, the buttons on the cards)
 * only renders when there really are cards, so under an empty list that whole block of
 * assertions checks nothing.
 *
 * The content has to be ASCII: the "English UI has no Han characters" scan below walks the
 * whole page, and the content the user wrote is in there too. Hit on the first run -- the same
 * debug profile had just finished m5/m6 and still held a Chinese entry of mine ("the remote
 * copy F"), and the assertion took user data for untranslated UI text. With ASCII seeded, any
 * Han character on the page can only be untranslated UI, which is what makes the check mean
 * anything.
 *
 * @returns the total number of entries seeded
 */
const seedAsciiData = () =>
  evaluate(`(async () => {
    const now = Date.now();
    // All four fields are required: if \`normalizeEntry\` can't tell scope/source apart it
    // **drops** the whole entry (keeping only a dropped count), and afterwards the UI looks
    // completely normal -- just "共 0 条". The first version forgot scope/source here, so the
    // assertion quietly tested an empty list.
    const mk = (id, summary, scope, source) => ({
      id, scope, source, summary, links: [], createdAt: now, updatedAt: now,
    });
    const cells = {
      'general-internal': [mk('m9-1', 'Tidy the hitbox on Extra', 'general', 'internal')],
      'general-external': [mk('m9-2', 'Suggest a slider velocity change', 'general', 'external')],
      'individual-internal': [],
      'individual-external': [],
    };
    await chrome.storage.local.set({ checklist: {
      schemaVersion: 1, updatedAt: now, deviceId: 'smoke-m9', cells,
    }});
    // Read the count back, so "the seed didn't go in" shows up at the call site instead of
    // turning into a downstream "共 0 条" that tells you nothing (the lesson about the missed
    // parameter above).
    const back = (await chrome.storage.local.get('checklist')).checklist;
    return Object.values(back.cells).flat().length;
  })()`);

// ================================================================ 1. The switch itself

// Leave the app page before writing storage: on `pagehide` the app page flushes its in-memory
// doc back to storage (core/persist.ts), so "write the seed with the app page open, then
// reload" gets clobbered by the old data coming back -- the first time it was written this
// way, not one seeded ASCII entry survived.
// The popup is a separate realm, read-only with no persistence loop, so it's the safest host.
await goto(POPUP, '.pu');
check('the seeded ASCII entries really landed in storage', (await seedAsciiData()) === 2);
await goto(APP, '.app');
await openSettings();

check('settings page has a language dropdown', await exists('[data-role="locale-select"]'));
check(
  'the three options are ordered auto / zh / en',
  JSON.stringify(
    await evaluate(
      `[...document.querySelectorAll('[data-role="locale-select"] option')].map((o) => o.value)`,
    ),
  ) === JSON.stringify(['auto', 'zh', 'en']),
);
check(
  'language names use **their own spelling** (Chinese is not translated to "Chinese")',
  JSON.stringify(
    await evaluate(
      `[...document.querySelectorAll('[data-role="locale-select"] option')].map((o) => o.textContent.trim()).slice(1)`,
    ),
  ) === JSON.stringify(['中文', 'English']),
);

check('the language panel is on the settings page', await exists('.panel__title'));

// ================================================================ 2. Switch to English

const beforeEn = await setSelect('[data-role="locale-select"]', 'en');
check('not English before the switch', beforeEn === 'auto' || beforeEn === 'zh', String(beforeEn));
await sleep(400);

check(
  'the dropdown stays on en after switching to English',
  (await currentSetting()) === 'en',
  String(await currentSetting()),
);
check(
  'the tabs switch to English',
  (await text('.app__tab[data-tab="checklist"]')) === 'Checklist' &&
    (await text('.app__tab[data-tab="settings"]')) === 'Settings',
  `${await text('.app__tab[data-tab="checklist"]')} / ${await text('.app__tab[data-tab="settings"]')}`,
);
check('settings page title becomes Settings', (await text('.view__title')) === 'Settings');
check('data panel title becomes Data', (await text('[data-panel="data"] .panel__title')) === 'Data');
check('the data panel stat label is English too', (await text('[data-panel="data"] .stats__item dt')) === 'Entries');
check(
  'sync panel title is English too',
  (await evaluate(`[...document.querySelectorAll('.panel__title')].map((e) => e.textContent.trim()).join('|')`))
    .includes('Sync'),
);
await checkNoLeaks('English settings page', false);

// Back to the Checklist page for the list caption -- that sentence is split into three pieces
// around <strong>, the easiest place to get the wiring wrong
await evaluate(`document.querySelector('.app__tab[data-tab="checklist"]')?.click()`);
await sleep(300);
const meta = await text('.view__meta');
check('the list caption becomes English', /Total/.test(meta) && /in total/.test(meta), meta);
// Match on the count rather than "is there a number": the latter is also green when the list
// is empty (`共 0 条`), which is exactly when the "no Han characters on the page" round below
// scans nothing.
check('the number is still in the list caption (splitting it up did not drop the <strong>)', /Total 2 in total/.test(meta), meta);
check(
  'cards really rendered on the page (otherwise the leftover scan below checks nothing)',
  (await evaluate(`document.querySelectorAll('.card').length`)) === 2,
  String(await evaluate(`document.querySelectorAll('.card').length`)),
);
await checkNoLeaks('English Checklist page', false);
check(
  'zone names are still General / Individual (terms do not change with the language)',
  (await evaluate(
    `[...document.querySelectorAll('.col__heading')].map((e) => e.textContent.trim()).join(',')`,
  )) === 'General,Individual',
);

// ================================================================ 3. Still there after a reload

await goto(APP, '.app');
await openSettings();
check('still en after reload (the setting really persisted)', (await currentSetting()) === 'en', String(await currentSetting()));
check('the UI is still English after reload', (await text('.view__title')) === 'Settings');

// The popup is a separate realm, so it reads storage itself -- a handy extra check while we're here
await goto(POPUP, '.pu');
check(
  'the popup picks up the English setting too',
  (await evaluate(`document.querySelector('.pu__open')?.textContent.trim() ?? null`)) ===
    'Open the Checklist page',
  await text('.pu__open'),
);

// ================================================================ 4. Switch back to Chinese

await goto(APP, '.app');
await openSettings();
await setSelect('[data-role="locale-select"]', 'zh');
await sleep(400);
check('the title is Chinese after switching back', (await text('.view__title')) === '设置', await text('.view__title'));
check('the data panel is Chinese after switching back', (await text('[data-panel="data"] .panel__title')) === '数据');
await checkNoLeaks('Chinese settings page', true);

// ================================================================ 5. auto follows the browser

await setSelect('[data-role="locale-select"]', 'auto');
await sleep(400);
const autoExpected = await evaluate(`(() => {
  const tag = (chrome.i18n?.getUILanguage?.() || navigator.language || '').toLowerCase();
  const base = tag.split('-')[0];
  return base === 'zh' ? 'zh' : 'en';
})()`);
const autoTitle = await text('.view__title');
check(
  'auto follows the browser language (an unrecognized one falls back to English)',
  autoTitle === (autoExpected === 'zh' ? '设置' : 'Settings'),
  `browser=${autoExpected} panel title=${autoTitle}`,
);

// Wrap up: restore the setting to auto so we don't leave a pinned language for later scripts
await sleep(100);

// ================================================================ 6. Text injected by the content script (optional)

/**
 * Find any beatmap that has a discussion page. Same approach as smoke-m3 (which also looks
 * site-wide for a `beatmapsets/<id>` link); here it's only so we can land on a real page and
 * check the injected text.
 *
 * @returns the discussion URL; null when the network is down / osu is broken, in which case
 *   that whole block is skipped rather than going red over an environment problem
 */
async function findDiscussionUrl() {
  if (discussionUrl) return discussionUrl;
  await send('Page.navigate', { url: 'https://osu.ppy.sh/beatmapsets?m=3' });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const href = await evaluate(`(() => {
      for (const a of document.querySelectorAll('a[href]')) {
        const h = a.getAttribute('href') || '';
        if (/\\/beatmapsets\\/\\d+$/.test(h)) return h;
      }
      return null;
    })()`).catch(() => null);
    if (href) return href.startsWith('http') ? `${href}/discussion` : `https://osu.ppy.sh${href}/discussion`;
  }
  return null;
}

const targetUrl = await findDiscussionUrl();

if (targetUrl) {
  /**
   * Pin the language to `en` and then reload the real site page.
   *
   * This step is the point of this block: the injected text was written by `ensureFab` /
   * `injectPostButtons` using whatever language was current at the time, while `initLocale()`
   * reading storage is still in flight (it's async). If the read only comes back as `en` and
   * nobody re-renders the injected text, what the user sees is "the settings page is in
   * English, the buttons on the page are still in Chinese". So it has to load from scratch,
   * not change the setting on an already-open Chinese page.
   */
  await goto(APP, '.app');
  await openSettings();
  await setSelect('[data-role="locale-select"]', 'en');
  await sleep(400);

  await send('Page.navigate', { url: targetUrl });
  for (let i = 0; i < 80; i++) {
    await sleep(200);
    if (await evaluate(`!!document.getElementById('mc-fab')`).catch(() => false)) break;
  }
  // The content script is injected at document_idle, so that storage read may not have landed
  // yet when the FAB shows up -- `relabelInjected` is subscription-driven; give it a moment to
  // catch up.
  await sleep(600);

  check('FAB injected on the real site', await exists('#mc-fab'));
  check(
    "the FAB's title / aria-label are the same string and not empty",
    await evaluate(`(() => {
      const fab = document.getElementById('mc-fab');
      if (!fab) return false;
      const label = fab.getAttribute('aria-label');
      return !!label && fab.title === label;
    })()`),
  );

  const fabTitle = await evaluate(`document.getElementById('mc-fab')?.title ?? null`);
  check(
    "the FAB's title follows the language in the settings (pinned to en, so it should be English)",
    typeof fabTitle === 'string' && /^Open /.test(fabTitle),
    String(fabTitle),
  );

  const addBtns = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.mc-add-btn')];
    return { n: btns.length, text: btns[0]?.textContent.trim() ?? null, title: btns[0]?.title ?? null };
  })()`);
  check('the "＋" button was injected', addBtns.n > 0, `n=${addBtns.n}`);
  check(
    'the "＋" button text is English too',
    typeof addBtns.text === 'string' && /^\+ Add to Checklist$/.test(addBtns.text),
    String(addBtns.text),
  );
  check('the "＋" button title follows too', /checklist/i.test(String(addBtns.title)), String(addBtns.title));

  // Wrap up: restore the language to auto so we don't leave a pinned en for later scripts
  await goto(APP, '.app');
  await openSettings();
  await setSelect('[data-role="locale-select"]', 'auto');
  await sleep(300);
} else {
  console.log('SKIP  text injected by the content script (no usable discussion page found)');
}

// ---------------------------------------------------------------- Wrap up

console.log('');
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join(' / ')}`);
  ws.close();
  process.exit(1);
}
console.log('ALL PASSED');
ws.close();

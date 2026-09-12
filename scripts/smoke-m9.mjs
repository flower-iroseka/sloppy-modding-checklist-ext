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
  console.error('没有可用的标签页');
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
    /(?<![-\w])(?:err|sync|checklist|card|entry|data|popup|content|folder|oauth|settings|nav|common|scope|source|provider|strategy|plan|help|toast|action)\.[a-zA-Z][\w.-]*/;
  check(`${label}：没有未替换的占位符`, !/\{[a-zA-Z_]+\}/.test(body), body.match(/\{[a-zA-Z_]+\}/)?.[0]);
  check(`${label}：没有把 key 原样印出来`, !KEYISH.test(body), body.match(KEYISH)?.[0]);
  // The `**bold**` markup in the catalog only gets rendered by `<RichText>`. Miss that step
  // and a pair of asterisks shows up on the page -- like the three checks above, a failure that
  // looks like a normal render (`**Submit**` just reads as a few extra symbols), so it gets
  // swept in with the rest.
  check(`${label}：没有漏出来的 ** 标记`, !/\*\*/.test(body), body.match(/\S*\*\*\S*/)?.[0]);
  check(
    `${label}：没有 undefined / [object Object]`,
    !/undefined|\[object Object\]/.test(body),
    body.match(/undefined|\[object Object\]/)?.[0],
  );
  if (!allowCjk) {
    check(`${label}：没有汉字残留`, !/[一-鿿]/.test(body), body.match(/[一-鿿][^ ]*/)?.[0]);
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
check('灌入的 ASCII 条目真的进了 storage', (await seedAsciiData()) === 2);
await goto(APP, '.app');
await openSettings();

check('设置页有语言下拉框', await exists('[data-role="locale-select"]'));
check(
  '三个选项按 auto / zh / en 排列',
  JSON.stringify(
    await evaluate(
      `[...document.querySelectorAll('[data-role="locale-select"] option')].map((o) => o.value)`,
    ),
  ) === JSON.stringify(['auto', 'zh', 'en']),
);
check(
  '语言名用**它自己的写法**（中文不译成 Chinese）',
  JSON.stringify(
    await evaluate(
      `[...document.querySelectorAll('[data-role="locale-select"] option')].map((o) => o.textContent.trim()).slice(1)`,
    ),
  ) === JSON.stringify(['中文', 'English']),
);

check('语言面板在设置页里', await exists('.panel__title'));

// ================================================================ 2. Switch to English

const beforeEn = await setSelect('[data-role="locale-select"]', 'en');
check('切换前不是英文', beforeEn === 'auto' || beforeEn === 'zh', String(beforeEn));
await sleep(400);

check(
  '切英文后下拉框停在 en',
  (await currentSetting()) === 'en',
  String(await currentSetting()),
);
check(
  '标签页变成英文',
  (await text('.app__tab[data-tab="checklist"]')) === 'Checklist' &&
    (await text('.app__tab[data-tab="settings"]')) === 'Settings',
  `${await text('.app__tab[data-tab="checklist"]')} / ${await text('.app__tab[data-tab="settings"]')}`,
);
check('设置页标题变成 Settings', (await text('.view__title')) === 'Settings');
check('数据面板标题变成 Data', (await text('[data-panel="data"] .panel__title')) === 'Data');
check('数据面板的统计项也是英文', (await text('[data-panel="data"] .stats__item dt')) === 'Entries');
check(
  '同步面板标题也是英文',
  (await evaluate(`[...document.querySelectorAll('.panel__title')].map((e) => e.textContent.trim()).join('|')`))
    .includes('Sync'),
);
await checkNoLeaks('英文设置页', false);

// Back to the Checklist page for the list caption -- that sentence is split into three pieces
// around <strong>, the easiest place to get the wiring wrong
await evaluate(`document.querySelector('.app__tab[data-tab="checklist"]')?.click()`);
await sleep(300);
const meta = await text('.view__meta');
check('列表说明变成英文', /Total/.test(meta) && /in total/.test(meta), meta);
// Match on the count rather than "is there a number": the latter is also green when the list
// is empty (`共 0 条`), which is exactly when the "no Han characters on the page" round below
// scans nothing.
check('列表说明里的数字还在（切段没把 <strong> 挤掉）', /Total 2 in total/.test(meta), meta);
check(
  '页面上真的渲染出了卡片（否则下面的残渣扫描等于没扫）',
  (await evaluate(`document.querySelectorAll('.card').length`)) === 2,
  String(await evaluate(`document.querySelectorAll('.card').length`)),
);
await checkNoLeaks('英文 Checklist 页', false);
check(
  '格名仍是 General / Individual（术语不随语言变）',
  (await evaluate(
    `[...document.querySelectorAll('.col__heading')].map((e) => e.textContent.trim()).join(',')`,
  )) === 'General,Individual',
);

// ================================================================ 3. Still there after a reload

await goto(APP, '.app');
await openSettings();
check('刷新后仍是 en（设置真的落盘了）', (await currentSetting()) === 'en', String(await currentSetting()));
check('刷新后界面仍是英文', (await text('.view__title')) === 'Settings');

// The popup is a separate realm, so it reads storage itself -- a handy extra check while we're here
await goto(POPUP, '.pu');
check(
  'popup 也读到了英文设置',
  (await evaluate(`document.querySelector('.pu__open')?.textContent.trim() ?? null`)) ===
    'Open the Checklist page',
  await text('.pu__open'),
);

// ================================================================ 4. Switch back to Chinese

await goto(APP, '.app');
await openSettings();
await setSelect('[data-role="locale-select"]', 'zh');
await sleep(400);
check('切回中文后标题是中文', (await text('.view__title')) === '设置', await text('.view__title'));
check('切回中文后数据面板是中文', (await text('[data-panel="data"] .panel__title')) === '数据');
await checkNoLeaks('中文设置页', true);

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
  'auto 跟随浏览器语言（认不出的落到英文）',
  autoTitle === (autoExpected === 'zh' ? '设置' : 'Settings'),
  `浏览器=${autoExpected} 面板标题=${autoTitle}`,
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

  check('真站上注入了 FAB', await exists('#mc-fab'));
  check(
    'FAB 的 title / aria-label 是同一句、且非空',
    await evaluate(`(() => {
      const fab = document.getElementById('mc-fab');
      if (!fab) return false;
      const label = fab.getAttribute('aria-label');
      return !!label && fab.title === label;
    })()`),
  );

  const fabTitle = await evaluate(`document.getElementById('mc-fab')?.title ?? null`);
  check(
    'FAB 的 title 跟设置里的语言走（钉的是 en，所以该是英文）',
    typeof fabTitle === 'string' && /^Open /.test(fabTitle),
    String(fabTitle),
  );

  const addBtns = await evaluate(`(() => {
    const btns = [...document.querySelectorAll('.mc-add-btn')];
    return { n: btns.length, text: btns[0]?.textContent.trim() ?? null, title: btns[0]?.title ?? null };
  })()`);
  check('注入了「＋」按钮', addBtns.n > 0, `n=${addBtns.n}`);
  check(
    '「＋」按钮的文字也是英文',
    typeof addBtns.text === 'string' && /^\+ Add to Checklist$/.test(addBtns.text),
    String(addBtns.text),
  );
  check('「＋」按钮的 title 也跟上了', /checklist/i.test(String(addBtns.title)), String(addBtns.title));

  // Wrap up: restore the language to auto so we don't leave a pinned en for later scripts
  await goto(APP, '.app');
  await openSettings();
  await setSelect('[data-role="locale-select"]', 'auto');
  await sleep(300);
} else {
  console.log('SKIP  内容脚本注入的字（没找到可用的 discussion 页面）');
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

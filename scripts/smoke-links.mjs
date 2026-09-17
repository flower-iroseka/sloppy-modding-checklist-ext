// End-to-end smoke: whether a forum post resolves to an author, and the fallback label
// the card shows when no author can be resolved.
//
// The assertions are against the real site (it really does fetch the osu forums) and real
// storage, not UI text, so this one needs a network connection.
// Usage: node scripts/smoke-links.mjs <debugPort> <extensionId>
import { bringToFront, clickSelector, typeInto, warnIfHidden } from './cdp.mjs';

const [port, extId] = process.argv.slice(2);
if (!port || !extId) {
  console.error('usage: node scripts/smoke-links.mjs <debugPort> <extensionId>');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = `chrome-extension://${extId}/app.html?debug=1`;

// A real post we actually checked: post 2 of topic 2216866, author Kxxn (user 26595459).
const FORUM_POST = 'https://osu.ppy.sh/community/forums/posts/10229745';
const FORUM_AUTHOR = 'Kxxn';
// The same topic but without ?start= -- we can't pin down a specific post, and shouldn't guess.
const FORUM_TOPIC = 'https://osu.ppy.sh/community/forums/topics/2216866';

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
// Prefer reusing an app.html that's already open; otherwise just take any tab -- we
// navigate to it below anyway. The important part is not to assume the tab we picked is
// visible (see the notes about hidden tabs in cdp.mjs).
const target =
  list.find((t) => t.type === 'page' && t.url.includes('app.html')) ??
  list.find((t) => t.type === 'page');
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
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++idc;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r.result?.value;
}

/**
 * Poll until the expression is truthy and return its last evaluation result.
 *
 * @param expression the expression to evaluate in the page
 * @param label the name shown in the timeout message
 * @param tries how many times to try at most
 * @param gap how many milliseconds to wait between tries
 */
async function waitFor(expression, label, tries = 200, gap = 150) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await evaluate(expression).catch(() => undefined);
    if (last) return last;
    await sleep(gap);
  }
  console.log(`  · wait timed out (${label}): ${expression}`);
  return last;
}

// app.html is a plain page (shadow DOM is only used for the overlay injected into osu), so query the main document directly.
/**
 * @param selector CSS selector
 * @throws {Error} the element isn't on the page
 */
async function click(selector) {
  const how = await clickSelector(send, evaluate, `document.querySelector(${JSON.stringify(selector)})`, {
    sleep,
  });
  if (how === 'missing') throw new Error(`not found: ${selector}`);
}

/**
 * @param selector CSS selector
 * @param text the text to write
 */
async function typeText(selector, text) {
  await typeInto(send, evaluate, `document.querySelector(${JSON.stringify(selector)})`, text, { sleep });
}

async function blur(selector) {
  await evaluate(`document.querySelector(${JSON.stringify(selector)})?.blur()`);
}

// ---------------------------------------------------------------- Setup

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1400,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

await bringToFront(send);
await send('Page.navigate', { url: APP });
await waitFor(`!!window.__mc && window.__mc.state().hydrated`, 'app hydrated');
await warnIfHidden(evaluate);
await evaluate(`(async () => { window.__mc.clearAll(); await window.__mc.flush(); })()`);
await sleep(250);

// ---------------------------------------------------------------- 1) Forum post -> author

console.log('== 1) paste a forum post permalink, it should resolve the author ==');
await click('.zone[data-cell="general-internal"] .zone__add');
await sleep(400);
await typeText('#mc-summary', '论坛帖作者解析冒烟');
await click('.mc-modal__body .btn');
await typeText('.mc-linkrow input', FORUM_POST);
await blur('.mc-linkrow input');

const chip = await waitFor(
  `(() => {
     const el = document.querySelector('.mc-linkrow__author');
     if (!el) return null;
     const text = el.textContent.trim();
     return text === '读取作者…' ? null : text;
   })()`,
  'forum author resolution',
);
console.log(`  · author shown on the link row: ${JSON.stringify(chip)}`);
check('author resolved from the forum post link', chip === FORUM_AUTHOR, `got=${JSON.stringify(chip)} want=${FORUM_AUTHOR}`);

await click('.mc-modal__foot .btn--accent');
await sleep(700);

const stored = await waitFor(
  `(async () => {
     const b = await chrome.storage.local.get('checklist');
     const all = Object.entries(b.checklist.cells).flatMap(([cell, l]) => l.map((e) => ({ cell, ...e })));
     const hit = all.find((e) => (e.links ?? []).includes(${JSON.stringify(FORUM_POST)}));
     return hit ? { links: hit.links, linkAuthors: hit.linkAuthors ?? null } : null;
   })()`,
  'entry written to storage',
);
check(
  'resolved author written to storage linkAuthors',
  stored?.linkAuthors?.[FORUM_POST]?.username === FORUM_AUTHOR,
  JSON.stringify(stored?.linkAuthors),
);

const cardText = await evaluate(`(() => {
  const a = document.querySelector('.card__link');
  return a ? a.textContent.trim() : null;
})()`);
check('card shows "index + author"', cardText === `①${FORUM_AUTHOR}`, JSON.stringify(cardText));

// ---------------------------------------------------------------- 2) Fallback labels

console.log('\n== 2) fallback labels on the card when no author resolves ==');
await evaluate(`(async () => {
  window.__mc.clearAll();
  window.__mc.addEntry({ scope:'general', source:'internal', summary:'只有 topic，没有具体帖子', links:[${JSON.stringify(FORUM_TOPIC)}] });
  window.__mc.addEntry({ scope:'general', source:'external', summary:'站外视频', links:['https://www.youtube.com/watch?v=dQw4w9WgXcQ'] });
  window.__mc.addEntry({ scope:'individual', source:'external', summary:'站外文档', links:['https://docs.google.com/document/d/abc123/edit'] });
  window.__mc.addEntry({ scope:'individual', source:'internal', summary:'osu 用户主页', links:['https://osu.ppy.sh/users/26595459'] });
  await window.__mc.flush();
})()`);
await sleep(900);

const labels = await evaluate(`(() => [...document.querySelectorAll('.card__link')].map((a) => a.textContent.trim()))()`);
console.log(`  · card labels: ${JSON.stringify(labels)}`);

/**
 * Pick the card text that contains `needle` and assert its fallback label is `①<want>`.
 *
 * @param needle a fragment used to find the card, e.g. youtube
 * @param want the text of the fallback label apart from the index
 * @param describe the name printed when the assertion fails
 */
const expectLabel = (needle, want, describe) => {
  const got = labels.find((l) => l.includes(needle)) ?? null;
  check(describe, got === `①${want}`, JSON.stringify(got));
};

expectLabel('forum', 'forum topic 2216866', 'topic without ?start= → forum topic <id>');
expectLabel('youtube', 'youtube.com', 'YouTube → domain (not a bare watch)');
expectLabel('docs.', 'docs.google.com', 'Google Docs → domain (not a bare edit)');
expectLabel('user', 'user 26595459', 'osu user profile → user <id>');

// Wrap up
await evaluate(`(async () => { window.__mc.clearAll(); await window.__mc.flush(); })()`);

console.log(failures.length === 0 ? '\nALL LINK SMOKE CHECKS PASSED' : `\nFAILURES: ${failures.join(', ')}`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);

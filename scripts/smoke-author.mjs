// End-to-end smoke: add an osu permalink to an entry on the Checklist page and check
// whether the author gets recognized, whether the card shows "index + author", and
// whether the note button moved to the right side of the link row.
//
// The assertions are against the real site (it really does fetch osu) and real storage,
// not UI text, so this one needs a network connection.
// Usage: node scripts/smoke-author.mjs <debugPort> <extensionId>
import { bringToFront, clickSelector, typeInto, warnIfHidden } from './cdp.mjs';

const [port, extId] = process.argv.slice(2);
if (!port || !extId) {
  console.error('usage: node scripts/smoke-author.mjs <debugPort> <extensionId>');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = `chrome-extension://${extId}/app.html?debug=1`;

// A real post we actually checked: generalAll of beatmapsets/2608353, discussion id
// 5752323, author Daycore (user 5596337). A fixed id gives "the recognized author" a
// definite answer.
const PERMALINK = 'https://osu.ppy.sh/beatmapsets/2608353/discussion/-/generalAll#/5752323';
const EXPECTED_AUTHOR = 'Daycore';

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
async function waitFor(expression, label, tries = 80, gap = 150) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await evaluate(expression).catch(() => undefined);
    if (last) return last;
    await sleep(gap);
  }
  console.log(`  · wait timed out (${label}): ${expression}`);
  return last;
}

const resolve = (selector) => `document.querySelector(${JSON.stringify(selector)})`;

/**
 * @param selector CSS selector
 * @throws {Error} the element isn't on the page
 */
async function click(selector) {
  const how = await clickSelector(send, evaluate, resolve(selector), { sleep });
  if (how === 'missing') throw new Error(`not found: ${selector}`);
}

/**
 * @param selector CSS selector
 * @param text the text to write
 */
async function typeText(selector, text) {
  await typeInto(send, evaluate, resolve(selector), text, { sleep });
}

/** Trigger React's onBlur with a native blur (React 18 listens for bubbling focusout on the root container). */
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

// ---------------------------------------------------------------- 1) Resolve the author

console.log('== 1) add an entry on the Checklist page and paste a real permalink ==');
await click('.zone[data-cell="general-internal"] .zone__add');
await sleep(400);
await typeText('#mc-summary', '作者解析冒烟：generalAll 的一条 hype');
await click('.mc-modal__body .btn'); // the "add link" button
await typeText('.mc-linkrow input', PERMALINK);
await blur('.mc-linkrow input');

const chip = await waitFor(
  `(() => {
     const el = document.querySelector('.mc-linkrow__author');
     if (!el) return null;
     const text = el.textContent.trim();
     // still on the "reading author…" placeholder means it's in progress, keep waiting
     return text === '读取作者…' ? null : text;
   })()`,
  'author resolution',
);
console.log(`  · author shown on the link row: ${JSON.stringify(chip)}`);
check('author resolved from the permalink', chip === EXPECTED_AUTHOR, `got=${JSON.stringify(chip)} want=${EXPECTED_AUTHOR}`);

await click('.mc-modal__foot .btn--accent');
await sleep(700);

// ---------------------------------------------------------------- 2) Written to storage

// Poll until it lands on disk rather than flushing first and then asserting: the write
// is debounced by 300ms, and this headless tab gets throttled by Chrome, so in practice
// it takes 1-2.5s. Waiting a fixed amount either goes falsely red or is unreasonably
// slow. We don't poke it with __mc.flush() either -- that would skip over the very thing
// we're testing, that the change eventually lands on its own.
const stored = await waitFor(
  `(async () => {
     const b = await chrome.storage.local.get('checklist');
     const all = Object.entries(b.checklist.cells).flatMap(([cell, l]) => l.map((e) => ({ cell, ...e })));
     all.sort((x, y) => x.updatedAt - y.updatedAt);
     const last = all[all.length - 1];
     return last ? { links: last.links, linkAuthors: last.linkAuthors ?? null, sourceAuthor: last.sourceAuthor ?? null, meta: last.meta ?? null } : null;
   })()`,
  'entry written to storage',
);
console.log(`  · stored: ${JSON.stringify(stored)}`);
check(
  'resolved author written to storage linkAuthors (key = link)',
  stored?.linkAuthors?.[PERMALINK]?.username === EXPECTED_AUTHOR,
  JSON.stringify(stored?.linkAuthors),
);
check(
  'the author was not stuffed into the entry-level sourceAuthor (that field belongs to the content script)',
  stored?.sourceAuthor === null,
  JSON.stringify(stored?.sourceAuthor),
);
// The category is right there in the link URL, so don't store a second copy: that would
// drift when the link changes while meta still holds the old category. meta being
// entirely absent passes too (entries created by hand on the Checklist page have no page
// context, so there's no readable meta to begin with).
check(
  'no category in meta (the URL already carries it)',
  stored?.meta === null || !('category' in stored.meta),
  JSON.stringify(stored?.meta),
);

// ---------------------------------------------------------------- 3) Card display

console.log('\n== 2) card link text and layout ==');
const cardInfo = await evaluate(`(() => {
  const card = document.querySelector('.card');
  if (!card) return null;
  const link = card.querySelector('.card__link');
  const note = card.querySelector('.card__notebtn');
  const cardBox = card.getBoundingClientRect();
  const linkBox = link?.getBoundingClientRect() ?? null;
  const noteBox = note?.getBoundingClientRect() ?? null;
  return {
    linkText: link?.textContent.trim() ?? null,
    hasFoot: !!card.querySelector('.card__foot'),
    hasAuthorChip: !!card.querySelector('.card__author'),
    hasCategoryTag: !!card.querySelector('.card__tag'),
    cardBox: { top: cardBox.top, bottom: cardBox.bottom, height: cardBox.height, right: cardBox.right, left: cardBox.left },
    linkBox: linkBox && { top: linkBox.top, bottom: linkBox.bottom, left: linkBox.left, right: linkBox.right },
    noteBox: noteBox && { top: noteBox.top, bottom: noteBox.bottom, left: noteBox.left, right: noteBox.right },
  };
})()`);
console.log(`  · card: ${JSON.stringify(cardInfo, null, 2)}`);

check('link text is "index + author"', cardInfo?.linkText === `①${EXPECTED_AUTHOR}`, JSON.stringify(cardInfo?.linkText));
check('no more .card__foot row under the card', cardInfo?.hasFoot === false, String(cardInfo?.hasFoot));
check('no @author chip shown under the card anymore', cardInfo?.hasAuthorChip === false, String(cardInfo?.hasAuthorChip));
check('no category tag on the card', cardInfo?.hasCategoryTag === false, String(cardInfo?.hasCategoryTag));

const sameRow =
  cardInfo?.linkBox && cardInfo?.noteBox
    ? cardInfo.noteBox.top < cardInfo.linkBox.bottom && cardInfo.noteBox.bottom > cardInfo.linkBox.top
    : false;
check(
  'note button sits on the same row as the link (vertical ranges overlap)',
  sameRow,
  `link=[${cardInfo?.linkBox?.top}, ${cardInfo?.linkBox?.bottom}] note=[${cardInfo?.noteBox?.top}, ${cardInfo?.noteBox?.bottom}]`,
);

const noteRightGap = cardInfo?.noteBox ? cardInfo.cardBox.right - cardInfo.noteBox.right : 999;
check('note button is right-aligned', noteRightGap >= 0 && noteRightGap <= 20, `${noteRightGap.toFixed(1)}px from the card's right edge`);

// ---------------------------------------------------------------- 4) Links that shouldn't resolve

console.log('\n== 3) a link with no resolvable author: handled quietly, no error ==');
await click('.card__iconbtn[aria-label="编辑条目"]');
await sleep(500);
await click('.mc-modal__body .btn');
await typeText('.mc-linkrow:nth-of-type(2) input', 'https://docs.google.com/document/d/abc').catch(async () => {
  await typeText('.mc-linkrow:last-of-type input', 'https://docs.google.com/document/d/abc');
});
await blur('.mc-linkrow:last-of-type input');
await sleep(1200);

const third = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.mc-linkrow')];
  return rows.map((r) => ({
    value: r.querySelector('input')?.value ?? '',
    chip: r.querySelector('.mc-linkrow__author')?.textContent.trim() ?? null,
  }));
})()`);
console.log(`  · link rows in the modal: ${JSON.stringify(third)}`);
check(
  'a non-osu link shows no author chip (left as-is, no false positive)',
  third.at(-1)?.chip === null,
  JSON.stringify(third.at(-1)),
);
check(
  'the already-resolved row still shows its author (no re-resolution while editing)',
  third[0]?.chip === EXPECTED_AUTHOR,
  JSON.stringify(third[0]),
);

// Wrap up: close the modal
await evaluate(`document.querySelector('.mc-modal__foot .btn')?.click()`);
await sleep(400);

// ---------------------------------------------------------------- 5) The content script path

console.log('\n== 4) an entry created by the content script: the first link uses the entry author, later links must not piggyback on it ==');
// On an osu page the content script reads the author straight into sourceAuthor, so it's
// there at creation time and needs no resolution at all. We reproduce that shape with
// the real API here instead of driving the real site again.
await evaluate(`(async () => {
  window.__mc.clearAll();
  window.__mc.addEntry({
    scope: 'general',
    source: 'external',
    summary: '来自内容脚本的条目',
    links: [
      'https://osu.ppy.sh/beatmapsets/2547978/discussion/-/generalAll#/5752905',
      'https://osu.ppy.sh/beatmapsets/2608353/discussion/-/generalAll#/5752323',
    ],
    sourceAuthor: { id: 18104910, username: 'AztekX_X' },
  });
  await window.__mc.flush();
})()`);
await sleep(600);

const fallback = await evaluate(`(() => {
  const links = [...document.querySelectorAll('.card__link')].map((a) => a.textContent.trim());
  return links;
})()`);
console.log(`  · two links on the same card: ${JSON.stringify(fallback)}`);
check(
  'first link shows the entry author (the one the content script read; no resolution needed)',
  fallback[0] === '①AztekX_X',
  JSON.stringify(fallback[0]),
);
check(
  'the second link does not inherit the first one\'s author (that would misattribute it)',
  fallback[1] === '②#5752323',
  JSON.stringify(fallback[1]),
);

await evaluate(`(async () => { window.__mc.clearAll(); await window.__mc.flush(); })()`);

console.log(failures.length === 0 ? '\nALL AUTHOR SMOKE CHECKS PASSED' : `\nFAILURES: ${failures.join(', ')}`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);

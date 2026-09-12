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
  console.log(`  · 等待超时（${label}）：${expression}`);
  return last;
}

const resolve = (selector) => `document.querySelector(${JSON.stringify(selector)})`;

/**
 * @param selector CSS selector
 * @throws {Error} the element isn't on the page
 */
async function click(selector) {
  const how = await clickSelector(send, evaluate, resolve(selector), { sleep });
  if (how === 'missing') throw new Error(`找不到：${selector}`);
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
await waitFor(`!!window.__mc && window.__mc.state().hydrated`, 'app 水合');
await warnIfHidden(evaluate);
await evaluate(`(async () => { window.__mc.clearAll(); await window.__mc.flush(); })()`);
await sleep(250);

// ---------------------------------------------------------------- 1) Resolve the author

console.log('== 1) 在 Checklist 页新建条目，粘贴真实 permalink ==');
await click('.zone[data-cell="general-internal"] .zone__add');
await sleep(400);
await typeText('#mc-summary', '作者解析冒烟：generalAll 的一条 hype');
await click('.mc-modal__body .btn'); // the "＋ 添加链接" button
await typeText('.mc-linkrow input', PERMALINK);
await blur('.mc-linkrow input');

const chip = await waitFor(
  `(() => {
     const el = document.querySelector('.mc-linkrow__author');
     if (!el) return null;
     const text = el.textContent.trim();
     // "读取作者…" means it's still in progress, keep waiting
     return text === '读取作者…' ? null : text;
   })()`,
  '作者解析',
);
console.log(`  · 链接行上的作者显示：${JSON.stringify(chip)}`);
check('从 permalink 解析出作者', chip === EXPECTED_AUTHOR, `显示=${JSON.stringify(chip)} 期望=${EXPECTED_AUTHOR}`);

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
  '条目落盘',
);
console.log(`  · 落库：${JSON.stringify(stored)}`);
check(
  '解析结果写进 storage 的 linkAuthors（键 = 链接）',
  stored?.linkAuthors?.[PERMALINK]?.username === EXPECTED_AUTHOR,
  JSON.stringify(stored?.linkAuthors),
);
check(
  '没有把作者塞进条目级的 sourceAuthor（那是内容脚本的字段）',
  stored?.sourceAuthor === null,
  JSON.stringify(stored?.sourceAuthor),
);
// The category is right there in the link URL, so don't store a second copy: that would
// drift when the link changes while meta still holds the old category. meta being
// entirely absent passes too (entries created by hand on the Checklist page have no page
// context, so there's no readable meta to begin with).
check(
  'meta 里没有 category（URL 里已经有了）',
  stored?.meta === null || !('category' in stored.meta),
  JSON.stringify(stored?.meta),
);

// ---------------------------------------------------------------- 3) Card display

console.log('\n== 2) 卡片的链接文字与布局 ==');
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
console.log(`  · 卡片：${JSON.stringify(cardInfo, null, 2)}`);

check('链接文字是「序号 + 作者」', cardInfo?.linkText === `①${EXPECTED_AUTHOR}`, JSON.stringify(cardInfo?.linkText));
check('卡片下方不再有 .card__foot 那一行', cardInfo?.hasFoot === false, String(cardInfo?.hasFoot));
check('卡片下方不再显示 @作者', cardInfo?.hasAuthorChip === false, String(cardInfo?.hasAuthorChip));
check('卡片上没有分类标签', cardInfo?.hasCategoryTag === false, String(cardInfo?.hasCategoryTag));

const sameRow =
  cardInfo?.linkBox && cardInfo?.noteBox
    ? cardInfo.noteBox.top < cardInfo.linkBox.bottom && cardInfo.noteBox.bottom > cardInfo.linkBox.top
    : false;
check(
  '备注按钮与链接在同一行（纵向区间重叠）',
  sameRow,
  `link=[${cardInfo?.linkBox?.top}, ${cardInfo?.linkBox?.bottom}] note=[${cardInfo?.noteBox?.top}, ${cardInfo?.noteBox?.bottom}]`,
);

const noteRightGap = cardInfo?.noteBox ? cardInfo.cardBox.right - cardInfo.noteBox.right : 999;
check('备注按钮靠右对齐', noteRightGap >= 0 && noteRightGap <= 20, `距卡片右缘 ${noteRightGap.toFixed(1)}px`);

// ---------------------------------------------------------------- 4) Links that shouldn't resolve

console.log('\n== 3) 没有可解析作者的链接：安静处理，不报错 ==');
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
console.log(`  · 弹层里的链接行：${JSON.stringify(third)}`);
check(
  '非 osu 链接不显示任何作者标记（原样保留、不误报）',
  third.at(-1)?.chip === null,
  JSON.stringify(third.at(-1)),
);
check(
  '已解析的那条仍然显示作者（编辑时不重复解析）',
  third[0]?.chip === EXPECTED_AUTHOR,
  JSON.stringify(third[0]),
);

// Wrap up: close the modal
await evaluate(`document.querySelector('.mc-modal__foot .btn')?.click()`);
await sleep(400);

// ---------------------------------------------------------------- 5) The content script path

console.log('\n== 4) 内容脚本建的条目：首个链接用条目作者，后面的链接不该蹭 ==');
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
console.log(`  · 同一张卡上的两个链接：${JSON.stringify(fallback)}`);
check(
  '首个链接显示条目作者（内容脚本读到的那个，无需解析）',
  fallback[0] === '①AztekX_X',
  JSON.stringify(fallback[0]),
);
check(
  '第二个链接不继承首个的作者（否则就是张冠李戴）',
  fallback[1] === '②#5752323',
  JSON.stringify(fallback[1]),
);

await evaluate(`(async () => { window.__mc.clearAll(); await window.__mc.flush(); })()`);

console.log(failures.length === 0 ? '\nALL AUTHOR SMOKE CHECKS PASSED' : `\nFAILURES: ${failures.join(', ')}`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);

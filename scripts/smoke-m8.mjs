// M8 smoke: the polish layer -- focus, announcements, the empty-state entry point, and
// "if we say it, we really have to say it out loud".
//
// M8's changes are almost all invisible, so this script follows two rules. Keyboard goes
// through synthetic events, not `Input.dispatchKeyEvent` -- that one is dropped by an
// occluded tab just like mouse events (§12.2), and the focus assertions must hold even when
// the screen is locked; the browser's own Tab order isn't covered (§5.3 takes over only the
// two ends). Announcements are DOM assertions only: we can pin down "the region is there,
// the role is right, the content is that sentence", but not that a screen reader read it.
//
// Usage: node scripts/smoke-m8.mjs <debugPort> <extensionId>
import { clickSelector, warnIfHidden } from './cdp.mjs';

const [port, extId] = process.argv.slice(2);
if (!port || !extId) {
  console.error('usage: node scripts/smoke-m8.mjs <debugPort> <extensionId>');
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
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

// ?debug=1: build and clear data through `window.__mc`. Go through the store's real API
// rather than writing storage directly, so the page's store follows along -- write storage
// directly and the UI still shows the old thing, making the assertions fail falsely.
const APP = `chrome-extension://${extId}/app.html?debug=1`;
const POPUP = `chrome-extension://${extId}/popup.html`;

/**
 * Open a page and wait for the ready marker to show up.
 *
 * @param url the page address
 * @param readySel selector that answers "is it ready yet", defaults to .app
 * @returns whether it got there
 */
async function goto(url, readySel = '.app') {
  await send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    const ready = await evaluate(
      `document.readyState === 'complete' && !!document.querySelector(${JSON.stringify(readySel)})`,
    ).catch(() => false);
    if (ready) break;
  }
  await sleep(300);
}

// ---------------------------------------------------------------- Drivers

const exists = (sel) => evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = (sel) =>
  evaluate(`(document.querySelector(${JSON.stringify(sel)})?.textContent ?? '').trim()`);
const attr = (sel, name) =>
  evaluate(`document.querySelector(${JSON.stringify(sel)})?.getAttribute(${JSON.stringify(name)}) ?? null`);
const count = (sel) => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

const click = (sel) => clickSelector(send, evaluate, `document.querySelector(${JSON.stringify(sel)})`, { sleep });

/**
 * Click, but move focus onto it first.
 *
 * The overlay's "who gets focus back after closing" relies on `document.activeElement`, and
 * when the tab is occluded `clickSelector` degrades to `el.click()` -- which doesn't move
 * focus. Without an explicit focus first, "hand it back to the button that opened it" can't be
 * tested (the opener you get is whatever element happened to be left there last time).
 *
 * @param sel CSS selector
 */
async function focusClick(sel) {
  await evaluate(`document.querySelector(${JSON.stringify(sel)})?.focus()`);
  return click(sel);
}

/**
 * Write text into an input (same approach as cdp.mjs's degraded path: native setter + input
 * event).
 *
 * @param sel CSS selector
 * @param value the text to write in
 */
async function typeInto(sel, value) {
  const how = await click(sel);
  if (how === 'missing') return 'missing';
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(180);
  return how;
}

/**
 * Dispatch a synthetic keyboard event to document (see the file header for why).
 *
 * @param k the value of the key field, e.g. Tab / Escape
 * @param shift whether Shift is held
 */
const key = (k, shift = false) =>
  evaluate(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: ${JSON.stringify(k)}, shiftKey: ${shift}, bubbles: true, cancelable: true,
    }));
    return true;
  })()`);

/** A one-line description of `document.activeElement`, so a failure tells you where it ran off to. */
const activeInfo = () =>
  evaluate(`(() => {
    const el = document.activeElement;
    if (!el) return 'null';
    const cls = typeof el.className === 'string' ? el.className : '';
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls.trim().split(/\\s+/).join('.') : '');
  })()`);

const activeIs = async (sel) =>
  evaluate(`document.activeElement === document.querySelector(${JSON.stringify(sel)})`);

/**
 * The empty-state entry point for one cell.
 *
 * @param cell the cell name, e.g. general-external
 */
const zoneAdd = (cell) => `.zone[data-cell="${cell}"] [data-action="zone-empty-add"]`;

const clearAll = async () => {
  await evaluate(`(async () => { window.__mc.clearAll(); await window.__mc.flush(); return true; })()`);
  await sleep(300);
};

/**
 * @param cell the cell name
 * @returns which entries are in that cell (by id)
 */
const entryIds = (cell) =>
  evaluate(`((window.__mc.doc().cells[${JSON.stringify(cell)}]) ?? []).map((e) => e.id)`);

/**
 * @param cell the cell name
 * @returns how many entries are in that cell
 */
const totalIn = async (cell) => (await entryIds(cell)).length;

// ---------------------------------------------------------------- Start

await goto(APP);
await send('Page.bringToFront').catch(() => {});
const hidden = await warnIfHidden(evaluate);
console.log(`  标签页可见：${hidden ? '否（将退化）' : '是'}`);
console.log('  注：键盘走合成事件、焦点断言不经过合成器，所以本脚本不受 occluded 影响。');

await clearAll();

// ================================================================ Empty-state entry points

const EMPTY_ADD = '[data-action="zone-empty-add"]';
check('四个区的空态各有一个「添加一条」', (await count(EMPTY_ADD)) === 4, String(await count(EMPTY_ADD)));

// The "＋" sits in the top right of the zone heading and is only 22px; the empty state's blank space is what a new user actually sees.
check(
  '空态入口的 aria-label 说清了会加到哪一格',
  (await attr(zoneAdd('individual-external'), 'aria-label')) === '新增到 Individual External',
  await attr(zoneAdd('individual-external'), 'aria-label'),
);
check(
  '区标题那颗「＋」还在（空态入口是补充，不是替换）',
  (await count('[data-action="zone-empty-add"]')) === 4 && (await count('.zone__add')) === 4,
  `.zone__add = ${await count('.zone__add')}`,
);

// With the extra button the empty state is still a hittable drop area -- smoke-m2's
// cross-cell drag throws at the center of `.zone__empty`, and this box's height changes with
// the button. We assert the center point lands inside that droppable's `<ul>` -- what the
// drag really needs.
const emptyInsideList = await evaluate(`(() => {
  const bad = [];
  for (const z of document.querySelectorAll('.zone')) {
    const empty = z.querySelector('.zone__empty');
    const list = z.querySelector('.zone__list');
    if (!empty || !list) { bad.push(z.dataset.cell + ':missing'); continue; }
    const e = empty.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    const cx = e.x + e.width / 2;
    const cy = e.y + e.height / 2;
    const inside = cx >= l.x && cx <= l.right && cy >= l.y && cy <= l.bottom;
    if (!inside) bad.push(z.dataset.cell);
  }
  return bad;
})()`);
check('四个区的空态中心都还在各自的拖放区里（smoke-m2 的落点依赖这个）', emptyInsideList.length === 0, JSON.stringify(emptyInsideList));

// --- Click the empty-state entry point -> the overlay preselects that cell -----------------------------------
// focusClick instead of click here; see its comment for why (the first version went falsely
// red because the opener came back as body).
await focusClick(zoneAdd('general-external'));
await sleep(250);
check('点空态入口打开了浮层', await exists('.mc-modal'));
check('浮层标题是「添加到 Checklist」', (await text('.mc-modal__title')) === '添加到 Checklist', await text('.mc-modal__title'));

/** The option currently selected in each of the two segmented controls (`.mc-seg__opt--on` order = scope, source). */
const segSelected = () =>
  evaluate(`[...document.querySelectorAll('.mc-seg__opt--on')].map((b) => b.textContent.trim())`);
check(
  '默认选中点进来的那一格（General × External）',
  JSON.stringify(await segSelected()) === JSON.stringify(['General', 'External']),
  JSON.stringify(await segSelected()),
);

// ================================================================ Focus: enter / cycle / return

// --- Accessibility attributes ---------------------------------------------------------
check('浮层是 role="dialog" + aria-modal', (await attr('.mc-modal__panel', 'role')) === 'dialog' && (await attr('.mc-modal__panel', 'aria-modal')) === 'true');
check(
  '标题不是写死的 aria-label，而是 aria-labelledby 指向那颗真的 <h2>',
  (await attr('.mc-modal__panel', 'aria-label')) === null &&
    (await evaluate(`(() => {
      const p = document.querySelector('.mc-modal__panel');
      const id = p.getAttribute('aria-labelledby');
      const t = document.getElementById(id);
      return !!t && t.textContent.trim() === '添加到 Checklist';
    })()`)) === true,
  `aria-label=${await attr('.mc-modal__panel', 'aria-label')}`,
);

check('打开时焦点已经进了浮层（不用先 Tab 一遍）', await activeIs('#mc-summary'), await activeInfo());

// --- Wrapping at both ends -----------------------------------------------------------
// Fill in the summary first: otherwise the "添加" button in the footer stays disabled,
// `focusablesIn` filters it out, and "the last one" is some element we don't care about.
await typeInto('#mc-summary', '焦点循环用的一条');

const LAST = '.mc-modal__foot .btn--accent';
const FIRST = '.mc-modal__close';
check('（前置）概述填上后页脚的「添加」可用了', (await evaluate(`!document.querySelector(${JSON.stringify(LAST)}).disabled`)) === true);

await evaluate(`document.querySelector(${JSON.stringify(LAST)}).focus()`);
check('（前置）焦点停在了最后一个可聚焦元素上', await activeIs(LAST), await activeInfo());
await key('Tab');
check('最后一个再按 Tab → 回到第一个（不跑出浮层）', await activeIs(FIRST), await activeInfo());

await evaluate(`document.querySelector(${JSON.stringify(FIRST)}).focus()`);
await key('Tab', true);
check('第一个再按 Shift+Tab → 跳到最后一个', await activeIs(LAST), await activeInfo());

// Reverse case: middle positions must be let through. If the check above were written as "Tab always snaps to the first", these two would go red.
await evaluate(`document.querySelector('#mc-summary').focus()`);
await key('Tab');
check('中间位置按 Tab 不被接管（浏览器自己的顺序说了算）', await activeIs('#mc-summary'), await activeInfo());
await key('Tab', true);
check('中间位置按 Shift+Tab 同样不被接管', await activeIs('#mc-summary'), await activeInfo());

// --- Esc closes + focus returns -------------------------------------------------
await evaluate(`document.querySelector('#mc-note').focus()`);
await key('Escape');
await sleep(250);
check('Esc 关掉浮层', !(await exists('.mc-modal')));
check('关掉之后焦点回到打开它的那颗按钮（不用从头 Tab 一遍）', await activeIs(zoneAdd('general-external')), await activeInfo());

// --- Opened from the "＋" -> it still returns -------------------------------------------------
await focusClick('.zone[data-cell="general-internal"] .zone__add');
await sleep(250);
check('（前置）「＋」也能打开浮层', await exists('.mc-modal'));
await key('Escape');
await sleep(250);
check('从「＋」进、Esc 出 → 焦点还回「＋」', await activeIs('.zone[data-cell="general-internal"] .zone__add'), await activeInfo());

// ================================================================ Toasts and announcements

check('toast 容器常驻（没有提示时也在 DOM 里）', await exists('.mc-toasts'), String(await count('.mc-toasts')));
check(
  '两个 live region 都在，且分了 polite / assertive',
  (await exists('.mc-toasts [data-live="polite"]')) && (await exists('.mc-toasts [data-live="assertive"]')),
);
check(
  '错误那一路的角色是 alert + assertive（能打断读屏器）',
  (await attr('.mc-toasts [data-live="assertive"]', 'role')) === 'alert' &&
    (await attr('.mc-toasts [data-live="assertive"]', 'aria-live')) === 'assertive',
);
// An empty region must not take up space: the wrapper used `gap`, so two empty boxes would leave a gap in the middle and push the toasts off-center.
check(
  '空着的时候两个区域都不占地方（不然 toast 会被顶偏）',
  (await evaluate(`(() => {
    const r = document.querySelector('.mc-toasts').getBoundingClientRect();
    return Math.round(r.height);
  })()`)) === 0,
  `高度 = ${await evaluate(`Math.round(document.querySelector('.mc-toasts').getBoundingClientRect().height)`)}`,
);

/** Text of all current toasts. */
const toastTexts = () =>
  evaluate(`[...document.querySelectorAll('.mc-toast')].map((t) => t.textContent.trim())`);
/** Text inside one live region (the two toast slots). */
const regionTexts = (kind) =>
  evaluate(`[...document.querySelectorAll('.mc-toasts [data-live="${kind}"] .mc-toast')].map((t) => t.textContent.trim())`);

// --- Add -> added -------------------------------------------------------
await click(zoneAdd('general-external'));
await sleep(250);
await typeInto('#mc-summary', 'M8 冒烟用的第一条');
await click('.mc-modal__foot .btn--accent');
await sleep(350);
check('新增后提示「已添加」', (await toastTexts()).includes('已添加'), JSON.stringify(await toastTexts()));
check('那条提示进的是 polite 区（不是打断型的）', (await regionTexts('polite')).includes('已添加'), JSON.stringify(await regionTexts('polite')));
check('新条目真的落到了刚才那一格', (await totalIn('general-external')) === 1, String(await totalIn('general-external')));
check('那一格的空态入口随之消失（只剩三个）', (await count(EMPTY_ADD)) === 3, String(await count(EMPTY_ADD)));

// Writing to disk is debounced by 300ms and this background tab is throttled by Chrome, so in
// practice it takes 1-2.5s (§12.2). A hardcoded sleep either goes falsely red or wastes time,
// so we poll until it shows up (equivalent to "it wrote itself down", not us flushing for it).
const storedCount = async () =>
  evaluate(`(async () => {
    const doc = (await chrome.storage.local.get('checklist')).checklist;
    return (doc?.cells?.['general-external'] ?? []).length;
  })()`);
let stored = 0;
for (let i = 0; i < 20; i++) {
  stored = await storedCount();
  if (stored === 1) break;
  await sleep(200);
}
check('落库了（不靠 flush，等它自己写完）', stored === 1, String(stored));

// --- Note -> note saved ---------------------------------------------------
const CARD = '.zone[data-cell="general-external"] .card';
await click(`${CARD} .card__notebtn`);
await sleep(200);
check('点「备注」就地展开编辑器', await exists(`${CARD} .card__noteta`));
await typeInto(`${CARD} .card__noteta`, '复现方式：开 HR');
await click(`${CARD} .card__noteactions .btn--accent`);
await sleep(350);
check('保存备注后提示「备注已保存」', (await toastTexts()).includes('备注已保存'), JSON.stringify(await toastTexts()));
check(
  '备注真的写进去了',
  (await evaluate(`window.__mc.doc().cells['general-external'][0].note ?? ''`)) === '复现方式：开 HR',
  await evaluate(`window.__mc.doc().cells['general-external'][0].note ?? ''`),
);

// --- Delete (two clicks) -> deleted ------------------------------------------------
await click(`${CARD} [aria-label="删除条目"]`);
await sleep(200);
check('第一下只是变成「确认删除」（这一下不该有 toast）', (await exists(`${CARD} [aria-label="确认删除"]`)) === true);
check('第一下没有删掉任何东西', (await totalIn('general-external')) === 1, String(await totalIn('general-external')));

await click(`${CARD} [aria-label="确认删除"]`);
await sleep(350);
check('第二下才真删', (await totalIn('general-external')) === 0, String(await totalIn('general-external')));
// The card disappearing is feedback in itself, but "it disappeared" looks the same as "the click missed" -- especially once that button has already changed appearance.
check('删除后有提示「已删除」', (await toastTexts()).includes('已删除'), JSON.stringify(await toastTexts()));
check('那一格的空态入口回来了', (await count(EMPTY_ADD)) === 4, String(await count(EMPTY_ADD)));

// ================================================================ Announcements for the persistent notices

// Look it up by `data-tab`, not by text: from M9 the tab text follows the UI language, so
// searching for "设置" would silently click nothing once the debug browser is switched to English.
await evaluate(`document.querySelector('.app__tab[data-tab="settings"]')?.click()`);
for (let i = 0; i < 40; i++) {
  await sleep(120);
  if (await exists('[data-panel="data"]')) break;
}

// ---------------------------------------------------------------- About card

/**
 * The About card at the bottom of the settings page.
 *
 * The hrefs are pinned here because a mistyped one is invisible: the link renders, it just
 * goes somewhere wrong (or nowhere). It already happened once while writing it.
 */
const about = await evaluate(`(() => {
  const box = document.querySelector('[data-panel="about"]');
  if (!box) return null;
  return {
    text: box.innerText.replace(/\\s+/g, ' ').trim(),
    hrefs: [...box.querySelectorAll('a')].map((a) => a.getAttribute('href')),
    // The attribution note is the small print, one step below the panel body.
    noteSize: parseFloat(getComputedStyle(box.querySelector('.panel__note')).fontSize),
    bodySize: parseFloat(getComputedStyle(box.querySelector('.panel__body')).fontSize),
  };
})()`);
check('设置页最下面有「关于」卡片', about !== null, JSON.stringify(about));
check(
  '关于卡片里有作者与 license',
  /flower-iroseka/.test(about?.text ?? '') && /MIT/.test(about?.text ?? ''),
  about?.text,
);
check(
  '关于卡片声明了 vibe coding',
  /DeepSeek V4/.test(about?.text ?? ''),
  about?.text,
);
check(
  '三个链接指对了地方',
  JSON.stringify(about?.hrefs) ===
    JSON.stringify([
      'https://github.com/flower-iroseka/sloppy-modding-checklist-ext',
      'https://osu.ppy.sh/users/6485263',
      'https://electoz.s-ul.eu/N7Y53Jaj',
    ]),
  JSON.stringify(about?.hrefs),
);
check(
  '出处的说明用的是更小的字号',
  typeof about?.noteSize === 'number' && about.noteSize < about.bodySize,
  `${about?.noteSize}px vs ${about?.bodySize}px`,
);

const ANNOUNCE = '[data-announce]';
// The data panel: two, "result" + "failure"; the sync panel has one more than that -- the
// conflict entry stands on its own (it has a question to say, not the result of an action).
check(
  '设置页里两个面板各自都有常驻播报区',
  (await count('[data-panel="data"] [data-announce]')) === 2 &&
    (await count('.panel:not([data-panel="data"]) [data-announce]')) === 3,
  `数据 ${await count('[data-panel="data"] [data-announce]')} / 同步 ${await count('.panel:not([data-panel="data"]) [data-announce]')}`,
);
check(
  '播报区有 polite / assertive 两种角色',
  (await exists('[data-announce="polite"][role="status"]')) && (await exists('[data-announce="assertive"][role="alert"]')),
);
// The conflict region is always there, but it has to stay silent when there's no conflict --
// otherwise a screen reader reads out "sync conflict: ..." the moment the page opens.
check(
  '没有冲突时，冲突那条播报区是空的',
  !(await evaluate(`[...document.querySelectorAll('[data-announce="assertive"]')].some((e) => /冲突/.test(e.textContent))`)),
);
// They're out of flow via `position: absolute`, so they don't push anything open in a flex/gap
// container either (the popup is flex + gap 12px) -- the one part of that design a machine can check.
const announceLayout = await evaluate(`(() => {
  const bad = [];
  for (const el of document.querySelectorAll('[data-announce]')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'absolute') { bad.push(cs.position); continue; }
    const r = el.getBoundingClientRect();
    if (r.width > 2 || r.height > 2) bad.push(Math.round(r.width) + 'x' + Math.round(r.height));
  }
  return bad;
})()`);
check('常驻播报区一律脱离文档流（零布局影响）', announceLayout.length === 0, JSON.stringify(announceLayout));

// The visible line and the announced line have to be the same sentence -- write two copies and one side gets missed in a change sooner or later.
const DATA_NOTICE = '[data-panel="data"] .ok-text';
await click('[data-action="export-json"]');
await sleep(400);
const exportNotice = await text(DATA_NOTICE);
check('（前置）导出后页面上出现了结果提示', /已导出/.test(exportNotice), exportNotice);
check(
  '同一句话也进了 polite 播报区（读屏器听得到）',
  (await evaluate(`[...document.querySelectorAll('[data-announce="polite"]')].map((e) => e.textContent.trim())`)).includes(exportNotice),
  JSON.stringify(await evaluate(`[...document.querySelectorAll('[data-announce="polite"]')].map((e) => e.textContent.trim())`)),
);
check(
  '错误的播报区此时是空的（不是把成功也塞进 alert）',
  (await text('[data-announce="assertive"]')) === '' ||
    !(await evaluate(`[...document.querySelectorAll('[data-announce="assertive"]')].map((e) => e.textContent.trim())`)).some((t) => /已导出/.test(t)),
);

// ================================================================ popup

await goto(POPUP, '[data-hydrated="true"]');
check('popup 水合完成', (await attr('.pu', 'data-hydrated')) === 'true');
// The popup has only one kind of thing to announce: failing to read data / failing to open the
// page. Both are "something went wrong", so there's just one assertive region -- don't squeeze
// a polite one in for symmetry.
check(
  'popup 里有常驻播报区，而且是 assertive 的',
  (await count('[data-announce="assertive"][role="alert"]')) === 1,
  `assertive = ${await count('[data-announce="assertive"]')} / polite = ${await count('[data-announce="polite"]')}`,
);
check(
  'popup 的播报区同样脱离文档流（它是 flex + gap，占位了会把按钮顶低）',
  (await evaluate(`[...document.querySelectorAll('[data-announce]')].every((el) => getComputedStyle(el).position === 'absolute')`)) === true,
);
// An empty state that only says "no records yet" just blocks you -- the copy has to point at both ways out.
const emptyHint = await text('.pu__hint');
check(
  'popup 空态把两条路都说了（去 discussion 页收 / 打开页面手动加）',
  /discussion/i.test(emptyHint) && /Checklist/.test(emptyHint),
  emptyHint,
);
check(
  'popup 空态没有再生一个和下面一样的主按钮',
  (await count('.pu__open')) === 1,
  String(await count('.pu__open')),
);

// ---------------------------------------------------------------- Wrap up

console.log('');
if (failures.length === 0) {
  console.log('全部通过（不联网）');
} else {
  console.log(`${failures.length} 项失败：`);
  for (const f of failures) console.log(`  - ${f}`);
}
ws.close();
process.exit(failures.length === 0 ? 0 : 1);

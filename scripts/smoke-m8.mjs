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
console.log(`  tab visible: ${hidden ? 'no (will fall back)' : 'yes'}`);
console.log('  note: keyboard goes through synthetic events and the focus assertions never touch the compositor, so an occluded tab does not affect this script.');

await clearAll();

// ================================================================ Empty-state entry points

const EMPTY_ADD = '[data-action="zone-empty-add"]';
check('each of the four zones has one "add an entry" in its empty state', (await count(EMPTY_ADD)) === 4, String(await count(EMPTY_ADD)));

// The "＋" sits in the top right of the zone heading and is only 22px; the empty state's blank space is what a new user actually sees.
check(
  "the empty-state entry point's aria-label says which zone it adds to",
  (await attr(zoneAdd('individual-external'), 'aria-label')) === '新增到 Individual External',
  await attr(zoneAdd('individual-external'), 'aria-label'),
);
check(
  'the "＋" in the zone heading is still there (the empty-state entry point is a supplement, not a replacement)',
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
check('the empty-state center is still inside the drop area of all four zones (smoke-m2 drops there)', emptyInsideList.length === 0, JSON.stringify(emptyInsideList));

// --- Click the empty-state entry point -> the overlay preselects that cell -----------------------------------
// focusClick instead of click here; see its comment for why (the first version went falsely
// red because the opener came back as body).
await focusClick(zoneAdd('general-external'));
await sleep(250);
check('clicking the empty-state entry point opens the overlay', await exists('.mc-modal'));
check('overlay title is "添加到 Checklist"', (await text('.mc-modal__title')) === '添加到 Checklist', await text('.mc-modal__title'));

/** The option currently selected in each of the two segmented controls (`.mc-seg__opt--on` order = scope, source). */
const segSelected = () =>
  evaluate(`[...document.querySelectorAll('.mc-seg__opt--on')].map((b) => b.textContent.trim())`);
check(
  'preselects the zone it was opened from (General × External)',
  JSON.stringify(await segSelected()) === JSON.stringify(['General', 'External']),
  JSON.stringify(await segSelected()),
);

// ================================================================ Focus: enter / cycle / return

// --- Accessibility attributes ---------------------------------------------------------
check('the overlay is role="dialog" + aria-modal', (await attr('.mc-modal__panel', 'role')) === 'dialog' && (await attr('.mc-modal__panel', 'aria-modal')) === 'true');
check(
  'the title is not a hardcoded aria-label but aria-labelledby pointing at the real <h2>',
  (await attr('.mc-modal__panel', 'aria-label')) === null &&
    (await evaluate(`(() => {
      const p = document.querySelector('.mc-modal__panel');
      const id = p.getAttribute('aria-labelledby');
      const t = document.getElementById(id);
      return !!t && t.textContent.trim() === '添加到 Checklist';
    })()`)) === true,
  `aria-label=${await attr('.mc-modal__panel', 'aria-label')}`,
);

check('focus is already inside the overlay when it opens (no need to Tab first)', await activeIs('#mc-summary'), await activeInfo());

// --- Wrapping at both ends -----------------------------------------------------------
// Fill in the summary first: otherwise the "add" button in the footer stays disabled,
// `focusablesIn` filters it out, and "the last one" is some element we don't care about.
await typeInto('#mc-summary', '焦点循环用的一条');

const LAST = '.mc-modal__foot .btn--accent';
const FIRST = '.mc-modal__close';
check('(precondition) the footer "add" button is enabled once the summary is filled in', (await evaluate(`!document.querySelector(${JSON.stringify(LAST)}).disabled`)) === true);

await evaluate(`document.querySelector(${JSON.stringify(LAST)}).focus()`);
check('(precondition) focus sits on the last focusable element', await activeIs(LAST), await activeInfo());
await key('Tab');
check('Tab on the last one → back to the first (it does not escape the overlay)', await activeIs(FIRST), await activeInfo());

await evaluate(`document.querySelector(${JSON.stringify(FIRST)}).focus()`);
await key('Tab', true);
check('Shift+Tab on the first one → jumps to the last', await activeIs(LAST), await activeInfo());

// Reverse case: middle positions must be let through. If the check above were written as "Tab always snaps to the first", these two would go red.
await evaluate(`document.querySelector('#mc-summary').focus()`);
await key('Tab');
check('Tab in a middle position is not taken over (the browser order decides)', await activeIs('#mc-summary'), await activeInfo());
await key('Tab', true);
check('Shift+Tab in a middle position is not taken over either', await activeIs('#mc-summary'), await activeInfo());

// --- Esc closes + focus returns -------------------------------------------------
await evaluate(`document.querySelector('#mc-note').focus()`);
await key('Escape');
await sleep(250);
check('Esc closes the overlay', !(await exists('.mc-modal')));
check('after closing, focus goes back to the button that opened it (no Tab from the top again)', await activeIs(zoneAdd('general-external')), await activeInfo());

// --- Opened from the "＋" -> it still returns -------------------------------------------------
await focusClick('.zone[data-cell="general-internal"] .zone__add');
await sleep(250);
check('(precondition) the "＋" opens the overlay too', await exists('.mc-modal'));
await key('Escape');
await sleep(250);
check('in through "＋", out with Esc → focus goes back to "＋"', await activeIs('.zone[data-cell="general-internal"] .zone__add'), await activeInfo());

// ================================================================ Toasts and announcements

check('the toast container is always there (in the DOM even with no toast)', await exists('.mc-toasts'), String(await count('.mc-toasts')));
check(
  'both live regions exist, split into polite / assertive',
  (await exists('.mc-toasts [data-live="polite"]')) && (await exists('.mc-toasts [data-live="assertive"]')),
);
check(
  'the error path has role alert + assertive (it can interrupt a screen reader)',
  (await attr('.mc-toasts [data-live="assertive"]', 'role')) === 'alert' &&
    (await attr('.mc-toasts [data-live="assertive"]', 'aria-live')) === 'assertive',
);
// An empty region must not take up space: the wrapper used `gap`, so two empty boxes would leave a gap in the middle and push the toasts off-center.
check(
  'both regions take up no space while empty (otherwise the toasts get pushed off-center)',
  (await evaluate(`(() => {
    const r = document.querySelector('.mc-toasts').getBoundingClientRect();
    return Math.round(r.height);
  })()`)) === 0,
  `height = ${await evaluate(`Math.round(document.querySelector('.mc-toasts').getBoundingClientRect().height)`)}`,
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
check('after adding, the toast says "已添加"', (await toastTexts()).includes('已添加'), JSON.stringify(await toastTexts()));
check('that toast goes into the polite region (not the interrupting one)', (await regionTexts('polite')).includes('已添加'), JSON.stringify(await regionTexts('polite')));
check('the new entry really landed in the zone we clicked', (await totalIn('general-external')) === 1, String(await totalIn('general-external')));
check('the empty-state entry point of that zone is gone with it (three left)', (await count(EMPTY_ADD)) === 3, String(await count(EMPTY_ADD)));

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
check('written to storage (without flush, we let it finish on its own)', stored === 1, String(stored));

// --- Note -> note saved ---------------------------------------------------
const CARD = '.zone[data-cell="general-external"] .card';
await click(`${CARD} .card__notebtn`);
await sleep(200);
check('clicking "note" expands the editor in place', await exists(`${CARD} .card__noteta`));
await typeInto(`${CARD} .card__noteta`, '复现方式：开 HR');
await click(`${CARD} .card__noteactions .btn--accent`);
await sleep(350);
check('after saving the note the toast says "备注已保存"', (await toastTexts()).includes('备注已保存'), JSON.stringify(await toastTexts()));
check(
  'the note really got written in',
  (await evaluate(`window.__mc.doc().cells['general-external'][0].note ?? ''`)) === '复现方式：开 HR',
  await evaluate(`window.__mc.doc().cells['general-external'][0].note ?? ''`),
);

// --- Delete (two clicks) -> deleted ------------------------------------------------
await click(`${CARD} [aria-label="删除条目"]`);
await sleep(200);
check('the first click only turns into "确认删除" (no toast at this point)', (await exists(`${CARD} [aria-label="确认删除"]`)) === true);
check('the first click deletes nothing', (await totalIn('general-external')) === 1, String(await totalIn('general-external')));

await click(`${CARD} [aria-label="确认删除"]`);
await sleep(350);
check('only the second click really deletes', (await totalIn('general-external')) === 0, String(await totalIn('general-external')));
// The card disappearing is feedback in itself, but "it disappeared" looks the same as "the click missed" -- especially once that button has already changed appearance.
check('after deleting the toast says "已删除"', (await toastTexts()).includes('已删除'), JSON.stringify(await toastTexts()));
check('the empty-state entry point of that zone is back', (await count(EMPTY_ADD)) === 4, String(await count(EMPTY_ADD)));

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
check('there is an About card at the bottom of the settings page', about !== null, JSON.stringify(about));
check(
  'the About card has the author and the license',
  /flower-iroseka/.test(about?.text ?? '') && /MIT/.test(about?.text ?? ''),
  about?.text,
);
check(
  'the About card declares vibe coding',
  /DeepSeek V4/.test(about?.text ?? ''),
  about?.text,
);
check(
  'the three links point where they should',
  JSON.stringify(about?.hrefs) ===
    JSON.stringify([
      'https://github.com/flower-iroseka/sloppy-modding-checklist-ext',
      'https://osu.ppy.sh/users/6485263',
      'https://electoz.s-ul.eu/N7Y53Jaj',
    ]),
  JSON.stringify(about?.hrefs),
);
check(
  'the attribution note uses a smaller font size',
  typeof about?.noteSize === 'number' && about.noteSize < about.bodySize,
  `${about?.noteSize}px vs ${about?.bodySize}px`,
);

const ANNOUNCE = '[data-announce]';
// The data panel: two, "result" + "failure"; the sync panel has one more than that -- the
// conflict entry stands on its own (it has a question to say, not the result of an action).
check(
  'each of the two panels on the settings page has its own persistent announcement region',
  (await count('[data-panel="data"] [data-announce]')) === 2 &&
    (await count('.panel:not([data-panel="data"]) [data-announce]')) === 3,
  `data ${await count('[data-panel="data"] [data-announce]')} / sync ${await count('.panel:not([data-panel="data"]) [data-announce]')}`,
);
check(
  'the announcement regions have both polite / assertive roles',
  (await exists('[data-announce="polite"][role="status"]')) && (await exists('[data-announce="assertive"][role="alert"]')),
);
// The conflict region is always there, but it has to stay silent when there's no conflict --
// otherwise a screen reader reads out "sync conflict: ..." the moment the page opens.
check(
  'with no conflict, the conflict announcement region is empty',
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
check('persistent announcement regions are all out of flow (zero layout impact)', announceLayout.length === 0, JSON.stringify(announceLayout));

// The visible line and the announced line have to be the same sentence -- write two copies and one side gets missed in a change sooner or later.
const DATA_NOTICE = '[data-panel="data"] .ok-text';
await click('[data-action="export-json"]');
await sleep(400);
const exportNotice = await text(DATA_NOTICE);
check('(precondition) a result notice shows up on the page after export', /已导出/.test(exportNotice), exportNotice);
check(
  'the same sentence also goes into the polite announcement region (a screen reader can hear it)',
  (await evaluate(`[...document.querySelectorAll('[data-announce="polite"]')].map((e) => e.textContent.trim())`)).includes(exportNotice),
  JSON.stringify(await evaluate(`[...document.querySelectorAll('[data-announce="polite"]')].map((e) => e.textContent.trim())`)),
);
check(
  'the error announcement region is empty at this point (success is not stuffed into alert)',
  (await text('[data-announce="assertive"]')) === '' ||
    !(await evaluate(`[...document.querySelectorAll('[data-announce="assertive"]')].map((e) => e.textContent.trim())`)).some((t) => /已导出/.test(t)),
);

// ================================================================ popup

await goto(POPUP, '[data-hydrated="true"]');
check('popup hydrated', (await attr('.pu', 'data-hydrated')) === 'true');
// The popup has only one kind of thing to announce: failing to read data / failing to open the
// page. Both are "something went wrong", so there's just one assertive region -- don't squeeze
// a polite one in for symmetry.
check(
  'the popup has a persistent announcement region, and it is assertive',
  (await count('[data-announce="assertive"][role="alert"]')) === 1,
  `assertive = ${await count('[data-announce="assertive"]')} / polite = ${await count('[data-announce="polite"]')}`,
);
check(
  "the popup's announcement region is out of flow too (it is flex + gap, taking up space would push the buttons down)",
  (await evaluate(`[...document.querySelectorAll('[data-announce]')].every((el) => getComputedStyle(el).position === 'absolute')`)) === true,
);
// An empty state that only says "no records yet" just blocks you -- the copy has to point at both ways out.
const emptyHint = await text('.pu__hint');
check(
  'the popup empty state points at both ways out (collect on a discussion page / open the page and add by hand)',
  /discussion/i.test(emptyHint) && /Checklist/.test(emptyHint),
  emptyHint,
);
check(
  'the popup empty state does not add a second primary button like the one below',
  (await count('.pu__open')) === 1,
  String(await count('.pu__open')),
);

// ---------------------------------------------------------------- Wrap up

console.log('');
if (failures.length === 0) {
  console.log('all passed (no network)');
} else {
  console.log(`${failures.length} checks failed:`);
  for (const f of failures) console.log(`  - ${f}`);
}
ws.close();
process.exit(failures.length === 0 ? 0 : 1);

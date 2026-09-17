// M2 end-to-end smoke (dev only): drive app.html with real pointer events in a real
// Chromium and verify the cards, the modal, notes, and the two-step delete confirmation,
// and above all that @dnd-kit sorting and cross-cell drags really land in storage.
// Depends on window.__mc exposed by app.html?debug=1 (src/shared/devtools.ts).
// Usage: node scripts/smoke-m2.mjs <debugPort> <extensionId>
import { bringToFront, clickSelector, requireInteractive, warnIfHidden } from './cdp.mjs';

const [port, extId] = process.argv.slice(2);
if (!port || !extId) {
  console.error('usage: node scripts/smoke-m2.mjs <debugPort> <extensionId>');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE = `chrome-extension://${extId}/app.html?debug=1`;

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
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
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
  if (r.exceptionDetails) {
    throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? 'unknown'}`);
  }
  return r.result?.value;
}

// ---------------------------------------------------------------- Pointer actions

/**
 * Dispatch a real mouse event.
 *
 * @param type mousePressed / mouseMoved / mouseReleased
 * @param x viewport coordinate
 * @param y viewport coordinate
 * @param extra extra fields to put into the CDP params
 */
async function mouse(type, x, y, extra = {}) {
  await send('Input.dispatchMouseEvent', {
    type,
    x: Math.round(x),
    y: Math.round(y),
    button: 'left',
    buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1,
    ...extra,
  });
}

/**
 * Get the element's center in viewport coordinates, plus its bounds.
 *
 * @param selector CSS selector
 * @returns the center x/y, plus left/top/w/h
 * @throws {Error} the element isn't on the page
 */
async function rectOf(selector) {
  const r = await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, left: b.x, top: b.y, w: b.width, h: b.height };
  })()`);
  if (!r) throw new Error(`element not found: ${selector}`);
  return r;
}

/**
 * A real mouse drag: press -> cross the 4px activation threshold -> move to the target in
 * steps -> release.
 *
 * The coordinates have to be taken before the press: dnd-kit measures the rects of all
 * droppables once when the drag starts, and while dragging the cards get CSS transforms to
 * make room, but hit testing still uses the initial layout positions. Recompute the
 * coordinates halfway through and you end up chasing cards that "already moved", dropping
 * in the wrong place.
 *
 * @param fromSelector press here
 * @param toSelector release here
 */
async function dragTo(fromSelector, toSelector) {
  // A drag can't fall back to programmatic events (dnd-kit needs the real mouseMoved
  // movement), so we report an environment error when the tab isn't visible rather than
  // letting it turn into a fake assertion failure.
  await requireInteractive(evaluate, `drag from ${fromSelector} → ${toSelector}`);

  const from = await rectOf(fromSelector);
  const to = await rectOf(toSelector);

  await mouse('mousePressed', from.x, from.y);
  await sleep(60);
  // Move a little first to trigger the activationConstraint (distance: 4)
  await mouse('mouseMoved', from.x + 8, from.y + 8);
  await sleep(80);

  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await sleep(45);
  }
  await sleep(120);
  await mouse('mouseReleased', to.x, to.y);
  await sleep(340);
}

/**
 * @param selector CSS selector
 * @throws {Error} the element isn't on the page
 */
async function click(selector) {
  const how = await clickSelector(send, evaluate, `document.querySelector(${JSON.stringify(selector)})`, {
    sleep,
  });
  if (how === 'missing') throw new Error(`element not found: ${selector}`);
}

/**
 * Type the way a real user would: focus, then go through CDP's insertText (which
 * produces proper input events).
 *
 * @param selector CSS selector
 * @param text the text to write
 */
async function typeText(selector, text) {
  await click(selector);
  await send('Input.insertText', { text });
  await sleep(150);
}

// ---------------------------------------------------------------- Page assertion helpers

/** DOM query expressions per cell, spliced straight into evaluate. */
const DOM = {
  orderIn: (cell) =>
    `[...document.querySelectorAll('.zone[data-cell="${cell}"] .zone__list > li.card')].map(e => e.dataset.entryId)`,
  countIn: (cell) =>
    `document.querySelectorAll('.zone[data-cell="${cell}"] .zone__list > li.card').length`,
  countBadge: (cell) =>
    `document.querySelector('.zone[data-cell="${cell}"] .zone__count').textContent.trim()`,
  cards: `[...document.querySelectorAll('li.card[data-entry-id]')].map(e => e.dataset.entryId)`,
};

/**
 * Read chrome.storage.local directly to see which entries (by id) are in each cell.
 *
 * @returns cell name -> array of ids
 */
async function storedCells() {
  return evaluate(`(async () => {
    const bag = await chrome.storage.local.get('checklist');
    const cells = bag?.checklist?.cells ?? {};
    return Object.fromEntries(Object.entries(cells).map(([k, v]) => [k, v.map(e => e.id)]));
  })()`);
}

async function flush() {
  await evaluate(`window.__mc.flush()`);
  await sleep(120);
}

// ---------------------------------------------------------------- Test cases

async function openAndWaitReady() {
  await send('Page.enable');
  await send('Runtime.enable');
  // The headless default viewport is 800x600 (innerHeight≈428), shorter than the whole
  // page, so as soon as the pointer gets near the bottom dnd-kit auto-scrolls and the drop
  // point drifts along with the viewport -- that's real behavior, but the assertions need
  // geometry that holds still. Use a real window size so the checklist fits in the viewport.
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await bringToFront(send);
  await send('Page.navigate', { url: PAGE });
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    if (await evaluate(`!!window.__mc && window.__mc.state().hydrated`)) {
      // Wait for React to render the four cells
      const zones = await evaluate(`document.querySelectorAll('.zone').length`);
      if (zones === 4) {
        await warnIfHidden(evaluate);
        return true;
      }
    }
  }
  return false;
}

console.log('== M2: cards / modal / drag ==');

check('page ready (4 zones rendered)', await openAndWaitReady());

// 1) Seed three entries, all in general-internal
const seeded = await evaluate(`(async () => {
  const mc = window.__mc;
  mc.clearAll();
  await mc.flush();
  const a = mc.addEntry({ scope: 'general', source: 'internal', summary: 'Alpha', links: ['https://osu.ppy.sh/beatmapsets/1/discussion/2'] });
  const b = mc.addEntry({ scope: 'general', source: 'internal', summary: 'Bravo' });
  const c = mc.addEntry({ scope: 'general', source: 'internal', summary: 'Charlie' });
  await mc.flush();
  return { a: a.id, b: b.id, c: c.id };
})()`);
await sleep(250);

let order = await evaluate(DOM.orderIn('general-internal'));
check('three cards render in insertion order', JSON.stringify(order) === JSON.stringify([seeded.a, seeded.b, seeded.c]), JSON.stringify(order));

check('index shows as #1 #2 #3', (await evaluate(`[...document.querySelectorAll('.zone[data-cell="general-internal"] .card__index')].map(e => e.textContent).join('')`)) === '#1#2#3');
check('every card has a drag handle', (await evaluate(`document.querySelectorAll('.zone[data-cell="general-internal"] .card__handle').length`)) === 3);
check('count badge = 3', (await evaluate(DOM.countBadge('general-internal'))) === '3');

// 2) Real pointer drag: drag Alpha onto Charlie (move down within the same cell)
await dragTo(
  '.zone[data-cell="general-internal"] li.card[data-entry-id="' + seeded.a + '"] .card__handle',
  '.zone[data-cell="general-internal"] li.card[data-entry-id="' + seeded.c + '"]',
);
order = await evaluate(DOM.orderIn('general-internal'));
check(
  'same-cell drag: Alpha lands after Charlie',
  JSON.stringify(order) === JSON.stringify([seeded.b, seeded.c, seeded.a]),
  JSON.stringify(order.map((id) => ({ [seeded.a]: 'A', [seeded.b]: 'B', [seeded.c]: 'C' }[id]))),
);

await flush();
let stored = await storedCells();
check(
  'same-cell drag written to storage',
  JSON.stringify(stored['general-internal']) === JSON.stringify([seeded.b, seeded.c, seeded.a]),
  JSON.stringify(stored['general-internal']),
);

// 3) Cross-cell drag: drag Alpha into the empty area of general-external
await dragTo(
  '.zone[data-cell="general-internal"] li.card[data-entry-id="' + seeded.a + '"] .card__handle',
  '.zone[data-cell="general-external"] .zone__empty',
);
order = await evaluate(DOM.orderIn('general-internal'));
const orderExt = await evaluate(DOM.orderIn('general-external'));
check('cross-cell drag: only B/C left in the source zone', JSON.stringify(order) === JSON.stringify([seeded.b, seeded.c]), JSON.stringify(order));
check('cross-cell drag: Alpha shows up in the target zone', JSON.stringify(orderExt) === JSON.stringify([seeded.a]), JSON.stringify(orderExt));

const moved = await evaluate(`(() => {
  const cells = window.__mc.doc().cells;
  const e = cells['general-external'].find(x => x.id === ${JSON.stringify(seeded.a)});
  return e ? { scope: e.scope, source: e.source } : null;
})()`);
check('cross-cell drag rewrites scope/source too', moved?.scope === 'general' && moved?.source === 'external', JSON.stringify(moved));

stored = await storedCells();
check('cross-cell drag written to storage', JSON.stringify(stored['general-external']) === JSON.stringify([seeded.a]));

// 4) The "+" button opens the modal to add an entry
await click('.zone[data-cell="individual-external"] .zone__add');
await sleep(250);
check('modal opens', (await evaluate(`!!document.querySelector('.mc-modal')`)) === true);
check('modal preselects the zone it was opened from (Individual × External)', (await evaluate(`document.querySelectorAll('.mc-seg__opt--on')[1].textContent`)) === 'External');

await typeText('.mc-modal textarea', '新增的第四条');
await click('.mc-modal__foot .btn--accent');
await sleep(300);

const afterAdd = await evaluate(DOM.orderIn('individual-external'));
check('added successfully and filed into the right zone', afterAdd.length === 1, JSON.stringify(afterAdd));
check('modal closes after adding', (await evaluate(`!!document.querySelector('.mc-modal')`)) === false);
check('count badge updates to 1', (await evaluate(DOM.countBadge('individual-external'))) === '1');

// 5) Note: open the inline editor and save
await click('.zone[data-cell="individual-external"] .card__notebtn');
await sleep(200);
await evaluate(`(() => {
  const ta = document.querySelector('.card__noteta');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, '这是一条备注');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
})()`);
await sleep(120);
await click('.card__noteactions .btn--accent');
await sleep(300);

const note = await evaluate(`(() => {
  const cells = window.__mc.doc().cells['individual-external'];
  return cells[0]?.note ?? null;
})()`);
check('note saved into the store', note === '这是一条备注', String(note));
check('card shows the note preview', (await evaluate(`document.querySelector('.card__notepreview')?.textContent ?? ''`)) === '这是一条备注');

// 6) Delete: two-step confirmation
// The delete button is plain by default; only after the first click does it turn --danger
// and show "确认" (two steps so you don't delete by accident)
await click('.zone[data-cell="individual-external"] .card__iconbtn[aria-label="删除条目"]');
await sleep(150);
check('first click enters the confirm state', (await evaluate(`!!document.querySelector('.card__confirm')`)) === true);
await click('.zone[data-cell="individual-external"] .card__iconbtn[aria-label="确认删除"]');
await sleep(300);
check('second click actually deletes', (await evaluate(DOM.countIn('individual-external'))) === 0);

stored = await storedCells();
check('delete written to storage', (stored['individual-external'] ?? []).length === 0, JSON.stringify(stored['individual-external']));

// 7) After a reload the drag results are still there (the order is persisted data)
await openAndWaitReady();
const afterReload = {
  gi: await evaluate(DOM.orderIn('general-internal')),
  ge: await evaluate(DOM.orderIn('general-external')),
};
check(
  'order and cross-cell grouping survive a reload',
  JSON.stringify(afterReload.gi) === JSON.stringify([seeded.b, seeded.c]) &&
    JSON.stringify(afterReload.ge) === JSON.stringify([seeded.a]),
  JSON.stringify(afterReload),
);

// 8) The difficulty marker. Only Individual entries get one, and its colour rides on a theme
//    variable that fails silently -- a chip with an unresolvable `--diff` still renders, just
//    in the plain text colour -- so the colour is asserted, not only the presence.
await evaluate(`(async () => {
  const mc = window.__mc;
  mc.clearAll();
  await mc.flush();
  mc.addEntry({ scope: 'individual', source: 'external', summary: 'Tiered', difficulty: 'hard' });
  mc.addEntry({ scope: 'individual', source: 'external', summary: 'Plain' });
  mc.addEntry({ scope: 'general', source: 'internal', summary: 'General but tiered', difficulty: 'insane' });
  await mc.flush();
})()`);
await sleep(250);

check('a tiered card shows its difficulty', (await evaluate(`document.querySelector('.zone[data-cell="individual-external"] .card__diff')?.textContent.trim() ?? ''`)) === 'Hard');
check('a card without a tier shows no marker', (await evaluate(`document.querySelectorAll('.zone[data-cell="individual-external"] .card__diff').length`)) === 1);
check('a General card hides the tier it still carries', (await evaluate(`document.querySelectorAll('.zone[data-cell="general-internal"] .card__diff').length`)) === 0);
check(
  'the marker bar is painted with the tier colour',
  (await evaluate(`getComputedStyle(document.querySelector('.zone[data-cell="individual-external"] .card__diff-bar')).backgroundColor`)) === 'rgb(247, 232, 93)',
);

// 9) The picker fills the selected tier with that tier's own colour rather than the generic
//    accent. Same silent-failure shape as the marker: an unresolvable `--diff` leaves the
//    option filled with the accent instead, which still looks entirely deliberate.
await click('.zone[data-cell="individual-external"] li.card .card__iconbtn');
await sleep(350);
check(
  'the edit dialog opens with the stored tier selected',
  (await evaluate(`document.querySelector('.mc-seg__opt--diff[data-difficulty="hard"]')?.classList.contains('mc-seg__opt--on')`)) === true,
);
const fills = await evaluate(`(() => {
  const bg = (s) => { const el = document.querySelector(s); return el ? getComputedStyle(el).backgroundColor : null; };
  const tier = '.mc-seg__opt--diff[data-difficulty="hard"]';
  return { tier: bg(tier), accent: bg('.mc-seg__opt--on:not(.mc-seg__opt--diff)'), ink: bg(tier) && getComputedStyle(document.querySelector(tier)).color };
})()`);
check(
  'the selected tier is filled with its own colour, not the accent',
  fills.tier !== null && fills.tier !== 'rgba(0, 0, 0, 0)' && fills.tier !== fills.accent,
  JSON.stringify(fills),
);
check('the selected tier name is written in the dark ink', fills.ink === 'rgb(16, 21, 12)', String(fills.ink));

// Wrap up
await evaluate(`(async () => { window.__mc.clearAll(); await window.__mc.flush(); })()`);

ws.close();
console.log(failures.length === 0 ? '\nALL M2 SMOKE CHECKS PASSED' : `\nFAILURES: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);

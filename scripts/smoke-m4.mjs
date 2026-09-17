// M4 end-to-end smoke (dev only): verify the popup's four cell counts, the total, the
// empty state, and the "open the Checklist page" button.
//
// The baseline is the real content of chrome.storage.local, not UI text: first create data
// in app.html?debug=1 through the store's real API, then switch to popup.html and compare
// the DOM.
// Usage: node scripts/smoke-m4.mjs <debugPort> <extensionId>
import { bringToFront, clickSelector, warnIfHidden } from './cdp.mjs';

const [port, extId] = process.argv.slice(2);
if (!port || !extId) {
  console.error('usage: node scripts/smoke-m4.mjs <debugPort> <extensionId>');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APP = `chrome-extension://${extId}/app.html?debug=1`;
const POPUP = `chrome-extension://${extId}/popup.html`;

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

/**
 * Poll until the expression is truthy; return its last evaluation result.
 *
 * @param expression the expression to evaluate in the page
 * @param label the name shown in the timeout message
 * @param tries how many times to try at most
 * @param gap how many milliseconds to wait between tries
 */
async function waitFor(expression, label, tries = 60, gap = 100) {
  let last;
  for (let i = 0; i < tries; i++) {
    last = await evaluate(expression).catch(() => undefined);
    if (last) return last;
    await sleep(gap);
  }
  console.log(`  · wait timed out (${label}): ${expression}`);
  return last;
}

/**
 * Open an extension page and wait for its React root to attach child nodes.
 *
 * @param page the page address
 * @param readyExpr expression that says whether the page is ready
 * @returns whether it got there
 */
async function goto(page, readyExpr) {
  await bringToFront(send);
  await send('Page.navigate', { url: page });
  const ok = await waitFor(readyExpr, `loading ${page}`);
  await warnIfHidden(evaluate);
  return ok;
}

// ---------------------------------------------------------------- Test cases

console.log('== M4: popup counts ==');

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

// --- 1) Create data through the store's real API; the distribution is deliberately different in each cell
await goto(APP, `!!window.__mc && window.__mc.state().hydrated`);
await evaluate(`(async () => { window.__mc.clearAll(); await window.__mc.flush(); })()`);
await sleep(200);

const seeded = await evaluate(`(async () => {
  const add = (scope, source, n) => {
    for (let i = 0; i < n; i++) window.__mc.addEntry({ scope, source, summary: scope + '/' + source + ' #' + i });
  };
  add('general', 'internal', 1);
  add('general', 'external', 2);
  add('individual', 'internal', 0);
  add('individual', 'external', 3);
  await window.__mc.flush();
  // The baseline is the real content in storage, not an expected value written into the
  // script -- if addEntry files something into the wrong cell, this assertion should catch
  // it rather than being wrong along with it.
  const b = await chrome.storage.local.get('checklist');
  return Object.fromEntries(Object.entries(b.checklist.cells).map(([k, v]) => [k, v.length]));
})()`);
const expectedTotal = Object.values(seeded ?? {}).reduce((a, b) => a + b, 0);
console.log(`  · distribution in storage: ${JSON.stringify(seeded)} (${expectedTotal} entries total)`);

// --- 2) Open the popup and wait for hydration to finish
await goto(POPUP, `document.querySelector('.pu')?.dataset.hydrated === 'true'`);

const snap = await evaluate(`(() => {
  const cells = [...document.querySelectorAll('.pu__cell')].map((el) => ({
    cell: el.dataset.cell,
    count: el.querySelector('.pu__cell-count').textContent.trim(),
  }));
  return {
    hydrated: document.querySelector('.pu')?.dataset.hydrated,
    subtitle: document.querySelector('.pu__subtitle')?.textContent.trim() ?? null,
    cells,
    hint: document.querySelector('.pu__hint')?.textContent.trim() ?? null,
  };
})()`);
console.log(`  · popup shows: ${JSON.stringify(snap)}`);

check('popup shows as hydrated', snap?.hydrated === 'true', String(snap?.hydrated));
check(
  'four-zone order is General·Internal → General·External → Individual·Internal → Individual·External',
  JSON.stringify(snap?.cells?.map((c) => c.cell)) ===
    JSON.stringify([
      'general-internal',
      'general-external',
      'individual-internal',
      'individual-external',
    ]),
  JSON.stringify(snap?.cells?.map((c) => c.cell)),
);
// Compare cell by cell rather than string-comparing the whole thing with JSON.stringify --
// that's sensitive to key order, and the key order of cells in storage isn't guaranteed to
// match the popup's render order (that's how this first went falsely red).
const popupCounts = Object.fromEntries((snap?.cells ?? []).map((c) => [c.cell, Number(c.count)]));
const mismatched = Object.keys(seeded ?? {}).filter((k) => popupCounts[k] !== seeded[k]);
check(
  'four-zone counts match storage',
  Object.keys(popupCounts).length === 4 && mismatched.length === 0,
  `popup=${JSON.stringify(popupCounts)} storage=${JSON.stringify(seeded)}${
    mismatched.length ? ' mismatch: ' + mismatched.join(',') : ''
  }`,
);
check(
  'total is correct',
  snap?.subtitle === `共 ${expectedTotal} 条`,
  `got=${JSON.stringify(snap?.subtitle)} want="共 ${expectedTotal} 条"`,
);
check('no empty-state hint when there are entries', snap?.hint === null, JSON.stringify(snap?.hint));

// --- 3) Empty state: after clearing it should show the hint, and all four cells should be 0
await goto(APP, `!!window.__mc && window.__mc.state().hydrated`);
await evaluate(`(async () => { window.__mc.clearAll(); await window.__mc.flush(); })()`);
await sleep(200);
await goto(POPUP, `document.querySelector('.pu')?.dataset.hydrated === 'true'`);

const empty = await evaluate(`(() => ({
  subtitle: document.querySelector('.pu__subtitle')?.textContent.trim() ?? null,
  counts: [...document.querySelectorAll('.pu__cell-count')].map((e) => e.textContent.trim()),
  hint: document.querySelector('.pu__hint')?.textContent.trim() ?? null,
}))()`);
console.log(`  · empty state shows: ${JSON.stringify(empty)}`);

check('all four zones are 0 after clearing', JSON.stringify(empty?.counts) === JSON.stringify(['0', '0', '0', '0']), JSON.stringify(empty?.counts));
check('total is 0 after clearing', empty?.subtitle === '共 0 条', JSON.stringify(empty?.subtitle));
check('empty-state hint shows after clearing', !!empty?.hint && empty.hint.includes('beatmap discussion'), JSON.stringify(empty?.hint));

// --- 4) The "open the Checklist page" button
const before = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).length;
const btn = await evaluate(`(() => {
  const el = document.querySelector('.pu__open');
  if (!el) return null;
  return { text: el.textContent.trim(), disabled: el.disabled };
})()`);
if (!btn || btn.disabled) {
  check('the open button in the popup is clickable', false, JSON.stringify(btn));
} else {
  const how = await clickSelector(send, evaluate, `document.querySelector('.pu__open')`, { sleep });
  if (how === 'missing') throw new Error('element not found: .pu__open');
  await sleep(1200);

  const after = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
  const opened = after.find((t) => t.url.startsWith(`chrome-extension://${extId}/app.html`));
  check(
    'clicking the button opens the Checklist page (app.html)',
    !!opened && after.length > before,
    `${before} → ${after.length} targets, app.html=${opened ? opened.url : 'none'}`,
  );

  // Clean up: close the tab we just opened (use the HTTP endpoint, since a page session
  // can't call Target.closeTarget). Leave it open and every run strands one more app.html
  // tab.
  if (opened) {
    // The target list hands out a webSocketDebuggerUrl, and its last segment is the targetId
    const targetId = opened.webSocketDebuggerUrl.split('/').pop();
    await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`).catch(() => {});
  }
}

console.log(failures.length === 0 ? '\nALL M4 SMOKE CHECKS PASSED' : `\nFAILURES: ${failures.join(', ')}`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);

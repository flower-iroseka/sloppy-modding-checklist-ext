// Dev probe for three UI changes on the checklist page
//   1. The active tab keeps its color on hover (forces :hover with CSS.forcePseudoState, no real mouse needed)
//   2. Narrow screens collapse to a single column
//   3. Jump buttons to the right of the heading + back-to-top in the bottom right, shown only when the list is longer than one screen
//
// Usage: node scripts/probe-ui.mjs <debugPort> <extensionId>
import { clickSelector, isInteractive, warnIfHidden } from './cdp.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';

const [port, extId] = process.argv.slice(2);
if (!port || !extId) {
  console.error('usage: node scripts/probe-ui.mjs <debugPort> <extensionId>');
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
await send('DOM.enable');
await send('CSS.enable');

const APP = `chrome-extension://${extId}/app.html`;

/**
 * Navigate and wait for hydration to finish.
 *
 * Waiting for `.app` isn't enough: React renders the shell first, and `.col__heading`
 * only exists once the async `hydrate()` has run, so that's the real sign the list was
 * actually drawn. This used to be "wait for `.app` + a fixed 400ms", but with more data
 * in the profile storage reads slower, 24 cards missed that 400ms window, and the whole
 * "long list" section went red as if the feature were broken.
 *
 * @param url the page address to open
 */
async function goto(url) {
  await send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    const ready = await evaluate(
      `document.readyState === 'complete' && !!document.querySelector('.col__heading')`,
    ).catch(() => false);
    if (ready) break;
  }
  await sleep(400);
}

/**
 * Seed by writing storage directly, much faster than going through the UI.
 *
 * @param countPerCell how many entries to create per cell
 * @returns the cells that were written
 */
async function seed(countPerCell) {
  const { cells } = await evaluate(`(async () => {
    const mk = (cell, n) => Array.from({ length: n }, (_, i) => ({
      id: crypto.randomUUID(),
      scope: cell.split('-')[0],
      source: cell.split('-')[1],
      summary: cell + ' 的第 ' + (i + 1) + ' 条 —— 一段用来把卡片撑到两三行的概述文字，方便看折行。',
      links: ['https://osu.ppy.sh/community/forums/posts/10229745'],
      linkAuthors: {},
      note: '一条备注，占位用。',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }));
    const cells = {
      'general-internal': mk('general-internal', ${countPerCell}),
      'general-external': mk('general-external', ${countPerCell}),
      'individual-internal': mk('individual-internal', ${countPerCell}),
      'individual-external': mk('individual-external', ${countPerCell}),
    };
    const prev = (await chrome.storage.local.get('checklist')).checklist;
    await chrome.storage.local.set({ checklist: {
      schemaVersion: 1, updatedAt: Date.now(),
      deviceId: prev?.deviceId ?? 'probe', cells,
    }});
    return { cells };
  })()`);
  return cells;
}

/**
 * Change the viewport size; the breakpoint checks depend on it.
 *
 * @param width viewport width
 * @param height viewport height, default 900
 */
async function setViewport(width, height = 900) {
  await send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });
  await sleep(350);
}

/**
 * Save a screenshot to .probe-shots/.
 *
 * @param name file name without the extension
 */
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  mkdirSync('.probe-shots', { recursive: true });
  writeFileSync(`.probe-shots/${name}.png`, Buffer.from(data, 'base64'));
}

const cols = () =>
  evaluate(`getComputedStyle(document.querySelector('.cols')).gridTemplateColumns`);

// ---------------------------------------------------------------- Start

await goto(APP);
await send('Page.bringToFront').catch(() => {});
const hidden = await warnIfHidden(evaluate);
console.log(`  tab visible: ${!(await isInteractive(evaluate)) ? 'no (will fall back)' : 'yes'}${hidden ? '' : ''}`);

// --- Empty list: no jump buttons ---------------------------------------------
await seed(0);
await goto(APP);
await setViewport(1200);
check('empty list: no jump buttons', (await evaluate(`document.querySelectorAll('.col__jumpbtn').length`)) === 0);
check('empty list: no back-to-top button', (await evaluate(`document.querySelectorAll('.totop').length`)) === 0);

// --- Long list: buttons appear ---------------------------------------------------
await seed(6);
await goto(APP);
await setViewport(1200);

check(
  'long list: all four zones have an anchor id',
  (await evaluate(
    `['general-internal','general-external','individual-internal','individual-external']
       .every((c) => !!document.getElementById('zone-' + c))`,
  )) === true,
);
check(
  'long list: two jump buttons per column (4 in total)',
  (await evaluate(`document.querySelectorAll('.col__jumpbtn').length`)) === 4,
);
check(
  'long list: jump button text is Internal / External',
  (await evaluate(
    `[...document.querySelectorAll('.col__jumpbtn')].map((b) => b.textContent.trim()).join(',')`,
  )) === 'Internal,External,Internal,External',
);
check('long list: back-to-top button exists', (await evaluate(`!!document.querySelector('.totop')`)) === true);

// --- Single column breakpoint -----------------------------------------------------------
const wide = await cols();
check('1200px: still two columns', wide.split(' ').length === 2, wide);
await setViewport(1000);
const mid = await cols();
check('1000px: still two columns', mid.split(' ').length === 2, mid);
await setViewport(880);
const narrow = await cols();
check('880px: collapsed to a single column', narrow.split(' ').length === 1, narrow);
await shot('narrow-880');
await setViewport(1200);
await shot('wide-1200');

// --- Active tab keeps its color on hover -------------------------------------------------
const hoverProbe = await evaluate(`(() => {
  const tab = document.querySelector('.app__tab--active');
  if (!tab) return null;
  const bg = getComputedStyle(tab).backgroundColor;
  return { label: tab.textContent.trim(), rest: bg };
})()`);
check('there is an active tab', hoverProbe !== null, hoverProbe?.label);

if (hoverProbe) {
  const { root } = await send('DOM.getDocument', { depth: -1 });
  const { nodeId } = await send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '.app__tab--active',
  });
  await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
  await sleep(150);
  const hovered = await evaluate(
    `getComputedStyle(document.querySelector('.app__tab--active')).backgroundColor`,
  );
  await send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
  check(
    'active tab :hover keeps the same background color',
    hovered === hoverProbe.rest,
    `rest ${hoverProbe.rest} / hover ${hovered}`,
  );

  // Inactive tabs still need hover feedback (don't kill hover along with it)
  const { nodeId: otherId } = await send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '.app__tab:not(.app__tab--active)',
  });
  const otherRest = await evaluate(
    `getComputedStyle(document.querySelector('.app__tab:not(.app__tab--active)')).backgroundColor`,
  );
  await send('CSS.forcePseudoState', { nodeId: otherId, forcedPseudoClasses: ['hover'] });
  await sleep(150);
  const otherHover = await evaluate(
    `getComputedStyle(document.querySelector('.app__tab:not(.app__tab--active)')).backgroundColor`,
  );
  await send('CSS.forcePseudoState', { nodeId: otherId, forcedPseudoClasses: [] });
  check('inactive tab still has hover feedback', otherHover !== otherRest, `${otherRest} → ${otherHover}`);
}

// --- Jump behavior -----------------------------------------------------------
// Measure geometry in single-column mode: in two columns general-external is the last
// section of the left column, so scrolling to it already reaches the bottom of the
// document and it stops there even without scroll-margin-top -- the sticky header
// covering it can't be measured that way. In single-column mode the two individual
// sections still sit below it, which is what gives us room to scroll.
await setViewport(880);
await evaluate(`window.scrollTo(0, 0)`);
await sleep(250);
const clicked = await clickSelector(
  send, evaluate,
  `[...document.querySelectorAll('.col__jumpbtn')].find((b) => b.textContent.includes('External'))`,
  { sleep },
);
check('jump button is clickable', clicked !== 'missing', clicked);
await sleep(900);
const afterJump = await evaluate(`(() => {
  const z = document.getElementById('zone-general-external');
  return {
    scrollY: Math.round(window.scrollY),
    top: Math.round(z.getBoundingClientRect().top),
    canScrollMore: window.scrollY + window.innerHeight < document.documentElement.scrollHeight - 4,
  };
})()`);
check('the jump actually scrolled', afterJump.scrollY > 0, `scrollY=${afterJump.scrollY}`);
check('there is still content below after the jump (otherwise this geometry assertion measures nothing)', afterJump.canScrollMore === true);
// The header is sticky, so with scroll-margin-top: 68 in effect the zone top should land around 68
check(
  'the zone top is not hidden behind the sticky header after the jump',
  afterJump.top >= 50 && afterJump.top <= 90,
  `zone top = ${afterJump.top}`,
);

const topClicked = await clickSelector(send, evaluate, `document.querySelector('.totop')`, { sleep });
check('back-to-top is clickable', topClicked !== 'missing', topClicked);
await sleep(900);
const backTop = await evaluate(`Math.round(window.scrollY)`);
check('back-to-top really goes back to 0', backTop === 0, `scrollY=${backTop}`);

// --- Short list: buttons disappear ---------------------------------------------------
await setViewport(1200, 2000);
await sleep(400);
check(
  'tall viewport (list fits one screen): jump buttons disappear',
  (await evaluate(`document.querySelectorAll('.col__jumpbtn').length`)) === 0,
);
check(
  'tall viewport: back-to-top disappears',
  (await evaluate(`!!document.querySelector('.totop')`)) === false,
);
await setViewport(1200, 900);

// ---------------------------------------------------------------- Wrap up

console.log('');
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join(' / ')}`);
  ws.close();
  process.exit(1);
}
console.log('ALL PASSED');
ws.close();

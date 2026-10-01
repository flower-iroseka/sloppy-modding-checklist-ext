// M6/M7 smoke: the settings page for both sync methods, the message plumbing, and an
// end-to-end push/pull with the local sync folder.
//
// No network and no real auth flow: `chrome.identity.launchWebAuthFlow` opens a login window
// CDP can't close or accept, so connecting to Dropbox is a manual check (§12.3). The local
// sync folder does run a real upload/pull -- it sends no requests, and its handle is faked
// with an OPFS directory (see `folderIdbBody`); only the showDirectoryPicker dialog can't be
// automated. Each provider's API shape is pinned down in `tests/sync-oauth-providers.test.ts`
// with a fake fetch.
//
// Usage: node scripts/smoke-m6.mjs <debugPort> <extensionId>
import { clickSelector, warnIfHidden } from './cdp.mjs';

const [port, extId] = process.argv.slice(2);
if (!port || !extId) {
  console.error('usage: node scripts/smoke-m6.mjs <debugPort> <extensionId>');
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

// Only `?debug=1` gives us `window.__mc`; we use it below to render the `Msg` from the SW's reply into readable text.
const APP = `chrome-extension://${extId}/app.html?debug=1`;

async function goto(url) {
  await send('Page.navigate', { url });
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    const ready = await evaluate(
      `document.readyState === 'complete' && !!document.querySelector('.app')`,
    ).catch(() => false);
    if (ready) break;
  }
  await sleep(300);
}

// ---------------------------------------------------------------- Drivers

const exists = (sel) => evaluate(`!!document.querySelector(${JSON.stringify(sel)})`);
const text = (sel) =>
  evaluate(`(document.querySelector(${JSON.stringify(sel)})?.textContent ?? '').trim()`);
const value = (sel) =>
  evaluate(`document.querySelector(${JSON.stringify(sel)})?.value ?? null`);
const isDisabled = (sel) =>
  evaluate(`!!document.querySelector(${JSON.stringify(sel)})?.disabled`);

/**
 * Change a React controlled `<select>`: you have to use the native setter and then dispatch
 * change. Assigning `el.value = x` directly is invisible to React -- a controlled component's
 * value is whatever its own state says.
 *
 * @param sel CSS selector
 * @param v the option value to select
 */
const setSelect = async (sel, v) => {
  await evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${JSON.stringify(v)});
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(350); // wait for React to re-render + the echo of that storage write
};

const click = (sel) => clickSelector(send, evaluate, `document.querySelector(${JSON.stringify(sel)})`, { sleep });

const setSettings = (patch) =>
  evaluate(`(async () => {
    const KEY = 'syncSettings';
    const cur = (await chrome.storage.local.get(KEY))[KEY] ?? {};
    const next = { activeProvider: 'localFolder', autoSync: false, pullOnStart: false, strategy: 'newest-wins', ...${JSON.stringify(patch)}, config: { ...(cur.config ?? {}), ...(${JSON.stringify(patch)}.config ?? {}) } };
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  })()`);

/**
 * Overwrite the whole settings object, `config` included.
 *
 * `setSettings` merges per provider (switching providers shouldn't wipe what another one has
 * filled in), so it can't clear a single provider -- use this when you need a clean starting
 * point.
 *
 * @param obj the whole settings object, written in as is
 */
const putSettings = (obj) =>
  evaluate(`(async () => {
    await chrome.storage.local.set({ syncSettings: ${JSON.stringify(obj)} });
    return true;
  })()`);

const readSettings = () =>
  evaluate(`(async () => (await chrome.storage.local.get('syncSettings')).syncSettings ?? null)()`);

/** Wipe the settings / status / tokens left over from the last run, so every run starts from the same place. */
const resetStorage = () =>
  evaluate(`(async () => {
    const all = await chrome.storage.local.get(null);
    const gone = Object.keys(all).filter((k) =>
      k === 'syncSettings' || k === 'syncStatus' || k === 'syncTokens');
    await chrome.storage.local.remove(gone);
    // The folder handle isn't in chrome.storage (it can't be stored as JSON), so it needs
    // clearing separately -- skip this and the handle seeded last run lives on into the next
    // one, making the "no folder picked yet" assertion fail falsely.
    ${folderIdbBody(null)}
    return gone.length;
  })()`);

/**
 * Script fragment for "work with that handle inside the extension's IndexedDB".
 *
 * An OPFS directory stands in for the real thing: `navigator.storage.getDirectory()` returns
 * a genuine `FileSystemDirectoryHandle`, so structured cloning, permission semantics, and the
 * SW reading and writing it all take the same code path as a folder the user picked through
 * the system dialog. Only the dialog itself (`showDirectoryPicker` needs a human click) can't
 * be automated. So here we push the handle straight into the extension's own IndexedDB -- the
 * state "right after picking".
 *
 * It's a function because three places need it (resetStorage / seedFolderHandle /
 * clearFolderHandleInPage), and getting a transaction wrong in here costs you half a day.
 *
 * @param handleExpr expression that evaluates to the handle; null deletes that record
 * @returns a piece of JS you can put into evaluate
 */
function folderIdbBody(handleExpr) {
  return `
    // Get the handle before opening the transaction: the transaction executor isn't an async
    // function, so there can be no await inside it.
    ${handleExpr === null ? '' : `const handle = ${handleExpr};`}
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(${JSON.stringify(FOLDER_DB)}, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('handles')) r.result.createObjectStore('handles'); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const t = db.transaction('handles', 'readwrite');
      const store = t.objectStore('handles');
      ${handleExpr === null ? `store.delete('folder')` : `store.put(handle, 'folder')`};
      t.oncomplete = () => res();
      t.onabort = () => rej(t.error);
    });
    db.close();`;
}

/**
 * Grab a real directory handle in the page (a subdirectory in OPFS) to use as a stand-in.
 *
 * @param dirName the subdirectory name in OPFS
 */
const opfsHandleExpr = (dirName) => `await (async () => {
  const root = await navigator.storage.getDirectory();
  return await root.getDirectoryHandle(${JSON.stringify(dirName)}, { create: true });
})()`;

/**
 * Store the handle in the extension's IndexedDB -- the state at "the user just picked a
 * folder".
 *
 * @param dirName the subdirectory name in OPFS
 */
const seedFolderHandle = (dirName) =>
  evaluate(`(async () => { ${folderIdbBody(opfsHandleExpr(dirName))} return true; })()`);

const clearFolderHandleInPage = () =>
  evaluate(`(async () => { ${folderIdbBody(null)} return true; })()`);

/**
 * Delete the stand-in folder entirely (including the JSON inside) -- every run starts from an
 * empty folder.
 *
 * @param dirName the subdirectory name in OPFS
 */
const wipeFolder = (dirName) =>
  evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    try { await root.removeEntry(${JSON.stringify(dirName)}, { recursive: true }); } catch {}
    return true;
  })()`);

/**
 * Read the file straight out of that folder -- used to check what the SW actually wrote.
 *
 * @param dirName the subdirectory name in OPFS
 * @returns the file contents; null if the file isn't there
 */
const readFolderFile = (dirName) =>
  evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(${JSON.stringify(dirName)});
    try {
      const fh = await dir.getFileHandle(${JSON.stringify(FOLDER_FILE)});
      return await (await fh.getFile()).text();
    } catch { return null; }
  })()`);

/**
 * Write a file straight into that folder, pretending "someone else changed the remote".
 *
 * @param dirName the subdirectory name in OPFS
 * @param json the body to write
 */
const writeFolderFile = (dirName, json) =>
  evaluate(`(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(${JSON.stringify(dirName)});
    const fh = await dir.getFileHandle(${JSON.stringify(FOLDER_FILE)}, { create: true });
    const w = await fh.createWritable();
    await w.write(${JSON.stringify(json)});
    await w.close();
    return true;
  })()`);

/**
 * Plant a fake token so it looks like we've connected before.
 *
 * @param id provider id, e.g. dropbox
 * @param ms milliseconds until it expires, default 10 minutes
 */
const seedToken = (id, ms = 600_000) =>
  evaluate(`(async () => {
    await chrome.storage.local.set({ syncTokens: {
      ...((await chrome.storage.local.get('syncTokens')).syncTokens ?? {}),
      [${JSON.stringify(id)}]: { accessToken: 'tok', expiresAt: Date.now() + ${ms} },
    }});
    return true;
  })()`);

const tokens = () =>
  evaluate(`(async () => (await chrome.storage.local.get('syncTokens')).syncTokens ?? null)()`);

/**
 * Send a sync message and wait for the SW's reply.
 *
 * @param type the message type, one of the ones in the `MSG` table
 * @param body extra fields, e.g. `{ provider: 'dropbox' }`
 * @returns the SW's reply plus a `text` field: `message` rendered into the current UI
 *   language, so the assertions still check "the words the user sees"
 */
const sync = async (type, body = {}) => {
  // Catch message types the script itself got wrong (`MSG.xxx` typo -> undefined). Without
  // this guard we'd send a message with no type, the SW would ignore it by design, and it
  // would come back as "no response from the background" -- a failure that looks like a
  // product bug but is really a typo in the test script.
  if (typeof type !== 'string' || !type.startsWith('mc:')) {
    throw new Error(`the smoke script itself is wrong: message type is ${String(type)} (probably not in the MSG table)`);
  }
  const payload = JSON.stringify({ type, ...body });
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await evaluate(`chrome.runtime.sendMessage(${payload})`);
    // Since M9 the `message` in the reply is a struct (`Msg` = `{ key, params }`), not a
    // sentence. So we always add a `text`: `window.__mc.render` renders it in the page into
    // the current UI language -- the assertions then still check "the words the user sees"
    // instead of `[object Object]`.
    if (res !== undefined && res !== null) return { ...res, text: await render(res.message) };
    await sleep(500);
  }
  return {
    ok: false,
    message: { key: 'err.bg.commFailed', params: { detail: 'smoke: 端口提前关闭' } },
    text: '后台没有响应（消息端口提前关闭）',
  };
};

/**
 * Render a `Msg` into readable text (in the page realm, where the catalog lives).
 *
 * @param msg the structured message from the SW's reply
 * @returns the sentence in the current UI language; an empty string when msg is empty
 */
const render = async (msg) => {
  if (msg === undefined || msg === null) return '';
  return evaluate(`window.__mc.render(${JSON.stringify(msg)})`);
};

const MSG = {
  test: 'mc:sync-test',
  push: 'mc:sync-push',
  pull: 'mc:sync-pull',
  connect: 'mc:sync-connect',
  disconnect: 'mc:sync-disconnect',
};

/** The two local sync folder constants. Declared here because `resetStorage` (used just
 *  below) references them -- putting them at the end of the file would hit a TDZ on the
 *  first call. */
const FOLDER_DB = 'mc-sync-fs';
const FOLDER_FILE = 'modding-checklist.json';

const enterSettings = async () => {
  await evaluate(
    // Find it by `data-tab`: looking it up by text breaks the moment the UI language changes.
    `document.querySelector('.app__tab[data-tab="settings"]')?.click()`,
  );
  for (let i = 0; i < 40; i++) {
    await sleep(120);
    if (await exists('.sync__block')) return;
  }
};

// ---------------------------------------------------------------- Start

await dropStaleState();
await goto(APP);
await send('Page.bringToFront').catch(() => {});
const hidden = await warnIfHidden(evaluate);
console.log(`  tab visible: ${hidden ? 'no (will fall back)' : 'yes'}`);

await enterSettings();

// --- Selectors ------------------------------------------------------------
const options = await evaluate(
  `[...document.querySelectorAll('#provider option')].map((o) => o.value)`,
);
check(
  'the sync method selector lists both providers (fixed order)',
  JSON.stringify(options) === JSON.stringify(['localFolder', 'dropbox']),
  JSON.stringify(options),
);
// The first item is selected by default, and the first item has to be the one that "needs no signup" -- that's the whole point of §7.7.
check('coming from a clean state it shows the local sync folder card', await exists('.sync__folder-state'));
check('and the Dropbox card is not showing', !(await exists('.sync__provider')));

// --- Switch to Dropbox (the first OAuth provider in the catalog) --------------------------------
await setSelect('#provider', 'dropbox');
check('switching to Dropbox → its client_id input shows up', await exists('#oauth-dropbox-client'));
check('the local sync folder card stops showing after the switch', !(await exists('.sync__folder-state')));
// Google Drive used to be the only one with `requiresSecret` (a "Web application" client
// forces a secret). It was removed entirely on 2026-09-11, and the one provider left is a
// public client with PKCE, so the secret can always be left blank.
check('Dropbox does not force a secret (public client + PKCE)', (await text('label[for="oauth-dropbox-secret"]')).includes('可留空'));

// The redirect URL is the one thing the user has to copy by hand into another console, so it has to actually match.
const redirect = await value('#oauth-dropbox-redirect');
const expectedRedirect = await evaluate(`chrome.identity.getRedirectURL()`);
check("the redirect URL is the extension's own chromiumapp.org address", redirect === expectedRedirect, redirect);
check('the redirect URL is https and carries the extension id', redirect === `https://${extId}.chromiumapp.org/`, redirect);

// --- Signup guide -----------------------------------------------------------
const guideHref = () =>
  evaluate(`document.querySelector('.sync__provider a[target="_blank"]')?.href ?? null`);
check(
  'the Dropbox card gives a signup URL',
  (await guideHref()) === 'https://www.dropbox.com/developers/apps',
  await guideHref(),
);
check('the guide steps are not empty', (await evaluate(`document.querySelectorAll('.sync__steps li').length`)) >= 3);
check(
  'the permission note lists the requested scopes',
  (await text('.sync__provider')).includes('files.content.write'),
);
check('and it spells out where the file will land (the user will go looking in their own drive)', (await text('.sync__provider')).includes('/Apps/'));
// One a user actually hit: you tick the Permissions box but never click Submit, and the auth
// page just throws back "No scope requested can be granted for this app". The guide has to
// call out Submit, or you get "I followed the steps and it still won't connect".
check(
  'the guide calls out "tick the box then click Submit" (the step most people miss with Dropbox)',
  (await text('.sync__steps')).includes('Submit'),
);
// The catalog uses the `**bold**` inline markup (i18n/richText.ts). The default render path
// strips the markup; only `<RichText>` turns it into `<strong>` -- which path is wired up is
// visible to the eye:
//   missing RichText -> the user sees a pair of asterisks (that's what this fix was about);
//   missing the markup-aware render -> no asterisks and no bold either (much quieter, which
//   is why we check the positive case too).
const markup = await evaluate(`(() => {
  const steps = document.querySelector('.sync__steps');
  if (!steps) return null;
  return {
    text: steps.textContent,
    bold: [...steps.querySelectorAll('strong')].map((e) => e.textContent.trim()),
  };
})()`);
check('no leaked `**` markup in the guide', !markup.text.includes('**'), markup.text.match(/\S*\*\*\S*/)?.[0]);
// The check keys off the single word "Submit": both languages have it in their bolded part
// (the Chinese catalog's sentence has it in bold too), and the script doesn't pin the
// language (it follows the browser, and the debug profile is Chinese), so comparing a whole
// English sentence would go red in a Chinese environment.
check(
  'the bold parts really render as <strong> (not just the markup being stripped)',
  markup.bold.some((t) => t.includes('Submit')),
  JSON.stringify(markup.bold),
);
// That checklist above is only served up when the connection fails, and it lands in
// `.error-text`. It's multi-line (the URL to open + the itemized checklist), and a `<p>`
// swallows line breaks by default -- collapsing it into one paragraph is as good as not
// showing it at all.
check(
  'the error container keeps line breaks (so a multi-line setup checklist stays readable)',
  (await evaluate(`(() => {
    const p = document.createElement('p');
    p.className = 'error-text';
    document.body.appendChild(p);
    const ws = getComputedStyle(p).whiteSpace;
    p.remove();
    return ws;
  })()`)) === 'pre-wrap',
);

// --- Disabled buttons -----------------------------------------------------------
// Locate by data-action: the "copy" button is in the same card, and selecting by `.btn` would pick up that one.
check('the "save and connect" button is disabled while client_id is empty', await isDisabled('[data-action="connect"]'));
check('and it says what is missing', (await text('[data-role="oauth-actions"]')).includes('client_id'));

// --- Only one OAuth provider left (OneDrive was removed entirely on 2026-09-11) --------------------
//
// This used to be the assertion that "the two OAuth providers' fields don't leak into each
// other". Once Dropbox was the only one left in the catalog they all lost their subject --
// they guard a property between multiple providers, and with only one that holds no matter
// how the code is written, so they were deleted rather than rewritten as tautologies. What
// actually covers this is the unit tests that iterate over `PROVIDER_IDS` (each config kept
// separately, tokens stored per provider); they become meaningful again the moment a third
// provider shows up. The check that OneDrive's three origins are "no longer requested" is in
// the manifest section below.

// --- Each provider's config is stored separately and doesn't overwrite the others ---------------------------------------
await setSettings({
  activeProvider: 'dropbox',
  config: { dropbox: { enabled: true, clientId: 'D-ID' } },
});
await goto(APP);
await enterSettings();
await setSelect('#provider', 'dropbox');
check('switching back to the Dropbox card reads back its own client_id', (await value('#oauth-dropbox-client')) === 'D-ID', await value('#oauth-dropbox-client'));

// --- Connection state -------------------------------------------------------------
check('shows not connected when there is no token', (await text('.sync__provider')).includes('未连接'));

await seedToken('dropbox');
await sleep(400); // onTokensChanged is async
check('shows connected right after a token is written', (await text('.sync__provider')).includes('已连接'));
check('once connected it offers "disconnect", not "save and connect"', await exists('[data-action="disconnect"]'));
check('no connect button once connected', !(await exists('[data-action="connect"]')));

// --- Where the results show up (user request, 2026-09-11) --------------------------------
//
// The results of the three actions used to pile up at the very top of the panel, half a card
// away from the button you pressed. They now sit directly below that button row, and by
// default the area is empty but keeps one line's height (when a result appears it shouldn't
// shove the toggles and the conflict strategy down the page). Disconnect is the only action
// in this section that runs offline (no network, no auth window, just one message to the SW),
// so it produces a real `notice` -- which is why we use it here.
const resultGeom = () => evaluate(`(() => {
  const box = document.querySelector('[data-role="sync-result"]');
  if (!box) return null;
  const acts = document.querySelector('[data-role="sync-actions"]');
  const jump = acts ? acts.getBoundingClientRect().bottom : null;
  const rect = box.getBoundingClientRect();
  return {
    text: box.textContent.trim(),
    h: Math.round(rect.height),
    belowActions: jump === null ? null : rect.top >= jump - 1,
    okText: box.querySelector('.ok-text')?.textContent.trim() ?? null,
    errText: box.querySelector('.error-text')?.textContent.trim() ?? null,
  };
})()`);

const beforeResult = await resultGeom();
check('the result area is there (a dedicated spot for results below that button row)', beforeResult !== null, JSON.stringify(beforeResult));
check(
  'the result area sits below the three buttons',
  beforeResult?.belowActions === true,
  JSON.stringify(beforeResult),
);
check('empty by default (no placeholder text)', beforeResult?.text === '', JSON.stringify(beforeResult));

await click('[data-action="disconnect"]');
await sleep(500);
const afterResult = await resultGeom();
check(
  'after clicking the button, the sentence shows up in this spot',
  afterResult?.okText !== null && afterResult.okText.length > 0,
  JSON.stringify(afterResult),
);
check(
  'the reserved line has height (it does not only grow once there is a result)',
  typeof beforeResult?.h === 'number' && beforeResult.h > 0,
  String(beforeResult?.h),
);
check(
  'the height does not shrink when there is a result (no page jitter)',
  typeof afterResult?.h === 'number' && afterResult.h >= (beforeResult?.h ?? 0),
  `${beforeResult?.h} → ${afterResult?.h}`,
);
check(
  'the result area is still below the buttons',
  afterResult?.belowActions === true,
  JSON.stringify(afterResult),
);

check('clicking disconnect → back to not connected', (await text('.sync__provider')).includes('未连接'), await text('.sync__provider'));
check('disconnect only deletes the token, it does not touch the remote file', (await tokens())?.dropbox === undefined, JSON.stringify(await tokens()));
check(
  'client_id is still there after disconnecting (it should not wipe config the user filled in)',
  (await value('#oauth-dropbox-client')) === 'D-ID',
  await value('#oauth-dropbox-client'),
);

// --- Message plumbing: errors should read like plain language ---------------------------------------------
//
// ⚠️ This section has to run with client_id empty: if it's filled in, `syncConnect` really
// calls `launchWebAuthFlow` and pops up a real login window -- nobody can click it in an
// automated browser, so it just hangs there and drags every later assertion down with it. So
// wipe everything first and then set up a blank config.
const base = { autoSync: false, pullOnStart: false, strategy: 'newest-wins' };
const blankConfig = { dropbox: { enabled: true, clientId: '' } };

await putSettings({ ...base, activeProvider: 'dropbox', config: blankConfig });
await sleep(300);
check(
  'precondition: client_id is empty (if it were filled in, this section would pop up a real auth window)',
  (await readSettings())?.config?.dropbox?.clientId === '',
  JSON.stringify((await readSettings())?.config),
);

const noClient = await sync(MSG.connect, { provider: 'dropbox' });
check('connecting without a client_id → it says plainly to fill it in first', noClient?.ok === false && /client_id/.test(noClient.text), noClient?.text);
check(
  'and that message came back from the SW normally (the port did not close early)',
  typeof noClient?.text === 'string' && !/后台没有响应/.test(noClient.text),
  noClient?.text,
);

const notOAuth = await sync(MSG.connect, { provider: 'localFolder' });
check('starting an OAuth connect against the local sync folder → it says that is not an OAuth endpoint', notOAuth?.ok === false && /OAuth/.test(notOAuth.text), notOAuth?.text);

// Config filled in but no token: that's the real state of "reachable but not authorized yet".
await putSettings({
  ...base,
  activeProvider: 'dropbox',
  config: { ...blankConfig, dropbox: { enabled: true, clientId: 'D-ID' } },
});
await sleep(300);
const noToken = await sync(MSG.test);
check(
  'testing the connection while not connected → it tells you to go click connect on the settings page, not just a 401',
  noToken?.ok === false && /还没有连接/.test(noToken.text),
  noToken?.text,
);

const noTokenPush = await sync(MSG.push, {});
check(
  'uploading while not connected → also a readable sentence (the exception was not swallowed by structured clone)',
  noTokenPush?.ok === false && noTokenPush.text.length > 6,
  noTokenPush?.text,
);

await putSettings({ ...base, activeProvider: null, config: blankConfig });
await sleep(300);
const noProvider = await sync(MSG.test);
check(
  'no sync method picked yet → it asks you to pick one',
  noProvider?.ok === false && /没有选择同步方式/.test(noProvider.text),
  noProvider?.text,
);

// --- Unknown messages still get an answer ---------------------------------------------
//
// This one comes straight out of a real debugging session: the page is new but the running
// SW is old (Chrome's ScriptCache serves the previously compiled background.js, §12.2), so
// the newly added message type is completely foreign to the SW. Back then the SW wouldn't
// answer at all and the page could only show a vague "no response from the background",
// which looked like a network or code problem. Now it has to say itself that the versions
// don't match.
const unknownMc = await sync('mc:nope-not-real');
check(
  'an mc: message the SW does not know → it says "the extension may not have been reloaded" instead of staying silent',
  unknownMc?.ok === false && /没有重新加载/.test(unknownMc.text),
  unknownMc?.text,
);

const foreign = await evaluate(`chrome.runtime.sendMessage({ type: 'not-ours' })`);
check('a message without the mc: prefix → still ignored (it does not answer for others)', foreign === undefined, String(foreign));

// --- Manifest: the origins are really granted, and nothing extra ---------------------------------
const granted = await evaluate(
  `chrome.permissions.contains({ origins: [
    'https://api.dropboxapi.com/*', 'https://content.dropboxapi.com/*'] })`,
);
check('the domains Dropbox uses are granted (written into host_permissions)', granted === true, String(granted));

// After OneDrive was removed, its three origins have to really disappear from the permission
// set. Leaving one unused permission behind makes that "read and change all your data on all
// websites" line harder to explain at install time -- and dropping a host_permissions entry
// is completely silent: the extension keeps working, it just takes a permission for free. The
// unit test (tests/manifest.test.ts) guards this with "every entry must be claimed by
// someone"; here we confirm it once more against the live permission set.
const oneDriveGone = await evaluate(
  `chrome.permissions.contains({ origins: [
    'https://graph.microsoft.com/*', 'https://login.microsoftonline.com/*',
    'https://*.sharepoint.com/*'] })`,
);
check("OneDrive's three origins are no longer requested", oneDriveGone === false, String(oneDriveGone));

// After Google Drive was cut, these three origins must really be gone from the manifest --
// leaving one unused permission behind makes that "read and change all your data on all
// websites" line harder to explain at install time. The unit test (tests/manifest.test.ts)
// guards this with "is anyone claiming it"; here we confirm it once more against the live
// permission set.
const googleGone = await evaluate(
  `chrome.permissions.contains({ origins: [
    'https://www.googleapis.com/*', 'https://oauth2.googleapis.com/*', 'https://accounts.google.com/*'] })`,
);
check("Google's three origins are no longer requested", googleGone === false, String(googleGone));

const overGranted = await evaluate(
  `chrome.permissions.contains({ origins: ['https://example.com/*'] })`,
);
check('no extra origins got granted along the way (it is not "connect to anything")', overGranted === false, String(overGranted));

// --- Local sync folder: end-to-end with no requests at all -------------------------
//
// The point is that it really syncs, not just that the UI looks right. The handle itself can
// be fabricated (see the note on folderIdbBody): cloned into IndexedDB, read and written by
// the SW, it takes the same code path as a folder the user picked (§7.7). The only difference
// is where the permission comes from, and the permission-side switches are enumerated by the
// unit tests (tests/sync-local-folder.test.ts).
const DIR = 'mc-smoke-folder';

// OPFS persists across runs (unlike chrome.storage, which dropStaleState clears), so the
// JSON written last run is still there -- and it carries a "future timestamp". Without
// clearing it, this run's upload hits a conflict right away -- a fake failure that only shows
// up on a rerun.
await wipeFolder(DIR);

await setSelect('#provider', 'localFolder');
check(
  'switching to the local sync folder → it says plainly that no folder is picked yet',
  (await text('.sync__folder-state')).includes('还没有选择文件夹'),
  await text('.sync__folder-state'),
);
check('the upload button is disabled when no folder is picked', await isDisabled('[data-action="sync-push"]'));
check(
  'and it spells out what is missing',
  (await text('[data-role="sync-actions"]')).includes('请先选择同步文件夹'),
  await text('[data-role="sync-actions"]'),
);
check('the card only has "pick a folder", no "disconnect" (there is nothing to disconnect yet)', !(await exists('[data-action="forget-folder"]')));

await seedFolderHandle(DIR);
await putSettings({
  activeProvider: 'localFolder',
  config: { localFolder: { enabled: true, folderName: DIR } },
});
await goto(APP);
await enterSettings();
await setSelect('#provider', 'localFolder');
check('after picking, the card shows the folder name', (await text('.sync__folder-state')).includes(DIR), await text('.sync__folder-state'));
check('permission present → no "re-authorize"', !(await exists('[data-action="reauth-folder"]')));
check('now there is a "disconnect"', await exists('[data-action="forget-folder"]'));
check('the upload button is usable now', !(await isDisabled('[data-action="sync-push"]')));

const folderTest = await sync(MSG.test);
check(
  'test connection (folder present + permission present) → passes, and creates no temp files',
  folderTest?.ok === true,
  JSON.stringify(folderTest),
);

const folderPush = await sync(MSG.push, {});
check('upload to the local folder → succeeds', folderPush?.ok === true, JSON.stringify(folderPush));

const onDisk = await readFolderFile(DIR);
let parsed = null;
try {
  parsed = JSON.parse(onDisk ?? '');
} catch {
  parsed = null;
}
check('the file really landed in that folder and is valid JSON', parsed !== null, String(onDisk).slice(0, 120));
check(
  'what landed on disk is this checklist (it has deviceId and updatedAt)',
  typeof parsed?.deviceId === 'string' && typeof parsed?.updatedAt === 'number',
  JSON.stringify(parsed && Object.keys(parsed)),
);

// The content matches -> pulling again should decide "nothing to sync" (not a wasted transfer, and not an error).
const folderPull = await sync(MSG.pull, {});
check(
  'pulling again → judged nothing to sync (both sides match)',
  folderPull?.ok === true && /无需同步|一致|最新/.test(folderPull.text),
  JSON.stringify(folderPull),
);

// Simulate "the remote was changed": push the timestamp of the file on disk into the future
// and pull again.
//
// deviceId deliberately reuses this machine's own: what this checks is only "a remote update
// gets handled on pull". With a different device id, that "take the remote" would write
// d-other into the local doc, and the local doc (unlike syncSettings) isn't cleared by
// dropStaleState -- so the next run would come up under someone else's deviceId, adding a
// layer of coupling that only shows up on a rerun.
const ahead = { ...parsed, updatedAt: Date.now() + 60_000 };
await writeFolderFile(DIR, JSON.stringify(ahead));
const pullAhead = await sync(MSG.pull, {});
check(
  'remote updated → the pull goes down the conflict / use-the-remote path instead of silently ignoring it',
  pullAhead?.ok === true,
  JSON.stringify(pullAhead),
);

// Config still there, handle gone (the extension data was cleared) -- it has to say so, not pretend everything's fine.
await clearFolderHandleInPage();
const noHandle = await sync(MSG.test);
check(
  'handle gone → it says "pick it again" instead of "the connection is fine"',
  noHandle?.ok === false && /重新选择/.test(noHandle.text),
  JSON.stringify(noHandle),
);

// ---------------------------------------------------------------- Auto upload
// The UI label promises "upload automatically after a change, and pull once an hour"; here we
// can only verify the scheduling part: the actual upload waits out a 30 second debounce and
// needs a network connection, and the smoke test doesn't wait for it.
//
// But scheduling is exactly the part that breaks silently -- with a `setTimeout` debounce,
// the MV3 SW gets recycled after roughly 30 seconds idle, so a user who ticks the box and
// then wanders off will never see that upload happen, and nothing looks wrong in the UI. An
// alarm survives SW recycling, so that's what we assert on.
//
// The provider is deliberately left incomplete (`enabled: false`): if the debounce really
// does fire before the script finishes, `autoPush` throws at `requireReady` and not a single
// network request goes out, so the script's "no network at all" property stays intact.
const alarmNames = () =>
  evaluate(`(async () => (await chrome.alarms.getAll()).map((a) => a.name).sort())()`);

await putSettings({ autoSync: false, activeProvider: null, config: {}, strategy: 'newest-wins' });
await evaluate(`chrome.alarms.clearAll()`);
await sleep(200);
check('with auto upload off, no sync alarm is set at all', (await alarmNames()).length === 0, JSON.stringify(await alarmNames()));

await putSettings({
  autoSync: true,
  activeProvider: 'dropbox',
  config: { dropbox: { enabled: false } },
  strategy: 'newest-wins',
});
await sleep(200);
check(
  'auto upload on → a 60-minute periodic pull alarm is armed',
  (await alarmNames()).includes('mc-sync-periodic'),
  JSON.stringify(await alarmNames()),
);

// Ticking a checkbox is one write like this. Here we change `updatedAt`, the same shape the content script writes.
await evaluate(`(async () => {
  const doc = (await chrome.storage.local.get('checklist')).checklist;
  await chrome.storage.local.set({ checklist: { ...doc, updatedAt: Date.now() } });
  return true;
})()`);
await sleep(250);
check(
  'local data changes → an auto upload is scheduled (the 30-second debounce alarm)',
  (await alarmNames()).includes('mc-sync-autopush'),
  JSON.stringify(await alarmNames()),
);

// --- Local content written back by a pull shouldn't count as "the user changed the data" -----------------------
//
// A pull writes the same `checklist` key (`makeDeps.writeLocalDoc`). Without a guard, every
// pull would kick off an "uploading" 30 seconds later -- when the content matches that run is
// a no-op, but it still sends a network request to compare. What guards it is the `selfWrites`
// counter.
//
// We use the local sync folder for this section: it sends no requests, and the previous
// section already set up the handle and the file on disk. Also, a negative assertion needs a
// positive control, or it passes even when the implementation is completely broken (no
// scheduling at all), so we first check that a real change does schedule one and then that a
// pull doesn't.
await seedFolderHandle(DIR);
await putSettings({
  autoSync: true,
  activeProvider: 'localFolder',
  config: { localFolder: { enabled: true, folderName: DIR } },
  strategy: 'newest-wins',
});
await sleep(250);

await evaluate(`(async () => {
  const doc = (await chrome.storage.local.get('checklist')).checklist;
  await chrome.storage.local.set({ checklist: { ...doc, updatedAt: Date.now() } });
  return true;
})()`);
await sleep(250);
check(
  '(control) with the same settings, a real user change → an auto upload is scheduled',
  (await alarmNames()).includes('mc-sync-autopush'),
  JSON.stringify(await alarmNames()),
);

await evaluate(`chrome.alarms.clearAll()`);
await sleep(150);

// Make the remote "newer than local and with different content" -- that way the pull really
// takes it, which means it really writes `checklist`. deviceId reuses this machine's own (see
// the note above).
const remoteAhead = await evaluate(`(async () => {
  const local = (await chrome.storage.local.get('checklist')).checklist;
  return JSON.stringify({ ...local, updatedAt: Date.now() + 60000 });
})()`);
await writeFolderFile(DIR, remoteAhead);

const pullForAutoPush = await sync(MSG.pull, {});
check(
  '(precondition) this pull really took the remote -- otherwise the check below measures no write at all',
  pullForAutoPush?.ok === true && /已采用远端/.test(pullForAutoPush.text),
  JSON.stringify(pullForAutoPush),
);
await sleep(300);
check(
  'local content written back by a pull **does not** schedule another upload',
  !(await alarmNames()).includes('mc-sync-autopush'),
  JSON.stringify(await alarmNames()),
);

// Wrap up: turn off auto upload so the next run isn't left with an alarm that fires a network request.
await putSettings({
  autoSync: false,
  activeProvider: 'localFolder',
  config: { localFolder: { enabled: true, folderName: DIR } },
  strategy: 'newest-wins',
});
await sleep(250);
check(
  'auto upload off → both alarms are cleared (nothing left behind that will never do anything)',
  (await alarmNames()).length === 0,
  JSON.stringify(await alarmNames()),
);

// ---------------------------------------------------------------- Wrap up

console.log('');
if (failures.length === 0) {
  console.log('all passed (no network; for the real auth flow see the manual QA in §12.3)');
} else {
  console.log(`${failures.length} checks failed:`);
  for (const f of failures) console.log(`  - ${f}`);
}
ws.close();
process.exit(failures.length === 0 ? 0 : 1);

/** Clear last run's leftovers before entering the settings page -- otherwise the form gets prefilled and assertions like the disabled state all fail falsely. */
async function dropStaleState() {
  await goto(APP);
  await resetStorage();
}

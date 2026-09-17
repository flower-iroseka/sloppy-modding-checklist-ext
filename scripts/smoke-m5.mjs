// M5 sync smoke: run the whole sync flow (test connection / upload / pull / conflict /
// backup / alarm) against a fake WebDAV server started below -- a minimal node:http one that
// only knows PROPFIND / GET / PUT / OPTIONS. It answers CORS preflights so the "request
// permission" system dialog (which CDP can't click) never comes up; the price is that
// `chrome.permissions.request` is only checked by the button's presence and disabled state.
// Deliberate, not a missed test.
//
// Usage: node scripts/smoke-m5.mjs <debugPort> <extensionId>
import { createServer } from 'node:http';
import { isInteractive, warnIfHidden } from './cdp.mjs';

const [port, extId] = process.argv.slice(2);
if (!port || !extId) {
  console.error('usage: node scripts/smoke-m5.mjs <debugPort> <extensionId>');
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

// ---------------------------------------------------------------- Fake WebDAV

const USER = 'u';
const PASS = 'pw';
const DAV_PATH = '/dav';
const FILE_URL_PATH = `${DAV_PATH}/modding-checklist.json`;
const XML = '<?xml version="1.0"?><multistatus xmlns="DAV:"/>';

/**
 * Start a minimal fake WebDAV.
 *
 * @returns `{ state, server, port }` -- the request log, the http server, and the port it
 *   landed on (listen(0) picks a free one)
 */
function startFakeDav() {
  const state = {
    /** the remote file's raw text; null = not created yet */
    file: null,
    /** a Last-Modified stamped on every write */
    lastModified: new Date().toUTCString(),
    /** every request we received */
    calls: [],
    /** just the PUTs, used to count "did it actually upload" */
    get puts() {
      return this.calls.filter((c) => c.method === 'PUT');
    },
  };

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url, `http://${req.headers.host}`);
      state.calls.push({ method: req.method, path: url.pathname, body });

      // Preflight: echo back the headers the request says it will use
      const origin = req.headers.origin;
      res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'PROPFIND, GET, PUT, OPTIONS');
        res.setHeader(
          'Access-Control-Allow-Headers',
          req.headers['access-control-request-headers'] ?? 'authorization, content-type, depth',
        );
        res.setHeader('Access-Control-Max-Age', '600');
        res.writeHead(204).end();
        return;
      }

      const done = (status, payload, headers = {}) => {
        for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
        res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8' }).end(payload);
      };

      const expected = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`;
      if (req.headers.authorization !== expected) {
        done(401, 'unauthorized');
        return;
      }

      if (url.pathname === DAV_PATH || url.pathname === `${DAV_PATH}/`) {
        if (req.method === 'PROPFIND') {
          done(207, XML);
          return;
        }
      }

      if (url.pathname === FILE_URL_PATH) {
        if (req.method === 'GET') {
          if (state.file === null) {
            done(404, 'not found');
            return;
          }
          done(200, state.file, { 'Content-Type': 'application/json', 'Last-Modified': state.lastModified });
          return;
        }
        if (req.method === 'PUT') {
          state.file = body;
          state.lastModified = new Date().toUTCString();
          done(201, '');
          return;
        }
      }

      done(404, 'not found');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ state, server, port: server.address().port });
    });
  });
}

// ---------------------------------------------------------------- CDP

const dav = await startFakeDav();
const DAV_URL = `http://127.0.0.1:${dav.port}${DAV_PATH}`;
console.log(`  fake WebDAV: ${DAV_URL}`);

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

/**
 * Write storage directly, much faster than going through the settings form; this is exactly
 * what the SW reads.
 *
 * @param patch the fields to overlay, everything else stays as it is
 */
const setSettings = (patch) =>
  evaluate(`(async () => {
    const KEY = 'syncSettings';
    const cur = (await chrome.storage.local.get(KEY))[KEY] ?? {};
    // The baseline goes after \`...cur\` **on purpose**: on a rerun against the same profile,
    // the strategy / autoSync left over from last time won't leak in, so every scenario
    // starts from a well-defined state.
    const next = {
      ...cur,
      activeProvider: 'webdav',
      autoSync: false,
      pullOnStart: false,
      strategy: 'newest-wins',
      ...${JSON.stringify(patch)},
      config: {
        ...(cur.config ?? {}),
        webdav: {
          ...((cur.config ?? {}).webdav ?? {}),
          enabled: true, baseUrl: ${JSON.stringify(DAV_URL)},
          username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASS)}, path: '',
          ...(${JSON.stringify(patch)}.config?.webdav ?? {}),
        },
      },
    };
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  })()`);

/**
 * Write a document straight into storage (the equivalent of "data already on this machine").
 *
 * @param updatedAt this document's timestamp
 * @param summaries the summary of each entry; they all land in general-internal
 */
const seedDoc = (updatedAt, summaries) =>
  evaluate(`(async () => {
    const entries = ${JSON.stringify(summaries)}.map((s, i) => ({
      id: 'entry-' + i, scope: 'general', source: 'internal', summary: s,
      links: [], createdAt: ${updatedAt}, updatedAt: ${updatedAt},
    }));
    const doc = {
      schemaVersion: 1, updatedAt: ${updatedAt}, deviceId: 'smoke-m5',
      cells: {
        'general-internal': entries,
        'general-external': [], 'individual-internal': [], 'individual-external': [],
      },
    };
    await chrome.storage.local.set({ checklist: doc });
    return doc.updatedAt;
  })()`);

const readLocal = () =>
  evaluate(`(async () => (await chrome.storage.local.get('checklist')).checklist ?? null)()`);

const readStatus = () =>
  evaluate(`(async () => (await chrome.storage.local.get('syncStatus')).syncStatus ?? null)()`);

const backupKeys = () =>
  evaluate(`(async () => Object.keys(await chrome.storage.local.get(null))
    .filter((k) => k.startsWith('checklist-backup-') || k.startsWith('checklist-remote-backup-'))
    .sort())()`);

/**
 * Wipe the sync settings / status / backups left over from the last run, so every run
 * starts from the same place.
 *
 * Without this, assertions like "the button is disabled while the form is incomplete" start
 * failing falsely from the second run on -- the complete config stored last time gets
 * prefilled into the settings form, so of course the button is enabled.
 */
const resetStorage = () =>
  evaluate(`(async () => {
    const all = await chrome.storage.local.get(null);
    const gone = Object.keys(all).filter((k) =>
      k === 'syncSettings' || k === 'syncStatus' ||
      k.startsWith('checklist-backup-') || k.startsWith('checklist-remote-backup-'));
    await chrome.storage.local.remove(gone);
    return gone.length;
  })()`);

const alarms = () =>
  evaluate(`(async () => (await chrome.alarms.getAll()).map((a) => ({
    name: a.name, period: a.periodInMinutes })))()`);

/**
 * Send a sync message and wait for the SW's reply.
 *
 * `undefined` means the message port closed before sendResponse (the MV3 SW may have been
 * recycled or restarted at that exact moment). Retry once in that case; if there's still no
 * reply, fake a failure reply so the assertion fails with a sentence you can read instead of
 * an `undefined` you can't make sense of.
 *
 * @param type the message type, one of the ones in the `MSG` table
 * @param body extra fields, e.g. `{ force: true }`
 * @returns the SW's reply plus a `text` field: `window.__mc.render` renders `message` in the
 *   page into the current UI language, so the assertions still check "the words the user
 *   sees" and that covers the rendering path too
 */
const sync = async (type, body = {}) => {
  const payload = JSON.stringify({ type, ...body });
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await evaluate(`chrome.runtime.sendMessage(${payload})`);
    if (res !== undefined && res !== null) {
      return { ...res, text: await render(res.message) };
    }
    await sleep(500);
  }
  return { ok: false, message: { key: 'err.bg.commFailed', params: { detail: 'smoke: 端口提前关闭' } }, text: '后台没有响应（消息端口提前关闭）' };
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
};

const summariesOf = (doc) => (doc?.cells?.['general-internal'] ?? []).map((e) => e.summary);
const remoteSummaries = () => {
  try {
    return summariesOf(JSON.parse(dav.state.file));
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- Start

dav.state.calls.length = 0;
await goto(APP);
await send('Page.bringToFront').catch(() => {});
const hidden = await warnIfHidden(evaluate);
console.log(`  tab visible: ${hidden ? 'no (will fall back)' : 'yes'}`);

// --- Settings page UI (don't click the two buttons that request permission) -----------------------------
await resetStorage();
// After clearing storage we have to reload, or the settings form still holds the draft the last run read into memory.
await goto(APP);
// The view is React state, not a query param (the tab in App.tsx), so we have to click that tab.
await evaluate(`document.querySelector('.app__tab[data-tab="settings"]')?.click()`);

// Switch the sync method to WebDAV first, or the next two assertions aren't even looking at
// anything on screen. M7 put "local sync folder" into PROVIDER_CATALOG at the front, so when
// `activeProvider` is empty that's what's selected by default, and the `#dav-*` fields only
// render inside the WebDAV form. Without switching: "the password field is type=password"
// fails with `undefined`, and worse, "the button is disabled" would wrongly pass -- with no
// folder picked the shared action row also has 3 buttons, also matches the full text, and
// also happens to be all disabled, so the assertion passes for the wrong reason.
// Switching tabs is React state, `#provider` won't exist until the next frame, so wait for it to show up before touching it.
for (let i = 0; i < 20; i++) {
  if (await evaluate(`!!document.querySelector('#provider')`)) break;
  await sleep(150);
}
await evaluate(`(() => {
  const sel = document.querySelector('#provider');
  sel.value = 'webdav';
  sel.dispatchEvent(new Event('change', { bubbles: true }));
})()`);

let panel = null;
for (let i = 0; i < 20 && panel === null; i++) {
  await sleep(150);
  panel = await evaluate(`(() => {
    if (!document.querySelector('#dav-base')) return null;
    return { base: !!document.querySelector('#dav-base'), pass: document.querySelector('#dav-pass')?.type };
  })()`);
}
check('settings page renders the sync panel', panel !== null, JSON.stringify(panel));
check('password field is type=password (not shown in plain text)', panel?.pass === 'password');
check(
  'the button is disabled while the form is incomplete (so the user does not have to click to get an error)',
  await evaluate(`(() => {
    // Identify the WebDAV row by its "save and test connection" button -- selecting '.panel .btn' would
    // also sweep in the **shared** action buttons, and that row looks exactly the same under
    // other providers (see the comment above).
    const row = [...document.querySelectorAll('.panel .row')].find((r) =>
      [...r.querySelectorAll('button')].some((b) => b.textContent.trim() === '保存并测试连接'));
    if (!row) return false;
    const btns = [...row.querySelectorAll('button')];
    return btns.length === 3 && btns.every((b) => b.disabled);
  })()`),
);

// Warm up the SW: the first message after a cold start occasionally lands in the restart window (see the note on sync).
await sync('mc:get-user');

// --- Test connection -----------------------------------------------------------
await setSettings({});
dav.state.calls.length = 0;
const test1 = await sync(MSG.test);
check('empty repo: test connection passes', test1?.ok === true, test1?.text);
check(
  'test connection probes the collection with PROPFIND',
  dav.state.calls.some((c) => c.method === 'PROPFIND' && c.path === DAV_PATH),
  dav.state.calls.map((c) => c.method).join(','),
);

// --- First upload -----------------------------------------------------------
const T0 = Date.now();
await seedDoc(T0, ['本地条目 A']);
const putBefore = dav.state.puts.length;
const push1 = await sync(MSG.push);
check('first upload succeeds', push1?.ok === true, push1?.text);
check('remote file created with the right content', JSON.stringify(remoteSummaries()) === '["本地条目 A"]', JSON.stringify(remoteSummaries()));
check('first upload makes no extra backup (there was nothing remote to overwrite)', (await backupKeys()).length === 0);
check('exactly one PUT was sent', dav.state.puts.length === putBefore + 1);

// --- Nothing changes, so neither side moves --------------------------------------------------
const push2 = await sync(MSG.push);
check('upload again: judged "already in sync" instead of pushing for nothing', push2?.ok === true && /一致/.test(push2.text), push2?.text);
check('no second PUT was made', dav.state.puts.length === putBefore + 1);

const pull1 = await sync(MSG.pull);
check('pull again: also judged "already in sync"', pull1?.ok === true && /一致/.test(pull1.text), pull1?.text);

// --- Remote update -> pull ----------------------------------------------------
const T1 = T0 + 600_000;
dav.state.file = JSON.stringify({
  schemaVersion: 1,
  updatedAt: T1,
  deviceId: 'smoke-remote',
  cells: {
    'general-internal': [
      {
        id: 'r1', scope: 'general', source: 'internal', summary: '远端条目 B',
        links: [], createdAt: T1, updatedAt: T1,
      },
    ],
    'general-external': [], 'individual-internal': [], 'individual-external': [],
  },
});
const pull2 = await sync(MSG.pull);
check('remote updated → pull succeeds', pull2?.ok === true, pull2?.text);
check("local content replaced with the remote's", JSON.stringify(summariesOf(await readLocal())) === '["远端条目 B"]', JSON.stringify(summariesOf(await readLocal())));
check('the local copy was backed up before being overwritten', (await backupKeys()).some((k) => k.startsWith('checklist-backup-')), (await backupKeys()).join(','));
const st2 = await readStatus();
check('sync status records the pull', st2?.lastAction === 'pull' && typeof st2?.lastSyncAt === 'number', JSON.stringify(st2));

// --- Upload conflict -----------------------------------------------------------
const T2 = Date.now() + 1_200_000;
dav.state.file = JSON.stringify({
  schemaVersion: 1, updatedAt: T2, deviceId: 'smoke-remote',
  cells: {
    'general-internal': [
      { id: 'r2', scope: 'general', source: 'internal', summary: '别人刚写的 C', links: [], createdAt: T2, updatedAt: T2 },
    ],
    'general-external': [], 'individual-internal': [], 'individual-external': [],
  },
});
const before = dav.state.puts.length;
const push3 = await sync(MSG.push);
check('upload when the remote changed → held pending confirmation', push3?.ok === true && push3?.conflict?.kind === 'push', JSON.stringify(push3?.conflict));
check('not a byte of the remote was changed while it was held', dav.state.puts.length === before && JSON.stringify(remoteSummaries()) === '["别人刚写的 C"]');
check('the conflict state was recorded in syncStatus', (await readStatus())?.pendingConflict?.kind === 'push');

// --- Forced upload ---------------------------------------------------------
const push4 = await sync(MSG.push, { force: true });
check('upload succeeds after confirmation', push4?.ok === true && !push4?.conflict, push4?.text);
check('the remote was overwritten by the local copy', JSON.stringify(remoteSummaries()) === '["远端条目 B"]', JSON.stringify(remoteSummaries()));
check('the overwritten remote was backed up', (await backupKeys()).some((k) => k.startsWith('checklist-remote-backup-')), (await backupKeys()).join(','));

// --- The "local wins" strategy doesn't ask any more ---------------------------------------------
await setSettings({ strategy: 'local-wins' });
const T3 = Date.now() + 1_800_000;
dav.state.file = JSON.stringify({
  schemaVersion: 1, updatedAt: T3, deviceId: 'smoke-remote',
  cells: {
    'general-internal': [
      { id: 'r3', scope: 'general', source: 'internal', summary: '又有人改了 D', links: [], createdAt: T3, updatedAt: T3 },
    ],
    'general-external': [], 'individual-internal': [], 'individual-external': [],
  },
});
const push5 = await sync(MSG.push);
check('with the "local wins" strategy a remote update is still pushed straight through', push5?.ok === true && !push5?.conflict, push5?.text);

// --- Pull conflict (timestamps tie + ask) ----------------------------------------
await setSettings({ strategy: 'ask' });
const T4 = Date.now() + 2_400_000;
await seedDoc(T4, ['本地这份 E']);
dav.state.file = JSON.stringify({
  schemaVersion: 1, updatedAt: T4, deviceId: 'smoke-remote',
  cells: {
    'general-internal': [
      { id: 'r4', scope: 'general', source: 'internal', summary: '远端这份 F', links: [], createdAt: T4, updatedAt: T4 },
    ],
    'general-external': [], 'individual-internal': [], 'individual-external': [],
  },
});
const pull3 = await sync(MSG.pull);
check('timestamps tie + strategy ask → held to ask the user', pull3?.ok === true && pull3?.conflict?.kind === 'pull', JSON.stringify(pull3?.conflict));
check('the local copy was not changed while it was held', JSON.stringify(summariesOf(await readLocal())) === '["本地这份 E"]');
check('the conflict carries the remote JSON (so the user does not have to fetch it again)', typeof pull3?.conflict?.remoteJson === 'string' && /远端这份 F/.test(pull3.conflict.remoteJson));

const pull4 = await sync(MSG.pull, { force: true, remoteJsonOverride: pull3.conflict.remoteJson });
check('"use the remote version" succeeds', pull4?.ok === true && /采用远端/.test(pull4.text), pull4?.text);
check("local content replaced with the remote's", JSON.stringify(summariesOf(await readLocal())) === '["远端这份 F"]');

// --- Remote file is corrupt -> upload can still overwrite it -------------------------------------
dav.state.file = '{ 这不是 JSON';
const push6 = await sync(MSG.push);
check('a corrupt remote file does not block the upload', push6?.ok === true, push6?.text);
check('the corrupt file is overwritten with the new content', JSON.stringify(remoteSummaries()) === '["远端这份 F"]');

// --- Error paths: error messages should be readable (not serialized into {}) --------------------
await setSettings({ config: { webdav: { password: 'wrong' } } });
const badAuth = await sync(MSG.test);
check('wrong password → ok:false and it says the problem is authentication', badAuth?.ok === false && /认证/.test(badAuth.text), badAuth?.text);
check('the failure message is not an empty object (the exception was not swallowed by structured clone)', typeof badAuth?.text === 'string' && badAuth.text.length > 4);

await setSettings({ config: { webdav: { password: PASS, baseUrl: `http://127.0.0.1:${dav.port}/nope` } } });
const badPath = await sync(MSG.test);
check('path does not exist → points at "server address and subdirectory"', badPath?.ok === false && /路径/.test(badPath.text), badPath?.text);

const st9 = await readStatus();
check(
  'the failure is recorded in syncStatus.lastError too (and can be turned into a readable sentence)',
  (await render(st9?.lastError)).length > 0,
  await render(st9?.lastError),
);
check('a failure does not wipe the last sync time as a side effect', typeof st9?.lastSyncAt === 'number', String(st9?.lastSyncAt));
check('a failure does not wipe the last action', st9?.lastAction === 'push', String(st9?.lastAction));

// --- Alarms: only set when they should be ----------------------------------------------
await setSettings({ config: { webdav: { baseUrl: DAV_URL } }, autoSync: false });
await sleep(250);
check('auto sync off → no periodic alarm', (await alarms()).every((a) => a.name !== 'mc-sync-periodic'), JSON.stringify(await alarms()));

await setSettings({ autoSync: true });
await sleep(400);
const arm = (await alarms()).find((a) => a.name === 'mc-sync-periodic');
check('auto sync on → a 60-minute alarm is armed', arm?.period === 60, JSON.stringify(await alarms()));

await setSettings({ autoSync: false });
await sleep(400);
check('auto sync off → the alarm is cleared', (await alarms()).every((a) => a.name !== 'mc-sync-periodic'), JSON.stringify(await alarms()));

// ---------------------------------------------------------------- Wrap up

console.log('');
if (failures.length === 0) {
  console.log(`all passed (${dav.state.calls.length} requests)`);
} else {
  console.log(`${failures.length} checks failed:`);
  for (const f of failures) console.log(`  - ${f}`);
}
ws.close();
dav.server.close();
process.exit(failures.length === 0 ? 0 : 1);

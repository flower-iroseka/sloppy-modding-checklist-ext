// M1 end-to-end smoke (dev only): in a real Chromium, verify that the debug API drives
// CRUD -> flush -> a real write to chrome.storage.local, that the data survives a reload
// and rehydration, and that export/clear/import round-trips the text.
// Depends on window.__mc exposed by app.html?debug=1 (src/shared/devtools.ts).
// Usage: node scripts/smoke-m1.mjs <debugPort> <extensionId>
const [port, extId] = process.argv.slice(2);
if (!port || !extId) {
  console.error('usage: node scripts/smoke-m1.mjs <debugPort> <extensionId>');
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

async function main() {
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
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? 'unknown'}`);
    }
    return r.result?.value;
  }

  async function openAndWaitReady() {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Page.navigate', { url: PAGE });
    for (let i = 0; i < 60; i++) {
      await sleep(150);
      const ready = await evaluate(`!!window.__mc && window.__mc.state().hydrated`);
      if (ready) return true;
    }
    return false;
  }

  // ---- 1) First load + CRUD + write to disk ----
  check('page ready (debug API + hydrated)', await openAndWaitReady());

  const seeded = await evaluate(`(async () => {
    const mc = window.__mc;
    mc.clearAll();
    await mc.flush();
    mc.addEntry({ scope: 'general', source: 'internal', summary: 'M1 e2e A', links: ['https://osu.ppy.sh/beatmapsets/1/discussion/2'] });
    mc.addEntry({ scope: 'general', source: 'external', summary: 'M1 e2e B', links: ['https://example.com/b'] });
    mc.addEntry({ scope: 'individual', source: 'internal', summary: 'M1 e2e C' });
    await mc.flush();
    const d = mc.doc();
    return { counts: Object.fromEntries(Object.entries(d.cells).map(([k, v]) => [k, v.length])), deviceId: d.deviceId };
  })()`);

  check(
    'CRUD lands in the right cells',
    seeded.counts['general-internal'] === 1 &&
      seeded.counts['general-external'] === 1 &&
      seeded.counts['individual-internal'] === 1 &&
      seeded.counts['individual-external'] === 0,
    JSON.stringify(seeded.counts),
  );

  // ---- 2) Real write to chrome.storage.local ----
  const stored = await evaluate(`(async () => {
    const bag = await chrome.storage.local.get('checklist');
    const doc = bag.checklist;
    if (!doc) return null;
    return { counts: Object.fromEntries(Object.entries(doc.cells).map(([k, v]) => [k, v.length])), deviceId: doc.deviceId };
  })()`);
  check('real write to chrome.storage.local', !!stored, stored ? `deviceId=${stored.deviceId}` : 'no doc');

  // ---- 2b) Does the UI follow the store (cell counts + read-only list) ----
  const ui = await evaluate(`(() => {
    const zones = [...document.querySelectorAll('.zone')];
    const counts = zones.map((z) => z.querySelector('.zone__count')?.textContent?.trim() ?? '');
    const rows = [...document.querySelectorAll('li.card[data-entry-id]')].map((e) => e.textContent);
    return { zoneCount: zones.length, counts, rowCount: rows.length };
  })()`);
  check('all 4 zones render', ui.zoneCount === 4, JSON.stringify(ui.counts));
  check('zone counts follow the store', ui.counts.filter((c) => c === '1').length === 3 && ui.counts.filter((c) => c === '0').length === 1, JSON.stringify(ui.counts));
  check('read-only list renders 3 rows', ui.rowCount === 3, `rows=${ui.rowCount}`);

  // ---- 3) Reload the page -> rehydrate -> data is still there ----
  const ready2 = await openAndWaitReady();
  const afterReload = await evaluate(`(() => {
    const d = window.__mc.doc();
    return {
      deviceId: d.deviceId,
      counts: Object.fromEntries(Object.entries(d.cells).map(([k, v]) => [k, v.length])),
      summaries: Object.values(d.cells).flat().map((e) => e.summary).sort(),
    };
  })()`);
  check('still hydrated after reload', ready2);
  check(
    'entries survive the reload (persisted across reloads)',
    JSON.stringify(afterReload.counts) === JSON.stringify(seeded.counts) &&
      JSON.stringify(afterReload.summaries) === JSON.stringify(['M1 e2e A', 'M1 e2e B', 'M1 e2e C']),
    JSON.stringify(afterReload.counts),
  );
  check('deviceId is stable across reloads', afterReload.deviceId === seeded.deviceId, afterReload.deviceId);

  // ---- 4) Export -> clear -> import (round-trip) ----
  const roundTrip = await evaluate(`(async () => {
    const mc = window.__mc;
    const text1 = mc.serialize();
    const { doc, dropped } = mc.parse(text1);
    mc.clearAll();
    await mc.flush();
    const emptied = Object.values(mc.doc().cells).flat().length;
    mc.store.getState().replaceDoc(doc);
    await mc.flush();
    const text2 = mc.serialize();
    const d = mc.doc();
    return { equal: text1 === text2, emptied, dropped, total: Object.values(d.cells).flat().length, bytes: text1.length };
  })()`);
  check('empty after clear', roundTrip.emptied === 0);
  check('entry count restored after import', roundTrip.total === 3, `total=${roundTrip.total}`);
  check('export<->import round-trips the text identically', roundTrip.equal, `bytes=${roundTrip.bytes}, dropped=${roundTrip.dropped}`);

  // ---- 5) Merge import dedupes ----
  const mergeCheck = await evaluate(`(async () => {
    const mc = window.__mc;
    const before = Object.values(mc.doc().cells).flat().length;
    const { doc: incoming } = mc.parse(mc.serialize());
    const { added, skipped } = mc.merge(incoming);
    mc.store.getState().replaceDoc(mc.merge(incoming).doc);
    await mc.flush();
    return { added, skipped, before, selfMergeAdded: added };
  })()`);
  check('self-merge skips everything (dedupe by link/id)', mergeCheck.added === 0 && mergeCheck.skipped === 3, JSON.stringify(mergeCheck));

  // Wrap up: clear everything so no test data is left behind
  await evaluate(`(async () => { window.__mc.clearAll(); await window.__mc.flush(); })()`);

  ws.close();
  console.log(failures.length === 0 ? '\nALL M1 SMOKE CHECKS PASSED' : `\nFAILURES: ${failures.join(', ')}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('SMOKE-M1 FAILED:', err.message);
  process.exit(1);
});

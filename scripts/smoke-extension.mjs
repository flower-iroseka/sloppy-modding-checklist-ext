// MV3 load smoke test (dev only, not a deliverable):
// Assumes a headless Chromium/Edge already loaded this extension via --load-extension
// and has --remote-debugging-port open. The script opens the extension page entry over
// CDP and asserts that the theme variables and React rendering work.
// Usage: node scripts/smoke-extension.mjs <debugPort> <extensionId>
const [port, extId] = process.argv.slice(2);
if (!port || !extId) {
  console.error('usage: node scripts/smoke-extension.mjs <debugPort> <extensionId>');
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ROOT = `chrome-extension://${extId}`;

async function getPageTarget() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = await res.json();
  return list.find((t) => t.type === 'page') ?? list[0];
}

async function main() {
  // 1) Check whether the service_worker is registered (means manifest.background parsed)
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const sw = list.find((t) => t.type === 'service_worker');
  const hasExtSw = !!sw;
  console.log('targets:', list.map((t) => `${t.type}:${t.url}`).join(' | ') || '(none)');
  console.log('background service_worker registered:', hasExtSw);

  const target = await getPageTarget();
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

  await send('Page.enable');
  await send('Runtime.enable');

  /**
   * Open a page inside the extension, wait for React to attach child nodes, then
   * evaluate each expression and print the result.
   *
   * @param page file name relative to the extension root, e.g. app.html
   * @param exprs list of [label, expression] pairs, evaluated one by one
   */
  async function openAndEval(page, exprs) {
    await send('Page.navigate', { url: `${ROOT}/${page}` });
    // Wait for the page to load and React to mount (root has child nodes)
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const r = await send('Runtime.evaluate', {
        expression: `document.readyState === 'complete' && (document.querySelector('#root')?.childElementCount ?? 0) > 0`,
        returnByValue: true,
      });
      if (r.result?.value) break;
    }
    await sleep(150);
    console.log(`\n== ${page} ==`);
    for (const [label, expr] of exprs) {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      console.log(label + ':', JSON.stringify(r.result?.value));
    }
  }

  await openAndEval(
    'app.html',
    [
      ['brand', `document.querySelector('.app__brandname')?.textContent ?? null`],
      ['tab count', `document.querySelectorAll('.app__tab').length`],
      ['active tab bg', `getComputedStyle(document.querySelector('.app__tab--active')).backgroundColor`],
      ['body bg', `getComputedStyle(document.body).backgroundColor`],
      ['zone count', `document.querySelectorAll('.zone').length`],
    ],
  );

  await openAndEval(
    'popup.html',
    [
      ['title', `document.querySelector('.pu__title')?.textContent ?? null`],
      ['stat cells', `document.querySelectorAll('.pu__cell').length`],
      ['open btn', `!!document.querySelector('.pu__open')`],
    ],
  );

  ws.close();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('SMOKE FAILED:', err.message);
    process.exit(1);
  },
);

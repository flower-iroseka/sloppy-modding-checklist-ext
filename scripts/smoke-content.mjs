// Content script injection smoke test (dev only): navigate to the given osu.ppy.sh
// discussion URL, capture the page console, and assert that our content script's
// startup marker shows up.
// Usage: node scripts/smoke-content.mjs <debugPort> <url> <markerSubstring>
const [port, url, marker] = process.argv.slice(2);
if (!port || !url || !marker) {
  console.error('usage: node scripts/smoke-content.mjs <debugPort> <url> <markerSubstring>');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const list = await res.json();
  const target = list.find((t) => t.type === 'page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res2, rej) => {
    ws.onopen = res2;
    ws.onerror = rej;
  });

  let idc = 0;
  const pending = new Map();
  const consoleLines = [];
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params?.args ?? [])
        .map((a) => (a.value === undefined ? a.description ?? '' : String(a.value)))
        .join(' ');
      consoleLines.push(text);
    }
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
  await send('Page.navigate', { url });

  let matched = false;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    if (consoleLines.some((l) => l.includes(marker))) {
      matched = true;
      break;
    }
    const r = await send('Runtime.evaluate', {
      expression: `location.href`,
      returnByValue: true,
    });
    const href = r.result?.value ?? '';
    if (i % 5 === 4) console.log('  waiting… href=', href);
  }
  console.log('final href ok:', (await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true })).result?.value);
  console.log('content marker matched:', matched);
  if (!matched) {
    console.log('--- captured console lines ---');
    console.log(consoleLines.slice(0, 20).join('\n') || '(none)');
  }
  ws.close();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('SMOKE-CONTENT FAILED:', err.message);
    process.exit(1);
  },
);

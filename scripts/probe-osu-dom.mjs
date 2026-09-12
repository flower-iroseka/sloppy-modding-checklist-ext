// Real-site DOM probe (dev only): as CODING_PLAN §8.1 requires, check the actual
// structure of the post container / author link / current user / permalink on a real
// osu.ppy.sh discussion page, so we can pin down src/content/locators.ts.
// Usage: node scripts/probe-osu-dom.mjs <debugPort> [discussionUrl]
const [port, givenUrl] = process.argv.slice(2);
if (!port) {
  console.error('usage: node scripts/probe-osu-dom.mjs <debugPort> [discussionUrl]');
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++idc;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval error');
    return r.result?.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');

  let url = givenUrl;
  if (!url) {
    // Pick a beatmapset from the public listing and build a discussion URL
    await send('Page.navigate', { url: 'https://osu.ppy.sh/beatmapsets?m=3' });
    await sleep(6000);
    const href = await evaluate(
      `(() => { const a = [...document.querySelectorAll('a[href^="/beatmapsets/"]')]
          .map(x => x.getAttribute('href'))
          .filter(h => /^\\/beatmapsets\\/\\d+$/.test(h));
        return a[0] ?? null; })()`,
    );
    if (!href) throw new Error('listing 页面找不到 beatmapset 链接（可能被 Cloudflare/登录墙拦住）');
    url = `https://osu.ppy.sh${href}/discussion`;
  }

  console.log('navigating to:', url);
  await send('Page.navigate', { url });
  await sleep(9000);
  console.log('final href:', await evaluate('location.href'));

  const report = await evaluate(`(() => {
    const q = (sel) => document.querySelectorAll(sel).length;
    const cands = {
      '[data-post-id]': q('[data-post-id]'),
      '.beatmap-discussion-post': q('.beatmap-discussion-post'),
      '.js-beatmap-discussion-post': q('.js-beatmap-discussion-post'),
      '.beatmap-discussion__post': q('.beatmap-discussion__post'),
      '[class*="discussion-post"]': q('[class*="discussion-post"]'),
      'article': q('article'),
      '.beatmap-discussion--post': q('.beatmap-discussion--post'),
    };
    // Find class names that repeat a few times -- post containers usually look like that
    const divs = [...document.querySelectorAll('div[class]')];
    const counts = new Map();
    for (const d of divs) {
      for (const c of d.classList) {
        if (/post|discussion|review/i.test(c)) counts.set(c, (counts.get(c) || 0) + 1);
      }
    }
    const repeated = [...counts.entries()].filter(([, n]) => n >= 2 && n <= 60).sort((a, b) => b[1] - a[1]).slice(0, 25);

    // User links
    const userLinks = [...document.querySelectorAll('a[href^="/users/"]')].slice(0, 8)
      .map(a => ({ href: a.getAttribute('href'), text: (a.textContent || '').trim().slice(0, 30), cls: a.className }));

    // Find the outer structure of anything that "looks like a post" container
    const probe = document.querySelector('[data-post-id], .beatmap-discussion-post, [class*="discussion-post"]');
    const describe = (el, depth) => {
      if (!el || depth > 3) return null;
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        cls: el.className || undefined,
        attrs: [...el.attributes].map(a => a.name).filter(n => n.startsWith('data-')),
        children: [...el.children].slice(0, 6).map(c => describe(c, depth + 1)),
      };
    };
    return {
      title: document.title,
      url: location.href,
      loggedIn: !!document.querySelector('a[href^="/users/"] .avatar--online, .js-current-user-avatar, [data-current-user-id]'),
      navbarUser: (document.querySelector('.js-current-user-avatar img, .navbar .avatar') || {}).outerHTML?.slice(0, 200) ?? null,
      candidates: cands,
      repeatedClasses: repeated,
      userLinks,
      probeTree: describe(probe, 0),
      bodyClasses: document.body.className,
    };
  })()`);

  console.log(JSON.stringify(report, null, 2));
  ws.close();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('PROBE FAILED:', err.message);
    process.exit(1);
  },
);

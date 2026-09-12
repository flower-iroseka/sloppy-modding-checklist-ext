// M3 end-to-end smoke (dev only): the content script on a real osu.ppy.sh discussion page --
// the "＋ 添加到 Checklist" button on each post, the FAB, the shadow DOM overlay it opens
// (body and permalink prefilled), the source suggestion (post author vs current logged-in
// user, logged out counts as external), and the entry really landing in chrome.storage.local
// after submit. Needs the real site, so it won't run without a network connection.
//
// Usage: node scripts/smoke-m3.mjs <debugPort> <extensionId> [discussionUrl]
import { clickSelector, warnIfHidden } from './cdp.mjs';

const [port, extId, urlArg] = process.argv.slice(2);
if (!port || !extId) {
  console.error('usage: node scripts/smoke-m3.mjs <debugPort> <extensionId> [discussionUrl]');
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
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let idc = 0;
const pending = new Map();
const isolatedContexts = new Set();

ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.method === 'Runtime.executionContextCreated') {
    const ctx = msg.params.context;
    // The content script runs in an isolated world: auxData.type === 'isolated'
    if (ctx.auxData?.type === 'isolated') isolatedContexts.add(ctx.id);
    if (ctx.auxData?.type === 'isolated') return;
  }
  if (msg.method === 'Runtime.executionContextsCleared') isolatedContexts.clear();
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

/**
 * Evaluate in the page's main world.
 *
 * @param expression the JS to run
 * @param opts.awaitPromise whether to wait when the expression returns a Promise, default yes
 * @throws {Error} the expression threw
 */
async function evaluate(expression, { awaitPromise = true } = {}) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? 'unknown'}`);
  }
  return r.result?.value;
}

/**
 * Evaluate in the isolated world the content script lives in.
 *
 * This is the crux of M3: the isolated world has chrome.storage but can't see the page's
 * globals (like window.currentUser) -- plenty of "obviously correct" code falls flat right
 * here.
 *
 * @param expression the JS to run
 * @param opts.awaitPromise whether to wait when the expression returns a Promise, default yes
 * @throws {Error} the content script's isolated world wasn't found
 */
async function evaluateInContentWorld(expression, { awaitPromise = true } = {}) {
  for (const contextId of isolatedContexts) {
    let r;
    try {
      r = await send('Runtime.evaluate', {
        expression,
        contextId,
        awaitPromise,
        returnByValue: true,
      });
    } catch {
      continue;
    }
    if (r.exceptionDetails) continue; // not our world (can't reach chrome.storage)
    return r.result?.value;
  }
  throw new Error('找不到内容脚本的隔离世界');
}

/**
 * Find an isolated world that can reach chrome.storage and hold onto it.
 *
 * @returns whether one was found (within 40 tries)
 */
async function findContentWorld() {
  for (let i = 0; i < 40; i++) {
    if (isolatedContexts.size > 0) {
      const ok = await evaluateInContentWorld(
        `typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.runtime`,
      ).catch(() => false);
      if (ok) return true;
    }
    await sleep(150);
  }
  return false;
}

// ---------------------------------------------------------------- Pointer

/**
 * Build a lookup expression that searches our overlay's shadow root first and falls back
 * to the main document.
 *
 * @param selector CSS selector
 * @returns a piece of JS that evaluates to the element or null
 */
function findExpr(selector) {
  const sel = JSON.stringify(selector);
  return `(() => {
    const host = document.getElementById('mc-overlay-host');
    return (host && host.shadowRoot ? host.shadowRoot.querySelector(${sel}) : null) || document.querySelector(${sel});
  })()`;
}

/**
 * Click an element. The lookup goes through the shadow DOM first (our overlay lives in the
 * shadow root of #mc-overlay-host) and falls back to the main document. Scrolling, waiting
 * for things to settle, measuring coordinates and dispatching all live in cdp.mjs -- which
 * also deals with "Chrome drops synthetic events when the tab isn't visible".
 *
 * @param selector CSS selector
 * @throws {Error} the element isn't in either place
 */
async function click(selector) {
  const how = await clickSelector(send, evaluate, findExpr(selector), { sleep });
  if (how === 'missing') throw new Error(`找不到元素：${selector}`);
}

/**
 * Type into the overlay (the overlay lives inside the shadow root).
 *
 * @param selector CSS selector
 * @param text the text to write
 */
async function typeInto(selector, text) {
  await click(selector);
  await evaluate(
    `(() => {
      const host = document.getElementById('mc-overlay-host');
      const el = host.shadowRoot.querySelector(${JSON.stringify(selector)});
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`,
  );
  await sleep(150);
}

// ---------------------------------------------------------------- Find a beatmap that has discussions

/**
 * Find the discussion URL of a beatmap that has discussions: use the one from the command
 * line if there is one, otherwise pick one from the listing.
 *
 * @returns the discussion URL, or null if none was found
 */
async function findDiscussionUrl() {
  if (urlArg) return urlArg;
  await send('Page.navigate', { url: 'https://osu.ppy.sh/beatmapsets?m=3' });
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const href = await evaluate(`(() => {
      for (const a of document.querySelectorAll('a[href]')) {
        const h = a.getAttribute('href') || '';
        if (h.includes('beatmapsets/') && /\\/beatmapsets\\/\\d+$/.test(h)) return h;
      }
      return null;
    })()`);
    // The site hands out absolute URLs (https://osu.ppy.sh/...), don't prepend the host again
    if (href) return href.startsWith('http') ? `${href}/discussion` : `https://osu.ppy.sh${href}/discussion`;
  }
  return null;
}

// ---------------------------------------------------------------- Test cases

console.log('== M3: 真站 post → checklist ==');

await send('Page.enable');
await send('Runtime.enable');
// Real pages are long, so use a normal viewport to keep noise like "element is outside the viewport" out of the way.
await send('Emulation.setDeviceMetricsOverride', {
  width: 1280,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

// Clear the checklist first: the content script reads in whatever is stored as soon as it
// hydrates, and entries left over from an earlier run make assertions like "one more entry"
// ambiguous. Clear through the extension page's debug API so it's definitely clean.
await send('Page.bringToFront').catch(() => {});
await send('Page.navigate', { url: `chrome-extension://${extId}/app.html?debug=1` });
for (let i = 0; i < 40; i++) {
  await sleep(150);
  if (await evaluate(`!!window.__mc && window.__mc.state().hydrated`)) break;
}
await warnIfHidden(evaluate);
await evaluate(`(async () => { window.__mc.clearAll(); await window.__mc.flush(); })()`);
await sleep(200);

const url = await findDiscussionUrl();
if (!url) {
  console.error('没能从 beatmapsets 列表里找到一张地图的 discussion 链接');
  process.exit(1);
}
console.log(`discussion: ${url}`);

await send('Page.navigate', { url });
await sleep(1500);

// Wait for the content script to inject (osu renders on the client, so the discussion list can arrive late)
let injected = 0;
for (let i = 0; i < 80; i++) {
  injected = await evaluate(`document.querySelectorAll('.mc-add-btn').length`).catch(() => 0);
  if (injected > 0) break;
  await sleep(250);
}

const posts = await evaluate(`document.querySelectorAll('.beatmap-discussion-post[data-post-id]').length`);
const discussions = await evaluate(`document.querySelectorAll('.beatmap-discussion').length`);
check('真站页面识别到 discussion', discussions > 0, `discussion=${discussions} post=${posts}`);
check('每条 post 都注入了添加按钮', injected > 0 && injected === posts, `按钮=${injected} / post=${posts}`);
check('左下角注入了 FAB', (await evaluate(`!!document.getElementById('mc-fab')`)) === true);
// This button moved: it used to sit in the bottom right, overlapping osu's own
// `.floating-toolbar` (the two round "back to top" buttons). So besides "is it there", we
// measure the geometry too -- position and size are the whole point of this change, and
// checking only that it exists proves nothing.
check(
  'FAB 是 50×50 的圆（和 osu 的回到顶部一样大）',
  await evaluate(`(() => {
    const r = document.getElementById('mc-fab').getBoundingClientRect();
    const radius = getComputedStyle(document.getElementById('mc-fab')).borderRadius;
    return Math.round(r.width) === 50 && Math.round(r.height) === 50 && radius === '50%';
  })()`),
);
check(
  'FAB 在左下角，且和 osu 的浮动工具栏不重叠',
  await evaluate(`(() => {
    const fab = document.getElementById('mc-fab').getBoundingClientRect();
    const inLeft = fab.left < innerWidth / 2;
    const inBottom = innerHeight - fab.bottom < 120;
    const bar = document.querySelector('.floating-toolbar');
    let overlaps = false;
    if (bar) {
      const b = bar.getBoundingClientRect();
      overlaps = fab.left < b.right && fab.right > b.left && fab.top < b.bottom && fab.bottom > b.top;
    }
    return inLeft && inBottom && !overlaps;
  })()`),
);
check(
  'FAB 圆钮里有图标（圆形放不下文字，得靠图标说明自己是什么）',
  await evaluate(`document.getElementById('mc-fab').querySelectorAll('svg path').length`) > 0,
);
check(
  '浮层宿主已挂载（shadow root）',
  (await evaluate(`!!document.getElementById('mc-overlay-host')?.shadowRoot`)) === true,
);

check('内容脚本能看到 chrome.storage', await findContentWorld());

// Can the isolated world read page globals? That's exactly what makes or breaks the source suggestion
const worldSees = await evaluateInContentWorld(
  `({ hasChrome: typeof chrome !== 'undefined', seesCurrentUser: typeof window.currentUser !== 'undefined', seesMainWorldMarker: typeof window.__mcMainMarker !== 'undefined' })`,
).catch((e) => ({ error: String(e) }));
await evaluate(`window.__mcMainMarker = 1`); // Set a marker in the main world as a control
await sleep(150);
const worldSees2 = await evaluateInContentWorld(
  `typeof window.__mcMainMarker !== 'undefined'`,
).catch(() => null);
console.log(`  · 隔离世界看到 chrome：${worldSees?.hasChrome}`);
console.log(`  · 隔离世界看到 window.currentUser：${worldSees?.seesCurrentUser}`);
console.log(`  · 隔离世界看到主世界刚设的标记：${worldSees2}（false = 确实是隔离世界）`);
console.log(`  · 主世界的 currentUser：${JSON.stringify(await evaluate(`window.currentUser ?? null`))}`);

// Read the first post's author and body to use as the assertion baseline
const firstPost = await evaluate(`(() => {
  const disc = document.querySelector('.beatmap-discussion');
  const post = disc.querySelector('.beatmap-discussion-post[data-post-id]');
  const links = [...disc.querySelectorAll('a.beatmap-discussion-user-card__user-link[data-user-id]')];
  const a = links.find(x => (x.textContent || '').trim()) || links[0];
  const permalinkEl = post.querySelector('a.click-to-copy[href*="/discussion/"]');
  return {
    authorId: a ? Number(a.dataset.userId) : null,
    authorName: a ? a.textContent.trim() : null,
    permalink: permalinkEl ? permalinkEl.getAttribute('href') : null,
    postId: post.dataset.postId,
  };
})()`);
console.log(`  · 第一条 post：作者=${firstPost.authorName}(${firstPost.authorId}) postId=${firstPost.postId}`);
console.log(`  · permalink=${firstPost.permalink}`);

check('第一条 post 读到了永久链接', typeof firstPost.permalink === 'string' && firstPost.permalink.includes('/discussion/'));

// 1) Click the button on the first post -> the overlay opens
console.log(`  · 按钮可见性: ${JSON.stringify(await evaluate(`(() => {
  const b = document.querySelector('.mc-add-btn');
  const cs = getComputedStyle(b);
  const r = b.getBoundingClientRect();
  const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, w: Math.round(r.width), h: Math.round(r.height), topEl: top ? top.className : null };
})()`))}`);
await click('.mc-add-btn');
await sleep(400);

const modal = await evaluate(`(() => {
  const host = document.getElementById('mc-overlay-host');
  const root = host && host.shadowRoot;
  const m = root && root.querySelector('.mc-modal');
  if (!m) return null;
  const ta = m.querySelector('textarea');
  const hrefs = [...m.querySelectorAll('a[href]')].map(a => a.getAttribute('href'));
  const on = [...m.querySelectorAll('.mc-seg__opt--on')].map(e => e.textContent.trim());
  const linkInputs = [...m.querySelectorAll('input')].map(i => i.value);
  return { summary: ta ? ta.value : null, hrefs, segOn: on, inputs: linkInputs };
})()`);
check('点 post 上的按钮后弹层打开', modal !== null);
check('弹层预填了帖子正文作为概述', !!modal?.summary && modal.summary.length > 0, JSON.stringify(modal?.summary?.slice(0, 30)));
check(
  '弹层预填了永久链接',
  JSON.stringify(modal?.hrefs ?? []).includes(firstPost.permalink) ||
    JSON.stringify(modal?.inputs ?? []).includes(firstPost.permalink),
  JSON.stringify(modal?.inputs ?? modal?.hrefs),
);
check('弹层默认落在 General × External', JSON.stringify(modal?.segOn) === JSON.stringify(['General', 'External']), JSON.stringify(modal?.segOn));

// 2) Submit -> the entry lands in storage
const beforeCount = await evaluateInContentWorld(
  `(async () => { const b = await chrome.storage.local.get('checklist'); return Object.values(b.checklist.cells).flat().length; })()`,
).catch(() => null);
console.log(`  · 提交前 chrome.storage 里的条目数：${beforeCount}`);

await click('.mc-modal__foot .btn--accent');
await sleep(600);

const after = await evaluateInContentWorld(
  `(async () => {
    const b = await chrome.storage.local.get('checklist');
    const doc = b.checklist;
    const all = Object.entries(doc.cells).flatMap(([cell, list]) => list.map(e => ({ cell, ...e })));
    const last = all[all.length - 1];
    return { total: all.length, cells: Object.fromEntries(Object.entries(doc.cells).map(([k, v]) => [k, v.length])), last };
  })()`,
).catch((e) => ({ error: String(e) }));

check(
  '提交后条目落进 chrome.storage.local',
  (after?.total ?? 0) === (beforeCount ?? 0) + 1,
  `before=${beforeCount} after=${after?.total}${after?.error ? ' err=' + after.error : ''}`,
);
check(
  '条目归到 General × External（按推荐来源）',
  after?.last?.scope === 'general' && after?.last?.source === 'external',
  JSON.stringify({ scope: after?.last?.scope, source: after?.last?.source }),
);
check(
  '条目带上了帖子链接与 meta',
  (after?.last?.links ?? []).includes(firstPost.permalink) &&
    after?.last?.meta?.beatmapsetId !== undefined,
  JSON.stringify({ links: after?.last?.links, meta: after?.last?.meta }),
);
// The content script path is the only place that sees the page's category -- which is exactly
// why it shouldn't be copied into meta. The category is already in the URL path of links[0].
check(
  'meta 里没有 category（分类在链接 URL 里，不重复存）',
  after?.last?.meta !== undefined && !('category' in after.last.meta),
  JSON.stringify(after?.last?.meta),
);
check(
  '条目记录了来源作者',
  after?.last?.sourceAuthor?.id === firstPost.authorId,
  JSON.stringify(after?.last?.sourceAuthor),
);

// 3) Close the overlay so no state is left behind for the next run
await click('.mc-modal__foot .btn').catch(() => {});
await sleep(300);

// ---------------------------------------------------------------- The internal branch
// "post author == current logged-in user -> internal" is the only reason the SW relay
// exists: the content script can't read window.currentUser from the isolated world. Here we
// set it to the post author in the main world and run the whole round trip (click -> isolated
// world -> SW -> main world executeScript -> back) to verify internal.
const authorId = firstPost.authorId;
if (typeof authorId === 'number') {
  await evaluate(`window.currentUser = { id: ${authorId}, username: ${JSON.stringify(firstPost.authorName)} }`);
  const relayed = await evaluateInContentWorld(
    `(async () => { const r = await chrome.runtime.sendMessage({ type: 'mc:get-user' }); return r; })()`,
  ).catch((e) => ({ error: String(e) }));
  check('SW 能把主世界的 currentUser 中转给内容脚本', relayed?.id === authorId, JSON.stringify(relayed));

  await click('.mc-add-btn');
  await sleep(500);

  const segs = await evaluate(`(() => {
    const m = document.getElementById('mc-overlay-host').shadowRoot.querySelector('.mc-modal');
    return m ? [...m.querySelectorAll('.mc-seg__opt--on')].map(e => e.textContent.trim()) : null;
  })()`);
  check('作者 == 当前用户 → 弹层默认选中 Internal', JSON.stringify(segs) === JSON.stringify(['General', 'Internal']), JSON.stringify(segs));

  const before2 = await evaluateInContentWorld(
    `(async () => { const b = await chrome.storage.local.get('checklist'); return b.checklist.cells['general-internal'].length; })()`,
  );
  await click('.mc-modal__foot .btn--accent');
  await sleep(600);

  const internal = await evaluateInContentWorld(
    `(async () => {
      const b = await chrome.storage.local.get('checklist');
      const list = b.checklist.cells['general-internal'];
      return { len: list.length, last: list[list.length - 1] };
    })()`,
  ).catch((e) => ({ error: String(e) }));
  check('提交后落在 General × Internal', (internal?.len ?? 0) === before2 + 1 && internal?.last?.source === 'internal', JSON.stringify({ before2, len: internal?.len, source: internal?.last?.source }));

  // Same logged-in user, now click someone else's post -> should suggest external
  const otherPost = await evaluate(`(() => {
    for (const p of document.querySelectorAll('.beatmap-discussion-post[data-post-id]')) {
      const a = p.querySelector('a.beatmap-discussion-user-card__user-link[data-user-id]');
      if (!a) continue;
      if (Number(a.dataset.userId) === ${authorId}) continue;
      const btn = p.querySelector('.mc-add-btn');
      if (!btn) continue;
      btn.id = 'mc-probe-btn';   // tag it temporarily so we can click it by coordinates
      return { authorId: Number(a.dataset.userId), name: a.textContent.trim() };
    }
    return null;
  })()`);
  if (otherPost) {
    await click('#mc-probe-btn');
    await sleep(500);
    const segs2 = await evaluate(`(() => {
      const m = document.getElementById('mc-overlay-host').shadowRoot.querySelector('.mc-modal');
      return m ? [...m.querySelectorAll('.mc-seg__opt--on')].map(e => e.textContent.trim()) : null;
    })()`);
    check(
      '作者是别人 → 推荐回到 External',
      JSON.stringify(segs2) === JSON.stringify(['General', 'External']),
      `当前用户=${authorId} 帖子作者=${otherPost.name}(${otherPost.authorId}) 选中=${JSON.stringify(segs2)}`,
    );
    await click('.mc-modal__foot .btn').catch(() => {});
    await sleep(250);
  } else {
    console.log('  · 页面上没有第二个不同作者的 post，跳过 external 对照');
  }
  await evaluate(`(() => { const b = document.getElementById('mc-probe-btn'); if (b) b.removeAttribute('id'); })()`);

  await evaluate(`window.currentUser = {}`);
  await click('.mc-modal__foot .btn').catch(() => {});
  await sleep(250);
} else {
  console.log('  · 第一条 post 没读到作者 id，跳过 internal 分支');
}

// ---------------------------------------------------------------- Scope auto-detected from the page position
// (CODING_PLAN §8.3) The position decides the scope:
//   General (All difficulties)   -> general   <- verified above (landing on the page is generalAll)
//   General (current difficulty) -> general
//   Timeline                     -> individual
// The last two need a different page, so we cover them here as well.

/**
 * Jump to a discussion page and wait for the content script to finish injecting the buttons.
 *
 * @param pageUrl the target address
 * @returns whether the injection finished
 */
async function gotoDiscussionPage(pageUrl) {
  isolatedContexts.clear(); // the old isolated world is dead after a navigation, wait for a new one
  await send('Page.navigate', { url: pageUrl });
  await sleep(1500);
  await findContentWorld();
  for (let i = 0; i < 40; i++) {
    // Make sure we've really landed on the target page: while the navigation is still in
    // flight the old page has buttons too, which would be a false positive
    const landed = await evaluate(`location.href.startsWith(${JSON.stringify(pageUrl)})`).catch(
      () => false,
    );
    if (landed && (await evaluate(`!!document.querySelector('.mc-add-btn')`).catch(() => false))) {
      return true;
    }
    await sleep(250);
  }
  return false;
}

/**
 * Click the first post's button on the current page and read the selected segments and the
 * suggestion hints out of the overlay. Close it on the way out.
 *
 * @returns the page mode, the selected segments, the suggestion hints; null if the overlay
 *   never opened
 */
async function openDialogAndRead() {
  await click('.mc-add-btn');
  await sleep(500);
  const r = await evaluate(`(() => {
    const m = document.getElementById('mc-overlay-host').shadowRoot.querySelector('.mc-modal');
    if (!m) return null;
    return {
      mode: (() => { const a = document.querySelector('.page-mode-link--is-active[data-mode]'); return a ? a.getAttribute('data-mode') : null; })(),
      segOn: [...m.querySelectorAll('.mc-seg__opt--on')].map(e => e.textContent.trim()),
      rec: [...m.querySelectorAll('.mc-rec')].map(e => e.textContent.trim()),
    };
  })()`);
  await click('.mc-modal__foot .btn').catch(() => {});
  await sleep(250);
  return r;
}

{
  const base = url.replace(/\/discussion.*$/, '');
  const diffIds = await evaluate(`(() => {
    const ids = new Set();
    for (const a of document.querySelectorAll('a[href*="/discussion/"]')) {
      const m = /\\/discussion\\/(\\d+)\\//.exec(a.getAttribute('href') || '');
      if (m) ids.add(m[1]);
    }
    return [...ids];
  })()`);
  console.log(`  · 这张谱面下的难度：${JSON.stringify(diffIds)}`);

  /**
   * Try a given category page across the difficulties (they differ a lot in content) and
   * take the first one that actually has posts.
   *
   * @param mode the discussion page category, e.g. general / timeline
   * @returns a usable address, or null if there isn't one
   */
  async function findPopulatedPage(mode) {
    for (const diff of (diffIds ?? []).slice(0, 4)) {
      const u = `${base}/discussion/${diff}/${mode}`;
      console.log(`  · 试 ${mode}：${u}`);
      if (await gotoDiscussionPage(u)) return u;
      console.log(`    · 这个难度的 ${mode} 页没有可添加的 post`);
    }
    return null;
  }

  // --- General (current difficulty) -> general
  const genUrl = await findPopulatedPage('general');
  if (!genUrl) {
    console.log('  · 没有非空的 General(当前难度) 页，跳过该分支');
  } else {
    const r = await openDialogAndRead();
    check(
      'General(当前难度) 页 → 范围仍是 General',
      r?.mode === 'general' && r?.segOn?.[0] === 'General',
      `${genUrl} mode=${r?.mode} 选中=${JSON.stringify(r?.segOn)}`,
    );
  }

  // --- Timeline -> individual
  const visited = await findPopulatedPage('timeline');

  if (!visited) {
    console.log(`  · ${JSON.stringify(diffIds)} 里没有非空的时间轴，跳过 individual 分支（单元测试已覆盖映射）`);
  } else {
    const tl = await openDialogAndRead();
    check('timeline 页的激活分类是 timeline', tl?.mode === 'timeline', String(tl?.mode));
    // Only assert the scope segment: the source segment depends on "logged-in user vs post
    // author" and has nothing to do with what we're verifying here
    check(
      'timeline 页 → 范围自动识别为 Individual',
      tl?.segOn?.[0] === 'Individual',
      `${visited} 选中=${JSON.stringify(tl?.segOn)}`,
    );
    check(
      '弹层显示「已按讨论页位置识别」提示',
      (tl?.rec ?? []).some((t) => t.includes('位置') && t.includes('Individual')),
      JSON.stringify(tl?.rec),
    );
  }
}

// ---------------------------------------------------------------- FAB -> app page
const targetsBefore = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).length;
await click('#mc-fab');
await sleep(1200);
const targetsAfter = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
check(
  'FAB 经 SW 打开了 app.html',
  targetsAfter.some((t) => t.url.includes(`chrome-extension://${extId}/app.html`)),
  `${targetsBefore} → ${targetsAfter.length} 个 target`,
);

console.log(failures.length === 0 ? '\nALL M3 SMOKE CHECKS PASSED' : `\nFAILURES: ${failures.join(', ')}`);
ws.close();
process.exit(failures.length === 0 ? 0 : 1);

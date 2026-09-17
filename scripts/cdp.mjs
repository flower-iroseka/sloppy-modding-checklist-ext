// Small CDP helpers shared by the smoke scripts.
//
// Each script used to carry its own copy of the click code, so one environment problem
// turned into a different fake failure in every script and looked like a code regression.
// Now, when the page isn't interactive, clicks fall back to a programmatic el.click() and
// say so; real drags (dnd-kit needs the movement from mouseMoved) can't fall back, so we
// report an environment error instead.

let warnedHidden = false;

/**
 * Whether the tab can receive real mouse events right now.
 *
 * @param evaluate a way to run a bit of JS in the page
 * @returns true when the page is visible; also false when the evaluation itself fails
 */
export async function isInteractive(evaluate) {
  try {
    return (await evaluate('document.visibilityState')) === 'visible';
  } catch {
    return false;
  }
}

/**
 * Print a loud warning once when the page isn't interactive. Only once: shouting on
 * every click would drown out the real assertion output.
 *
 * @param evaluate a way to run a bit of JS in the page
 * @returns whether the warning was printed this time
 */
export async function warnIfHidden(evaluate) {
  if (warnedHidden) return false;
  if (await isInteractive(evaluate)) return false;
  warnedHidden = true;
  console.log('  ! env: the tab is hidden (Chrome drops synthetic mouse events when the screen is locked / the RDP session is disconnected).');
  console.log('  !     Clicks fall back to a programmatic el.click() (no hit testing); real drags cannot fall back and report an environment error.');
  return true;
}

/**
 * Click an element.
 *
 * @param send CDP's send(method, params)
 * @param evaluate a way to run a bit of JS in the page
 * @param resolveExpr JS expression that evaluates to the element (null if it can't be
 *   found). Each script decides for itself whether to pierce the shadow root; this
 *   doesn't care.
 * @param opts.sleep the sleep(ms) used for waiting
 * @param opts.settle milliseconds to wait for things to settle after scrolling, default 220
 * @returns 'cdp' (real mouse event, goes through hit testing) / 'programmatic' (fallback) / 'missing'
 */
export async function clickSelector(send, evaluate, resolveExpr, { sleep, settle = 220 } = {}) {
  const find = `(() => { const el = ${resolveExpr}; if (!el) return null; return el; })()`;

  if (!(await isInteractive(evaluate))) {
    const hit = await evaluate(
      `(() => { const el = ${resolveExpr}; if (!el) return false; el.click(); return true; })()`,
    );
    if (hit) await sleep(250);
    return hit ? 'programmatic' : 'missing';
  }

  const scrolled = await evaluate(
    `(() => {
       const el = ${resolveExpr};
       if (!el) return false;
       el.scrollIntoView({ block: 'center', inline: 'center' });
       return true;
     })()`,
  );
  if (!scrolled) return 'missing';
  await sleep(settle); // wait for the scroll to settle before measuring, or we might click coordinates that already moved

  const rect = await evaluate(
    `(() => {
       const el = ${find};
       if (!el) return null;
       const b = el.getBoundingClientRect();
       return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height };
     })()`,
  );
  if (!rect) return 'missing';

  const x = Math.round(rect.x);
  const y = Math.round(rect.y);
  // Send mouseMoved first to set a hover target: without it Chrome sometimes can't work out where the click lands.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0, clickCount: 0 });
  await sleep(20);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
    });
    await sleep(30);
  }
  await sleep(250);
  return 'cdp';
}

/**
 * Type text into an input. When the page isn't interactive, Input.insertText gets
 * dropped too, so we fall back to "set the value with the native setter + dispatch an
 * input event" -- React controlled components accept that.
 *
 * @param send CDP's send(method, params)
 * @param evaluate a way to run a bit of JS in the page
 * @param resolveExpr JS expression that evaluates to the input (null if it can't be found)
 * @param text the text to write
 * @param opts.sleep the sleep(ms) used for waiting
 * @returns 'cdp' / 'programmatic' from the click below, or 'missing' when the input isn't there
 */
export async function typeInto(send, evaluate, resolveExpr, text, { sleep } = {}) {
  const how = await clickSelector(send, evaluate, resolveExpr, { sleep });
  if (how === 'missing') return 'missing';

  if (how === 'programmatic') {
    // focus() is not optional: author resolution in the popup hangs off onBlur, and
    // calling .blur() on an input that isn't focused is a no-op -- the event never fires.
    await evaluate(
      `(() => {
         const el = ${resolveExpr};
         if (!el) return false;
         el.focus();
         const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
         Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
         el.dispatchEvent(new Event('input', { bubbles: true }));
         return true;
       })()`,
    );
    await sleep(150);
    return 'programmatic';
  }

  await send('Input.insertText', { text });
  await sleep(150);
  return 'cdp';
}

/**
 * For scenarios that need a genuinely visible tab (drag): throw an environment error
 * when it isn't interactive, worded so it's obvious at a glance that this isn't a code
 * regression.
 *
 * @param evaluate a way to run a bit of JS in the page
 * @param what what we're doing, goes into the error message
 * @throws {Error} tab is hidden, real mouse movement can't fall back
 */
export async function requireInteractive(evaluate, what) {
  if (await isInteractive(evaluate)) return;
  throw new Error(
    `Environment is not interactive: the tab is hidden (screen locked / RDP disconnected). ${what} needs real mouse movement and cannot fall back -- this is not a code regression.`,
  );
}

/**
 * Bring the tab to the front. Doesn't help when the whole window is covered, but does
 * help when the tab just isn't the active one.
 *
 * @param send CDP's send(method, params)
 */
export async function bringToFront(send) {
  await send('Page.bringToFront').catch(() => {});
}

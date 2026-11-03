// learnings/mail-proton-me/tools/mail-proton-me.mjs
// Read-only Proton Mail web (https://mail.proton.me) tools. Every call opens its OWN background
// tab and drives it through an explicit sessionId (ctx.cdp), never session.use, so the shared REPL
// pointer is left alone. Nothing here sends, deletes, moves, labels or marks.
//
// Facts these tools rely on (verified live):
// - Search is a URL: /u/<slot>/almost-all-mail#keyword=<term>; rows are
//   [data-shortcut-target=item-container], their data-element-id is the CONVERSATION id.
// - A bare /<label>/<conversationId> URL is unreliable (one collapsed message, then an error
//   banner). A row click yields /<label>/<conversationId>/<messageId>, which does load.
// - A hidden background tab never opens a clicked row. Emulation.setFocusEmulationEnabled makes the
//   page report visible+focused without bringing the tab to the front, and a real
//   Input.dispatchMouseEvent click on the row then works for every row.
// - The open message body is an iframe[data-testid=content-iframe] (same origin, readable). Other
//   messages render collapsed with no iframe until their header
//   [data-testid=message-header-collapsed:<n>] is clicked.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = "https://mail.proton.me";
const ROW = "[data-shortcut-target=item-container]";

async function withTab(ctx, fn) {
  const { targetId } = await ctx.session.Target.createTarget({ url: "about:blank", background: true });
  let sessionId;
  try {
    ({ sessionId } = await ctx.session.Target.attachToTarget({ targetId, flatten: true }));
    const call = (method, params = {}) => ctx.cdp(sessionId, method, params);
    const evaluate = async (expression) => {
      const { result, exceptionDetails } = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception || {}).description || "Runtime.evaluate failed");
      return result ? result.value : undefined;
    };
    await call("Page.enable");
    await call("Emulation.setFocusEmulationEnabled", { enabled: true });
    return await fn({ call, evaluate });
  } finally {
    ctx.session.closeTab(targetId, sessionId).catch(() => {});
  }
}

async function poll(evaluate, expression, { timeoutMs = 15000, intervalMs = 750, until = (v) => !!v } = {}) {
  const end = Date.now() + timeoutMs;
  let value;
  while (Date.now() < end) {
    value = await evaluate(expression);
    if (until(value)) return { ok: true, value };
    await wait(intervalMs);
  }
  return { ok: false, value };
}

// Wait until the row count is non-zero and unchanged for two polls (rows arrive in a burst).
async function waitForRows(evaluate, timeoutMs = 15000) {
  const end = Date.now() + timeoutMs;
  let last = -1;
  let stable = 0;
  while (Date.now() < end) {
    const n = await evaluate(`document.querySelectorAll(${JSON.stringify(ROW)}).length`);
    if (n > 0 && n === last) stable++; else stable = 0;
    if (stable >= 2) return n;
    last = n;
    await wait(750);
  }
  return Math.max(last, 0);
}

async function openSearch({ call, evaluate }, slot, term) {
  await call("Page.navigate", { url: `${BASE}/u/${slot}/almost-all-mail#keyword=${encodeURIComponent(term)}` });
  return waitForRows(evaluate);
}

export async function findAccountSlot(ctx, { email, maxSlots = 4 } = {}) {
  if (!email) throw new Error("findAccountSlot: email is required");
  const needle = String(email).toLowerCase();
  return withTab(ctx, async ({ call, evaluate }) => {
    const seen = new Set();
    for (let n = 0; n < maxSlots; n++) {
      await call("Page.navigate", { url: `${BASE}/u/${n}/inbox` });
      const { value } = await poll(evaluate, "JSON.stringify({p: location.pathname, t: document.title})", {
        timeoutMs: 15000,
        until: (v) => { const o = JSON.parse(v); return o.t.includes("Proton Mail") && o.t.includes("@"); },
      });
      const { p, t } = JSON.parse(value);
      const landed = (p.match(/^\/u\/(\d+)\//) || [])[1];
      if (t.toLowerCase().includes(needle)) return { slot: landed === undefined ? n : Number(landed), title: t };
      if (landed !== undefined) seen.add(Number(landed));
    }
    return { stop: "not-found", hint: `no slot under 0..${maxSlots - 1} matched the address; slots reached: ${[...seen].join(",") || "none"}` };
  });
}

export async function searchRows(ctx, { slot = 0, term, limit = 25 } = {}) {
  if (!term) throw new Error("searchRows: term is required");
  return withTab(ctx, async (tab) => {
    const count = await openSearch(tab, slot, term);
    if (!count) return { rows: [], hint: "no result rows within 15s: wrong slot, not logged in, or the search is empty" };
    const rows = JSON.parse(await tab.evaluate(`JSON.stringify([...document.querySelectorAll(${JSON.stringify(ROW)})].slice(0, ${Number(limit)}).map((r, index) => ({
      index, id: r.getAttribute("data-element-id"),
      text: (r.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 200),
    })))`));
    return { rows };
  });
}

// Click row <index> of a search (or load a url returned by an earlier call), expand every
// collapsed message, and return the bodies as plain text.
export async function readConversation(ctx, { slot = 0, term, index = 0, url, maxChars = 1600, maxMessages = 30 } = {}) {
  if (!term && !url) throw new Error("readConversation: term or url is required");
  return withTab(ctx, async ({ call, evaluate }) => {
    if (url) {
      if (!url.startsWith(BASE + "/")) throw new Error("readConversation: url must start with " + BASE + "/");
      await call("Page.navigate", { url });
    } else {
      const count = await openSearch({ call, evaluate }, slot, term);
      if (!count) return { stop: "no-results", hint: "search returned no rows within 15s" };
      if (index >= count) return { stop: "index-out-of-range", rows: count };
      // Real mouse click: element.click() on a row does nothing, and a hidden tab needs focus emulation (set in withTab).
      await evaluate(`document.querySelectorAll(${JSON.stringify(ROW)})[${Number(index)}].scrollIntoView({ block: "center" })`);
      const rect = JSON.parse(await evaluate(`JSON.stringify((() => { const b = document.querySelectorAll(${JSON.stringify(ROW)})[${Number(index)}].getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })())`));
      await call("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
      await call("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
      await call("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", clickCount: 1 });
    }

    const MV = '[data-testid^="message-view-"]';
    const loaded = await poll(evaluate, `document.querySelectorAll('${MV}').length`, { timeoutMs: 20000, until: (n) => n > 0 });
    if (!loaded.ok) return { stop: "conversation-not-loaded", hint: "no message-view-* within 20s" };
    // Let a multi-message conversation finish rendering before counting.
    await poll(evaluate, `document.querySelectorAll('${MV}').length`, { timeoutMs: 4000, intervalMs: 1000, until: () => false });

    const total = await evaluate(`document.querySelectorAll('${MV}').length`);
    const pageUrl = await evaluate("location.href");
    // The first message is already open when the row click worked; expand the rest.
    await evaluate(`[...document.querySelectorAll('[data-testid^="message-header-collapsed:"]')].slice(0, ${Number(maxMessages)}).forEach((h) => h.click())`);
    const want = Math.min(total, Number(maxMessages));
    await poll(evaluate, `[...document.querySelectorAll('iframe[data-testid=content-iframe]')].filter((f) => { try { return f.contentDocument.body.innerText.length > 0; } catch (e) { return false; } }).length`, {
      timeoutMs: 25000, until: (n) => n >= want,
    });

    const messages = JSON.parse(await evaluate(`JSON.stringify([...document.querySelectorAll('${MV}')].map((v, i) => {
      const f = v.querySelector("iframe[data-testid=content-iframe]");
      let body = null;
      try { body = f ? f.contentDocument.body.innerText : null; } catch (e) { body = null; }
      const header = v.querySelector('[data-testid^="message-header-"]');
      return {
        index: Number(v.getAttribute("data-testid").replace("message-view-", "")),
        expanded: !!f,
        header: header ? (header.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 160) : "",
        chars: body === null ? 0 : body.length,
        text: body === null ? "" : body.slice(0, ${Number(maxChars)}),
      };
    }))`));
    const errorBanner = await evaluate('!!document.querySelector("[data-testid=conversation-view\\\\:error-banner-button]")');
    return { url: pageUrl, total, read: messages.filter((m) => m.expanded && m.chars > 0).length, errorBanner, messages };
  });
}

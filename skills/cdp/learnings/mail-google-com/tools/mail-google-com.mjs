// learnings/mail-google-com/tools/mail-google-com.mjs
// Send a Gmail message AS a send-as alias (e.g. a Google Group address) through a prefilled
// compose URL. The From selector is hidden on that view: element.click() and dispatched
// MouseEvents on the option do nothing, only a real Input.dispatchMouseEvent (mouseMoved,
// mousePressed, mouseReleased) at the target's own bounding-rect centre switches the sender.
// Verified live 2026-09-27. Sending is outward and irreversible, so prepareDraftAs stops short
// of Send and hands back a readback; sendPreparedDraft refuses without confirm:true.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// The REPL server is one process shared by every Claude session, and its active-session pointer
// is global, so two sessions driving Gmail steal each other's tab. Attach with an explicit flat
// sessionId and send every Page/DOM/Input/Runtime call to it through ctx.cdp. Target.* calls are
// browser-level and never read the pointer, so they stay on ctx.session.Target. Never move that
// pointer from this file.
async function attachTab(ctx, targetId) {
  const { sessionId } = await ctx.session._call("Target.attachToTarget", { targetId, flatten: true });
  return { sid: sessionId, send: (method, params = {}) => ctx.cdp(sessionId, method, params) };
}

async function evaluate(tab, expression) {
  const { result, exceptionDetails } = await tab.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception || {}).description || "Runtime.evaluate failed");
  return result ? result.value : undefined;
}

// The only click technique that actually moves Gmail's From selector (see header comment).
async function realClick(tab, x, y) {
  await tab.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await tab.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await tab.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

async function clickRect(tab, rect) {
  await realClick(tab, rect.x + rect.width / 2, rect.y + rect.height / 2);
}

export async function findAccountSlot(ctx, { email, maxSlots = 4 } = {}) {
  if (!email) throw new Error("findAccountSlot: email is required");
  const { targetId } = await ctx.session.Target.createTarget({ url: "about:blank", background: true });
  try {
    const tab = await attachTab(ctx, targetId);
    await tab.send("Page.enable");
    for (let n = 0; n < maxSlots; n++) {
      await tab.send("Page.navigate", { url: `https://mail.google.com/mail/u/${n}/` });
      await wait(4000);
      const title = String((await evaluate(tab, "document.title")) || "");
      if (title.includes(email)) return { slot: n, title };
    }
    return { stop: "not-found", hint: `no signed-in slot under 0..${maxSlots - 1} matched ${email}` };
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}

export async function prepareDraftAs(ctx, { authuser = 0, to, subject, body, alias } = {}) {
  if (!to || !subject || !body || !alias) throw new Error("prepareDraftAs: to, subject, body, alias are all required");
  // No body= here: a prefilled body makes Gmail skip the signature, even after the alias switch.
  const url = `https://mail.google.com/mail/u/${authuser}/?view=cm&fs=1` +
    `&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: false });
  const tab = await attachTab(ctx, targetId);
  await wait(6000); // Gmail's compose JS is heavy; a shorter wait sometimes catches an empty from selector.

  const hasFrom = await evaluate(tab, "!!document.querySelector('input[name=from]')");
  if (!hasFrom) return { targetId, stop: "compose-not-loaded" };

  // Step A: click the leaf holding the recipient text (inside the To row) to expand the
  // collapsed header. This is where the From line becomes visible.
  const toRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const needle = ${JSON.stringify(to)};
    const leaf = [...document.querySelectorAll('span,div,td')].find((e) => e.children.length === 0 && (e.textContent || '').includes(needle));
    return leaf ? leaf.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!toRect) return { targetId, stop: "to-row-not-found" };
  await clickRect(tab, toRect);
  await wait(800);

  // ponytail: the From leaf is identified by content (an email-like leaf near the top of the
  // page, not the To leaf itself), not by a hardcoded class name. Ceiling: assumes exactly one
  // such leaf appears above y=200 after the header expands; ratchet the y bound up if a future
  // Gmail layout pushes the From line lower.
  const fromLineRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const toNeedle = ${JSON.stringify(to)};
    const emailLike = /[\\w.+-]+@[\\w.-]+/;
    const leaves = [...document.querySelectorAll('span,div,td')].filter((e) => e.children.length === 0);
    const cand = leaves.find((e) => {
      const t = (e.textContent || '').trim();
      return t && emailLike.test(t) && !t.includes(toNeedle) && e.getBoundingClientRect().top < 200 && e.getBoundingClientRect().width > 0;
    });
    return cand ? cand.getBoundingClientRect() : null;
  })())`)) || "null");
  if (fromLineRect) {
    // Step B: real-click the From line to open its menu.
    await clickRect(tab, fromLineRect);
    await wait(600);

    // Step C: pick the alias option. Filter to non-zero-width options only (closed/hidden
    // menu copies of the same items exist in the DOM with width 0).
    const optionRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
      const alias = ${JSON.stringify(alias)};
      const opts = [...document.querySelectorAll('[role=menuitem],[role=option]')]
        .filter((el) => (el.textContent || '').includes(alias) && el.getBoundingClientRect().width > 0);
      return opts[0] ? opts[0].getBoundingClientRect() : null;
    })())`)) || "null");
    if (!optionRect) return { targetId, stop: "alias-option-not-found" };
    await clickRect(tab, optionRect);
  } else {
    // The header did not expand (seen 2026-10-09 on a send-as alias). A synthetic
    // mousedown/mouseup/click on the hidden option still switched From; the check below guards it.
    await evaluate(tab, `(() => {
      const o = [...document.querySelectorAll('[role=menuitem],[role=option]')].find((e) => (e.textContent || '').includes(${JSON.stringify(alias)}));
      if (o) ["mousedown", "mouseup", "click"].forEach((t) => o.dispatchEvent(new MouseEvent(t, { bubbles: true })));
    })()`);
  }
  await wait(600);

  const fromValues = JSON.parse((await evaluate(tab, "JSON.stringify([...document.querySelectorAll('input[name=from]')].map((x) => x.value))")) || "[]");
  const subjectValue = String((await evaluate(tab, "(document.querySelector('input[name=subjectbox]') || {}).value || ''")) || "");
  if (!fromValues.some((v) => v.includes(alias))) return { targetId, stop: "alias-not-selected", from: fromValues };

  // The alias switch swaps in that alias's default signature; write the body above it.
  await wait(1500);
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const html = `<div>${body.split("\n").map((l) => (l ? esc(l) : "<br>")).join("</div><div>")}</div>`;
  await setBodyAboveSignature(ctx, { targetId, html });
  const signature = String((await evaluate(tab, `((document.querySelector(${JSON.stringify(SIGNATURE_SELECTOR)}) || {}).innerText || '').replace(/\\s+/g, ' ').trim()`)) || "");

  return { targetId, to, subject: subjectValue || subject, from: fromValues, signature };
}

export async function sendPreparedDraft(ctx, { targetId, confirm } = {}) {
  if (!targetId) throw new Error("sendPreparedDraft: targetId is required");
  if (confirm !== true) return { stop: "confirm-required", hint: "read back prepareDraftAs's {to, subject, from} with the human before sending" };
  const tab = await attachTab(ctx, targetId);
  const sendRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const btn = [...document.querySelectorAll('[role=button]')].find((b) => (b.innerText || '').trim() === 'Send');
    return btn ? btn.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!sendRect) return { stop: "no-send-button" };
  await clickRect(tab, sendRect);
  await wait(3000);
  const stillOpen = await evaluate(tab, "!!document.querySelector('input[name=from]')");
  return stillOpen ? { stop: "compose-still-open-after-send" } : { sent: true };
}

export async function verifySent(ctx, { authuser = 0, recipient, days = 1 } = {}) {
  if (!recipient) throw new Error("verifySent: recipient is required");
  const url = `https://mail.google.com/mail/u/${authuser}/#search/in%3Asent+to%3A${encodeURIComponent(recipient)}+newer_than%3A${days}d`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
  try {
    const tab = await attachTab(ctx, targetId);
    await wait(4000);
    const count = Number((await evaluate(tab, "document.querySelectorAll('tr.zA').length")) || 0);
    return { found: count > 0, count };
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}

const BODY_SELECTOR = 'div[aria-label="Message Body"], div.Am.Al.editable';

// ponytail: attachment names are a heuristic union of the download_url attribute (reliable,
// present on both read and compose attachment chips) and any childless leaf whose text ends in
// a file-extension-shaped suffix (catches names Gmail doesn't expose via download_url). Ceiling:
// the leaf scan is document-wide and can false-positive on domain-like text ("dwarves.foundation")
// -- upgrade path is scoping it to the attachment-chip container once that class is confirmed live.
const ATTACHMENT_NAMES_JS = `
  const names = new Set();
  document.querySelectorAll('[download_url]').forEach((el) => {
    const raw = el.getAttribute('download_url') || '';
    const seg = raw.split(':');
    if (seg[1]) { try { names.add(decodeURIComponent(seg[1])); } catch (e) { names.add(seg[1]); } }
  });
  document.querySelectorAll('*').forEach((el) => {
    if (el.children.length === 0) {
      const t = (el.textContent || '').trim();
      if (/\\.[A-Za-z0-9]{2,5}$/.test(t) && t.length < 100) names.add(t);
    }
  });
`;

// Background-tab rows: innerText comes back empty for every row after the first when the tab
// is not foregrounded (Chrome skips layout for background tabs) -- textContent does not depend
// on layout, so it is the one that works here. Learned live 2026-09-28.
export async function searchRows(ctx, { authuser = 0, query, limit = 25 } = {}) {
  if (!query) throw new Error("searchRows: query is required");
  const url = `https://mail.google.com/mail/u/${authuser}/#search/${encodeURIComponent(query)}`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
  try {
    const tab = await attachTab(ctx, targetId);
    await wait(9000);
    const rows = JSON.parse((await evaluate(tab, `JSON.stringify(
      [...document.querySelectorAll('tr.zA')].slice(0, ${Number(limit) || 25}).map((r) =>
        (r.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200)))`)) || "[]");
    return { rows };
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}

export async function readThread(ctx, { authuser = 0, query, maxChars = 1600 } = {}) {
  if (!query) throw new Error("readThread: query is required");
  const url = `https://mail.google.com/mail/u/${authuser}/#search/${encodeURIComponent(query)}`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
  try {
    const tab = await attachTab(ctx, targetId);
    await wait(9000);

    // Clicking the first row does nothing in a background tab, so read the thread id off the row
    // and navigate the same target straight to the thread URL instead.
    const threadId = await evaluate(tab, `(() => {
      const row = document.querySelector('tr.zA');
      if (!row) return null;
      const el = row.matches('[data-legacy-thread-id]') ? row : row.querySelector('[data-legacy-thread-id]');
      return el ? el.getAttribute('data-legacy-thread-id') : '';
    })()`);
    if (threadId === null || threadId === undefined) return { stop: "no-results", hint: `no rows for query ${query}` };
    if (!threadId) return { stop: "no-thread-id", hint: "first row has no data-legacy-thread-id descendant" };
    await tab.send("Page.enable");
    await tab.send("Page.navigate", { url: `${url}/${encodeURIComponent(threadId)}` });
    await wait(4000);

    const expandRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
      const btn = document.querySelector('[aria-label="Expand all"]');
      return btn ? btn.getBoundingClientRect() : null;
    })())`)) || "null");
    if (expandRect) {
      await clickRect(tab, expandRect);
      await wait(1500);
    }

    const data = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
      ${ATTACHMENT_NAMES_JS}
      const max = ${Number(maxChars) || 1600};
      const messages = [...document.querySelectorAll('div.a3s')].map((m) =>
        (m.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, max));
      const links = [...new Set([...document.querySelectorAll('div.a3s a')]
        .map((a) => a.href)
        .filter((h) => h && !h.includes('mail.google.com')))];
      const seen = new Map();
      document.querySelectorAll('[email]').forEach((el) => {
        const email = el.getAttribute('email');
        if (email && !seen.has(email)) seen.set(email, el.getAttribute('name') || '');
      });
      const recipients = [...seen].map(([email, name]) => ({ email, name }));
      return { attachments: [...names], links, messages, recipients };
    })())`)) || "{}");

    return data;
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}

// Never sends -- Gmail auto-saves an open compose as a draft, so an aborted or failed call
// still leaves recoverable state instead of a stray outbound message.
export async function composeDraft(ctx, { authuser = 0, to = "", cc = "", bcc = "", subject = "", body = "", attachments = [] } = {}) {
  const qs = new URLSearchParams({ view: "cm", fs: "1", to, cc, bcc, su: subject, body }).toString().replace(/\+/g, "%20");
  const url = `https://mail.google.com/mail/u/${authuser}/?${qs}`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: false });
  const tab = await attachTab(ctx, targetId);
  await wait(7000);

  if (attachments.length) {
    await tab.send("DOM.enable");
    const { root } = await tab.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await tab.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file][name=Filedata]" });
    if (!nodeId) return { targetId, stop: "no-file-input" };
    await tab.send("DOM.setFileInputFiles", { nodeId, files: attachments });
    await wait(8000);
  }

  const readback = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    ${ATTACHMENT_NAMES_JS}
    const body = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
    return {
      from: (document.querySelector('input[name=from]') || {}).value || '',
      recipients: [...document.querySelectorAll('[data-hovercard-id]')].map((e) => e.getAttribute('data-hovercard-id')),
      subject: (document.querySelector('input[name=subjectbox]') || {}).value || '',
      attachments: [...names],
      body: body ? body.innerText : '',
    };
  })())`)) || "{}");

  return {
    targetId,
    from: readback.from || "",
    recipients: readback.recipients || [],
    subject: readback.subject || "",
    attachments: readback.attachments || [],
    body: (readback.body || "").slice(0, 200),
  };
}

// Gmail's compose body enforces Trusted Types: a page-script `el.innerHTML = ...` assignment
// throws. Plain-text replacement builds real DOM nodes instead (replaceChildren + <br>
// elements). An HTML fragment (a signature, say) needs a different bypass: CDP's
// DOM.setOuterHTML writes through the DOM domain, not a page-script property assignment, so
// Trusted Types does not see it -- swap a placeholder div in first, then setOuterHTML it.
// Learned live 2026-09-28.
export async function replaceDraftBody(ctx, { targetId, lines, html } = {}) {
  if (!targetId) throw new Error("replaceDraftBody: targetId is required");
  if (!lines && !html) throw new Error("replaceDraftBody: exactly one of lines or html is required");
  const tab = await attachTab(ctx, targetId);

  if (lines) {
    const result = await evaluate(tab, `(() => {
      const body = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
      if (!body) return { stop: "no-body-editable" };
      const parts = ${JSON.stringify(lines)};
      const nodes = [];
      parts.forEach((line, i) => {
        if (i > 0) nodes.push(document.createElement("br"));
        nodes.push(document.createTextNode(line));
      });
      body.replaceChildren(...nodes);
      body.dispatchEvent(new Event("input", { bubbles: true }));
      return { length: body.innerText.length };
    })()`);
    return result;
  }

  const placeholderId = "bh-replace-" + Date.now();
  const placed = await evaluate(tab, `(() => {
    const body = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
    if (!body) return false;
    const ph = document.createElement("div");
    ph.id = ${JSON.stringify(placeholderId)};
    body.replaceChildren(ph);
    return true;
  })()`);
  if (!placed) return { stop: "no-body-editable" };

  await tab.send("DOM.enable");
  const { root } = await tab.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await tab.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${placeholderId}` });
  if (!nodeId) return { stop: "placeholder-not-found" };
  await tab.send("DOM.setOuterHTML", { nodeId, outerHTML: html });

  const length = await evaluate(tab, `(() => {
    const body = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
    if (!body) return 0;
    body.dispatchEvent(new Event("input", { bubbles: true }));
    return body.innerText.length;
  })()`);
  return { length: Number(length) || 0 };
}

const SIGNATURE_SELECTOR = '[data-smartmail=gmail_signature]';

// Open the compose "Insert signature" menu and real-click the item whose text equals name. The
// DOM holds zero-size copies of the menu items, so the visible match is the LAST one. A second
// click on the toolbar button closes an open menu, so an already-open menu is reused.
export async function pickSignature(ctx, { targetId, name } = {}) {
  if (!targetId || !name) throw new Error("pickSignature: targetId and name are required");
  const tab = await attachTab(ctx, targetId);

  const menuOpenJs = `[...document.querySelectorAll('[role=menu]')].some((m) => {
    const r = m.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && /manage signatures/i.test(m.innerText || '');
  })`;

  if (!(await evaluate(tab, menuOpenJs))) {
    const btnRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
      const hits = [...document.querySelectorAll('[aria-label],[data-tooltip]')].filter((e) => {
        const label = (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('data-tooltip') || '');
        const r = e.getBoundingClientRect();
        return /signature/i.test(label) && r.width > 0 && r.height > 0;
      });
      const btn = hits.find((e) => e.getAttribute('role') === 'button') || hits[0];
      return btn ? btn.getBoundingClientRect() : null;
    })())`)) || "null");
    if (!btnRect) return { stop: "no-sig-button" };
    await clickRect(tab, btnRect);
    await pollUntil(tab, menuOpenJs, 3000, 200);
  }

  const itemRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const want = ${JSON.stringify(name)};
    const hits = [...document.querySelectorAll('[role=menu] *')].filter((e) => {
      const r = e.getBoundingClientRect();
      return e.children.length === 0 && (e.textContent || '').trim() === want && r.width > 0 && r.height > 0;
    });
    const hit = hits[hits.length - 1];
    return hit ? hit.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!itemRect) return { stop: "no-signature-item" };
  await clickRect(tab, itemRect);
  await wait(1500);

  const signature = await evaluate(tab, `(() => {
    const body = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
    const sig = body && body.querySelector(${JSON.stringify(SIGNATURE_SELECTOR)});
    return sig ? (sig.innerText || sig.textContent || '').replace(/\\s*\\n\\s*/g, ' ').trim() : '';
  })()`);
  return { signature: String(signature || "") };
}

// Rewrite the body above Gmail's signature block without touching the block itself. Everything
// before the signature's top-level ancestor is removed, a placeholder takes its place, and
// DOM.setOuterHTML fills it (Trusted Types blocks innerHTML, see replaceDraftBody). With no
// signature in the body this is the same as replaceDraftBody html mode.
export async function setBodyAboveSignature(ctx, { targetId, html } = {}) {
  if (!targetId || !html) throw new Error("setBodyAboveSignature: targetId and html are required");
  const tab = await attachTab(ctx, targetId);

  const placeholderId = "bh-above-sig-" + Date.now();
  const state = await evaluate(tab, `(() => {
    const body = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
    if (!body) return "no-body";
    const sig = body.querySelector(${JSON.stringify(SIGNATURE_SELECTOR)});
    if (!sig) return "no-signature";
    let top = sig;
    while (top.parentElement && top.parentElement !== body) top = top.parentElement;
    while (body.firstChild && body.firstChild !== top) body.removeChild(body.firstChild);
    const ph = document.createElement("div");
    ph.id = ${JSON.stringify(placeholderId)};
    body.insertBefore(ph, top);
    return "placed";
  })()`);
  if (state === "no-body") return { stop: "no-body-editable" };
  if (state === "no-signature") return replaceDraftBody(ctx, { targetId, html });

  await tab.send("DOM.enable");
  const { root } = await tab.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await tab.send("DOM.querySelector", { nodeId: root.nodeId, selector: `#${placeholderId}` });
  if (!nodeId) return { stop: "placeholder-not-found" };
  await tab.send("DOM.setOuterHTML", { nodeId, outerHTML: html });

  const length = await evaluate(tab, `(() => {
    const body = document.querySelector(${JSON.stringify(BODY_SELECTOR)});
    if (!body) return 0;
    body.dispatchEvent(new Event("input", { bubbles: true }));
    return body.innerText.length;
  })()`);
  return { length: Number(length) || 0 };
}

// Visible attachment chip names only (zero-size copies skipped), same two sources as
// ATTACHMENT_NAMES_JS.
const VISIBLE_ATTACHMENT_NAMES_JS = `
  const names = new Set();
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  document.querySelectorAll('[download_url]').forEach((el) => {
    if (!shown(el)) return;
    const seg = (el.getAttribute('download_url') || '').split(':');
    if (seg[1]) { try { names.add(decodeURIComponent(seg[1])); } catch (e) { names.add(seg[1]); } }
  });
  document.querySelectorAll('*').forEach((el) => {
    if (el.children.length === 0 && shown(el)) {
      const t = (el.textContent || '').trim();
      if (/\\.[A-Za-z0-9]{2,5}$/.test(t) && t.length < 100) names.add(t);
    }
  });
`;

// Remove every matching attachment chip with real clicks, then attach files. A leftover chip
// happened once, so the caller must read the returned list instead of assuming it is clean.
export async function replaceAttachments(ctx, { targetId, files = [], removeMatch = "\\.(pdf|docx|xlsx)\\b" } = {}) {
  if (!targetId) throw new Error("replaceAttachments: targetId is required");
  const tab = await attachTab(ctx, targetId);

  // A remove control belongs to the nearest ancestor whose text matches removeMatch; the climb
  // stops once an ancestor holds more than one remove control (it is the attachment tray, not a chip).
  const findRemoveRect = `JSON.stringify((() => {
    const re = new RegExp(${JSON.stringify(removeMatch)}, 'i');
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const isRemove = (el) => /^remove/i.test((el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '').trim());
    const controls = [...document.querySelectorAll('[aria-label],[data-tooltip]')].filter((el) => isRemove(el) && shown(el));
    for (const ctl of controls) {
      let node = ctl;
      for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
        if (node !== ctl && controls.filter((c) => node.contains(c)).length > 1) break;
        const text = (node.getAttribute('aria-label') || '') + ' ' + (node.getAttribute('data-tooltip') || '') + ' ' + (node.textContent || '');
        if (re.test(text)) return ctl.getBoundingClientRect();
      }
    }
    return null;
  })())`;

  for (let n = 0; n < 30; n++) {
    const rect = JSON.parse((await evaluate(tab, findRemoveRect)) || "null");
    if (!rect) break;
    await clickRect(tab, rect);
    await wait(800);
  }

  if (files.length) {
    await tab.send("DOM.enable");
    const { root } = await tab.send("DOM.getDocument", { depth: -1, pierce: true });
    const { nodeId } = await tab.send("DOM.querySelector", { nodeId: root.nodeId, selector: "input[type=file][name=Filedata]" });
    if (!nodeId) return { stop: "no-file-input" };
    await tab.send("DOM.setFileInputFiles", { nodeId, files });
    await wait(8000);
  }

  const attachments = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    ${VISIBLE_ATTACHMENT_NAMES_JS}
    return [...names];
  })())`)) || "[]");
  return { attachments };
}

// A DOM-only body edit never triggers Gmail's autosave. A real keystroke in the subject box
// does: type a space, delete it, wait out the save debounce.
export async function saveDraftNow(ctx, { targetId } = {}) {
  if (!targetId) throw new Error("saveDraftNow: targetId is required");
  const tab = await attachTab(ctx, targetId);
  const focused = await evaluate(tab, `(() => {
    const box = document.querySelector('input[name=subjectbox]');
    if (!box) return false;
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    return true;
  })()`);
  if (!focused) return { stop: "no-subject-box" };

  await tab.send("Input.insertText", { text: " " });
  const key = { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 };
  await tab.send("Input.dispatchKeyEvent", { type: "keyDown", ...key });
  await tab.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
  await wait(6000);

  const subject = await evaluate(tab, "(document.querySelector('input[name=subjectbox]') || {}).value || ''");
  return { subject: String(subject || "") };
}

// Reply to / forward an existing thread with an inline compose. Both verbs share one flow
// (composeInThread) and never send: Gmail keeps the open compose as a draft.
// Recipe facts: the target is opened in the background (same search + thread-id navigation as
// readThread, since clicking a row does nothing there) and then activated, because Input.insertText
// into a background tab lands late. Reply/Forward need a REAL mouse click after scrollIntoView.
// Cmd+Shift+C opens and focuses Cc. Trusted Types blocks innerHTML, so the body is built from DOM
// nodes and bolded with a Range + execCommand. The signature strip skips anything inside
// .gmail_quote, otherwise a forward would lose the ORIGINAL sender's signature too.
const COMPOSE_EDITOR = 'div[aria-label="Message Body"][contenteditable=true]';
const SIGNATURE_NODES = ".gmail_signature, [data-smartmail=gmail_signature], .gmail_signature_prefix";

// Last visible editor wins: a thread can hold a stale hidden editor and the fresh compose is last.
const COMPOSE_EDITOR_JS = `
  const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const editors = [...document.querySelectorAll(${JSON.stringify(COMPOSE_EDITOR)})].filter(shown);
  const ed = editors[editors.length - 1];
`;

async function pressKey(tab, { key, code, vk, modifiers = 0 }) {
  for (const type of ["keyDown", "keyUp"]) {
    await tab.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk, modifiers });
  }
}

const addressList = (s) => String(s || "").split(",").map((a) => a.trim()).filter(Boolean).join(", ");

async function openThreadForCompose(ctx, { authuser, query }) {
  const url = `https://mail.google.com/mail/u/${authuser}/#search/${encodeURIComponent(query)}`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
  const tab = await attachTab(ctx, targetId);
  await wait(9000);
  const threadId = await evaluate(tab, `(() => {
    const row = document.querySelector('tr.zA');
    if (!row) return null;
    const el = row.matches('[data-legacy-thread-id]') ? row : row.querySelector('[data-legacy-thread-id]');
    return el ? el.getAttribute('data-legacy-thread-id') : '';
  })()`);
  const fail = (stop, hint) => {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
    return { stop, hint };
  };
  if (threadId === null || threadId === undefined) return fail("no-results", `no rows for query ${query}`);
  if (!threadId) return fail("no-thread-id", "first row has no data-legacy-thread-id descendant");
  await tab.send("Page.enable");
  await tab.send("Page.navigate", { url: `${url}/${encodeURIComponent(threadId)}` });
  await wait(4000);
  // Kept on purpose: Input.insertText into a background tab lands late (the reply/forward body
  // and Cc typing depend on it), and this is the only call that foregrounds the tab. Runs only
  // for the compose verbs; the read-only verbs never activate a target.
  await ctx.session.Target.activateTarget({ targetId });
  await wait(1500);
  return { targetId, tab };
}

// Real-click the LAST visible match of a selector (the bottom-of-thread action button) after scrollIntoView.
async function clickLastVisible(tab, selector) {
  const rect = JSON.parse(String(await evaluate(tab, `String(JSON.stringify((() => {
    const hits = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const el = hits[hits.length - 1];
    if (!el) return null;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    return el.getBoundingClientRect();
  })()))`)) || "null");
  if (!rect) return false;
  // Gmail renders "Suggested reply" a beat after the thread, which pushes the action buttons
  // down; re-read the rect once the layout settles so the click lands on the button.
  await wait(800);
  const settled = JSON.parse(String(await evaluate(tab, `String(JSON.stringify((() => {
    const hits = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    const el = hits[hits.length - 1];
    return el ? el.getBoundingClientRect() : null;
  })()))`)) || "null");
  await clickRect(tab, settled || rect);
  return true;
}

async function openCc(tab, cc) {
  await pressKey(tab, { key: "C", code: "KeyC", vk: 67, modifiers: 12 });
  await wait(600);
  await tab.send("Input.insertText", { text: `${addressList(cc)}, ` });
  await wait(600);
}

// Writes lines at the TOP of the editor (above the signature and any quote), optionally strips
// the compose's own signature nodes, and bolds the first occurrence of each substring.
async function writeComposeBody(tab, { lines, bold, stripSignature }) {
  return JSON.parse(String(await evaluate(tab, `String((() => {
    ${COMPOSE_EDITOR_JS}
    if (!ed) return JSON.stringify({ stop: "no-editor" });
    if (${stripSignature ? "true" : "false"}) {
      ed.querySelectorAll(${JSON.stringify(SIGNATURE_NODES)}).forEach((n) => { if (!n.closest('.gmail_quote')) n.remove(); });
    }
    const made = ${JSON.stringify(lines)}.map((line) => {
      const d = document.createElement('div');
      d.appendChild(line ? document.createTextNode(line) : document.createElement('br'));
      return d;
    });
    const first = ed.firstChild;
    made.forEach((d) => ed.insertBefore(d, first));
    const missed = [];
    ed.focus();
    for (const s of ${JSON.stringify(bold)}) {
      let hit = null;
      for (const d of made) {
        const w = document.createTreeWalker(d, NodeFilter.SHOW_TEXT);
        let n;
        while ((n = w.nextNode())) {
          const i = n.nodeValue.indexOf(s);
          if (i >= 0 && !n.parentElement.closest('b,strong')) { hit = [n, i]; break; }
        }
        if (hit) break;
      }
      if (!hit) { missed.push(s); continue; }
      const range = document.createRange();
      range.setStart(hit[0], hit[1]);
      range.setEnd(hit[0], hit[1] + s.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('bold');
    }
    ed.dispatchEvent(new Event('input', { bubbles: true }));
    return JSON.stringify({ written: made.length, missed });
  })())`)) || "{}");
}

async function attachToCompose(tab, files) {
  await tab.send("DOM.enable");
  const { root } = await tab.send("DOM.getDocument", { depth: -1, pierce: true });
  const { nodeIds } = await tab.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "input[type=file][name=Filedata]" });
  if (!nodeIds.length) return false;
  await tab.send("DOM.setFileInputFiles", { nodeId: nodeIds[nodeIds.length - 1], files });
  await wait(8000);
  return true;
}

// Same trick as saveDraftNow, but the keystroke goes into the compose editor (an inline reply
// has no subject box to type into).
async function autosaveCompose(tab) {
  const focused = String(await evaluate(tab, `String((() => {
    ${COMPOSE_EDITOR_JS}
    if (!ed) return false;
    ed.focus();
    const sel = window.getSelection();
    sel.selectAllChildren(ed);
    sel.collapseToEnd();
    return true;
  })())`));
  if (focused !== "true") return false;
  await tab.send("Input.insertText", { text: " " });
  await pressKey(tab, { key: "Backspace", code: "Backspace", vk: 8 });
  await wait(6000);
  return true;
}

async function readComposeBack(tab, expectedNames) {
  return JSON.parse(String(await evaluate(tab, `String((() => {
    ${COMPOSE_EDITOR_JS}
    if (!ed) return JSON.stringify({ stop: "no-editor" });
    // The compose container: nearest ancestor holding a form or the recipient fields, so the
    // thread's own message headers and attachment chips stay out of the readback.
    let box = ed.parentElement || ed;
    for (let a = ed; a.parentElement; a = a.parentElement) {
      if (a.parentElement.matches('form') || a.parentElement.querySelector('[name=to],[name=cc],[name=subjectbox],[name=from]')) { box = a.parentElement; break; }
    }
    const emails = new Set();
    box.querySelectorAll('[data-hovercard-id]').forEach((e) => emails.add(e.getAttribute('data-hovercard-id')));
    box.querySelectorAll('[name=to],[name=cc],[name=bcc]').forEach((f) => {
      (String(f.value || '').match(/[^\\s<>,;"']+@[^\\s<>,;"']+/g) || []).forEach((m) => emails.add(m));
    });
    const text = (box.innerText || box.textContent || '').replace(/\\s+/g, ' ');
    const names = new Set();
    ${JSON.stringify(expectedNames)}.forEach((n) => {
      const esc = n.replace(/[.*+?^$()|[\\]\\\\{}]/g, '\\\\$&');
      if (new RegExp(esc + ' \\\\(\\\\d+K\\\\)').test(text)) names.add(n);
    });
    box.querySelectorAll('[download_url]').forEach((el) => {
      const seg = (el.getAttribute('download_url') || '').split(':');
      if (seg[1]) { try { names.add(decodeURIComponent(seg[1])); } catch (e) { names.add(seg[1]); } }
    });
    const sig = [...ed.querySelectorAll(${JSON.stringify(SIGNATURE_NODES)})].some((n) => !n.closest('.gmail_quote'));
    return JSON.stringify({
      recipients: [...emails],
      body: (ed.innerText || ed.textContent || '').slice(0, 300),
      attachments: [...names],
      signaturePresent: sig,
    });
  })())`)) || "{}");
}

async function composeInThread(ctx, { verb, authuser, query, to, cc, lines, bold, attachments, stripSignature }) {
  const opened = await openThreadForCompose(ctx, { authuser, query });
  if (opened.stop) return opened;
  const { targetId, tab } = opened;

  const buttonSelector = verb === "reply" ? "span.ams.bkH" : "span.ams.bkG";
  if (!(await clickLastVisible(tab, buttonSelector))) return { targetId, stop: `no-${verb}-button` };
  let editorOpen = await pollUntil(tab, `(() => { ${COMPOSE_EDITOR_JS} return !!ed; })()`, 10000, 300);
  if (!editorOpen) {
    // One retry: a late layout shift can still move the button between the read and the click.
    await clickLastVisible(tab, buttonSelector);
    editorOpen = await pollUntil(tab, `(() => { ${COMPOSE_EDITOR_JS} return !!ed; })()`, 10000, 300);
  }
  if (!editorOpen) return { targetId, stop: "compose-not-opened" };
  await wait(1200); // the signature lands a beat after the editor does

  // A forward opens with the To field focused; a reply opens with the caret in the body.
  if (verb === "forward") {
    await tab.send("Input.insertText", { text: `${addressList(to)}, ` });
    await wait(600);
  }
  if (addressList(cc)) await openCc(tab, cc);

  const written = await writeComposeBody(tab, { lines, bold, stripSignature });
  if (written.stop) return { targetId, stop: written.stop };

  if (attachments.length && !(await attachToCompose(tab, attachments))) return { targetId, stop: "no-file-input" };
  if (!(await autosaveCompose(tab))) return { targetId, stop: "no-editor-for-autosave" };

  const names = attachments.map((p) => p.split("/").pop());
  const readback = await readComposeBack(tab, names);
  return { targetId, ...readback, boldMissed: written.missed || [] };
}

export async function replyInThread(ctx, { authuser = 0, query, cc = "", bodyLines, bold = [], attachments = [], stripSignature = false } = {}) {
  if (!query) throw new Error("replyInThread: query is required");
  if (!Array.isArray(bodyLines) || !bodyLines.length) throw new Error("replyInThread: bodyLines (non-empty array) is required");
  return composeInThread(ctx, { verb: "reply", authuser, query, cc, lines: bodyLines, bold, attachments, stripSignature });
}

export async function forwardMessage(ctx, { authuser = 0, query, to, cc = "", noteLines = [], stripSignature = false } = {}) {
  if (!query) throw new Error("forwardMessage: query is required");
  if (!addressList(to)) throw new Error("forwardMessage: to is required");
  return composeInThread(ctx, { verb: "forward", authuser, query, to, cc, lines: noteLines, bold: [], attachments: [], stripSignature });
}

export async function addForwardingAddress(ctx, { authuser = 0, address } = {}) {
  if (!address) throw new Error("addForwardingAddress: address is required");
  const url = `https://mail.google.com/mail/u/${authuser}/#settings/fwdandpop`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: true });
  const tab = await attachTab(ctx, targetId);

  // A background settings tab can take 20-40s to render; poll for the forwarding radios
  // (input[name=sx_em]) instead of a fixed sleep.
  const rendered = await pollUntil(tab, "!!document.querySelector('input[name=sx_em]')", 40000, 1000);
  if (!rendered) return { targetId, stop: "settings-not-rendered" };

  // Always go through the "Add a forwarding address" button. The inline "Forward a copy of
  // incoming mail to" textbox next to it looks like a plain field but typing into it directly
  // auto-selects that radio (forwarding ALL mail, not just this address) as a side effect of its
  // onchange handler, and saving an unverified address entered there fails with
  // "Invalid forwarding address". Leave "Disable forwarding" selected; never touch that textbox.
  const addRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && /add a forwarding address/i.test((e.textContent || '').trim()));
    return el ? el.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!addRect) return { targetId, stop: "add-button-not-found" };
  await clickRect(tab, addRect);
  await wait(800);

  const inputRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const dlg = [...document.querySelectorAll('[role=dialog]')].pop();
    const input = dlg && dlg.querySelector('input[type=text],input[type=email]');
    return input ? input.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!inputRect) return { targetId, stop: "dialog-input-not-found" };
  await clickRect(tab, inputRect);
  await tab.send("Input.insertText", { text: address });
  await wait(300);

  const nextRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const btn = [...document.querySelectorAll('[role=button],button')].find((b) => (b.innerText || b.textContent || '').trim() === 'Next');
    return btn ? btn.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!nextRect) return { targetId, stop: "next-button-not-found" };
  await clickRect(tab, nextRect);

  // Google opens a separate "Verify it's you" challenge target (accounts.google.com) in some
  // sessions and goes straight to emailing a confirmation link (vf-... URL) in others. Poll
  // briefly for the popup target; this verb never answers the challenge itself.
  const before = new Set((await ctx.session.Target.getTargets()).targetInfos.filter((t) => t.type === "page").map((t) => t.targetId));
  const deadline = Date.now() + 8000;
  let popupTargetId = null;
  while (Date.now() < deadline && !popupTargetId) {
    const { targetInfos } = await ctx.session.Target.getTargets();
    const hit = targetInfos.find((t) => t.type === "page" && !before.has(t.targetId) && /accounts\.google\.com/.test(t.url));
    if (hit) popupTargetId = hit.targetId;
    else await wait(500);
  }
  return popupTargetId ? { status: "challenge", targetId, popupTargetId } : { status: "sent", targetId };
}

export async function confirmForwarding(ctx, { verifyUrl } = {}) {
  if (!verifyUrl) throw new Error("confirmForwarding: verifyUrl is required");
  const { targetId } = await ctx.session.Target.createTarget({ url: verifyUrl, background: false });
  const tab = await attachTab(ctx, targetId);
  await wait(3000);

  const confirmRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const btn = [...document.querySelectorAll('[role=button],button')].find((b) => (b.innerText || b.textContent || '').trim() === 'Confirm');
    return btn ? btn.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!confirmRect) return { targetId, stop: "confirm-button-not-found" };
  await clickRect(tab, confirmRect);
  await wait(2000);

  const successText = String((await evaluate(tab, "document.body.innerText.trim().slice(0, 500)")) || "");
  return { targetId, successText };
}

export async function createForwardFilter(ctx, { authuser = 0, query, forwardTo, dryRun = false } = {}) {
  if (!query || !forwardTo) throw new Error("createForwardFilter: query and forwardTo are required");
  const url = `https://mail.google.com/mail/u/${authuser}/#search/${encodeURIComponent(query)}`;
  const { targetId } = await ctx.session.Target.createTarget({ url, background: false });
  const tab = await attachTab(ctx, targetId);
  await wait(5000);

  const advRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const el = document.querySelector('[aria-label="Advanced search options"]');
    return el ? el.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!advRect) return { targetId, stop: "advanced-search-not-found" };
  await clickRect(tab, advRect);
  await wait(1000);

  const createLinkRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === 'Create filter');
    return el ? el.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!createLinkRect) return { targetId, stop: "create-filter-link-not-found" };
  await clickRect(tab, createLinkRect);
  await wait(1000);

  // The "Forward it to:" checkbox is rendered off-screen (x < 0, see header comment); real-click
  // its <label> text instead, which toggles the checkbox via native label-for semantics.
  const fwdLabelRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const el = [...document.querySelectorAll('label')].find((e) => /forward it to/i.test((e.textContent || '').trim()));
    return el ? el.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!fwdLabelRect) return { targetId, stop: "forward-checkbox-not-found" };
  await clickRect(tab, fwdLabelRect);
  await wait(500);

  const listboxRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const label = [...document.querySelectorAll('label')].find((e) => /forward it to/i.test((e.textContent || '').trim()));
    const forId = label && label.getAttribute('for');
    const listbox = forId && document.getElementById(forId).parentElement.querySelector('[role=listbox]');
    return listbox ? listbox.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!listboxRect) return { targetId, stop: "forward-listbox-not-found" };
  await clickRect(tab, listboxRect);
  await wait(500);

  // The listbox's own selected-value node stays put; the real options that open on click are
  // separate, wider (300px) elements elsewhere in the DOM -- filter to those, same trick as the
  // alias picker in prepareDraftAs.
  const optionRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const target = ${JSON.stringify(forwardTo)};
    const opts = [...document.querySelectorAll('[role=option]')].filter((o) => o.getBoundingClientRect().width > 200 && (o.textContent || '').includes(target));
    return opts[0] ? opts[0].getBoundingClientRect() : null;
  })())`)) || "null");
  if (!optionRect) return { targetId, stop: "forward-address-option-not-found", hint: `${forwardTo} is not a verified forwarding address on this account` };
  await clickRect(tab, optionRect);
  await wait(500);

  // Assert exactly the "Forward it to:" checkbox is ticked and the listbox now shows forwardTo
  // before ever touching the Create filter button.
  const state = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const checks = [...document.querySelectorAll('input[type=checkbox]')]
      .map((c) => {
        const lbl = document.querySelector('label[for="' + c.id + '"]');
        return lbl ? { label: lbl.textContent.trim(), checked: c.checked } : null;
      })
      .filter(Boolean);
    const fwdLabel = [...document.querySelectorAll('label')].find((e) => /forward it to/i.test((e.textContent || '').trim()));
    const forId = fwdLabel && fwdLabel.getAttribute('for');
    const listbox = forId && document.getElementById(forId).parentElement.querySelector('[role=listbox]');
    return { checks, listboxText: listbox ? listbox.textContent.trim() : null };
  })())`)) || "null");
  if (!state) return { targetId, stop: "assert-failed" };

  const checkedOnes = state.checks.filter((c) => c.checked);
  const onlyForwardChecked = checkedOnes.length === 1 && /forward it to/i.test(checkedOnes[0].label);
  const listboxHasForwardTo = String(state.listboxText || "").includes(forwardTo);
  if (!onlyForwardChecked || !listboxHasForwardTo) {
    return { targetId, stop: "assert-mismatch", checkedOnes, listboxText: state.listboxText };
  }

  if (dryRun) return { targetId, dryRun: true, checkedOnes, listboxText: state.listboxText };

  // Real mouse events only past this point: a DOM .click() has no user gesture, and Gmail's
  // "verify it's you" confirmation for a forwarding filter is then silently blocked.
  const createBtnRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === 'Create filter');
    const btn = el && el.closest('button,[role=button]');
    return btn ? btn.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!createBtnRect) return { targetId, stop: "create-filter-button-not-found" };
  await clickRect(tab, createBtnRect);
  await wait(1500);

  const continueRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const el = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && (e.textContent || '').trim() === 'Continue');
    const btn = el && (el.closest('button,[role=button]') || el);
    return btn ? btn.getBoundingClientRect() : null;
  })())`)) || "null");
  if (continueRect) {
    await clickRect(tab, continueRect);
    await wait(1000);
  }

  return { targetId, created: true, checkedOnes, listboxText: state.listboxText };
}

async function pollUntil(tab, expr, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(tab, expr)) return true;
    await wait(intervalMs);
  }
  return false;
}

const SIG_EDITOR = '[contenteditable=true][aria-label=Signature]';

// Open the inbox first (a direct cold load of the settings hash often renders nothing), then the
// general settings, and poll for the signature editor.
async function openSignatureSettings(tab, authuser) {
  await tab.send("Page.navigate", { url: `https://mail.google.com/mail/u/${authuser}/` });
  await wait(6000);
  await tab.send("Page.navigate", { url: `https://mail.google.com/mail/u/${authuser}/#settings/general` });
  return pollUntil(tab, `!!document.querySelector('${SIG_EDITOR}')`, 15000, 500);
}

async function clickByText(tab, text, scope) {
  const rect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const want = ${JSON.stringify(text)};
    const el = [...document.querySelectorAll(${JSON.stringify(scope)})].find((e) => e.children.length === 0 && (e.innerText || '').trim() === want
      && !e.closest('select,[contenteditable]') && e.getBoundingClientRect().width > 0);
    if (el) el.scrollIntoView({ block: 'center' }); // settings rows sit far below the fold; a real click outside the viewport hits nothing
    return el ? el.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!rect) return false;
  await clickRect(tab, rect);
  return true;
}

export async function setSignatureHtml(ctx, { authuser = 0, name, htmlFile, create = false } = {}) {
  if (!name || !htmlFile) throw new Error("setSignatureHtml: name and htmlFile are required");
  const { readFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const hex = readFileSync(htmlFile).toString("hex");

  const { targetId } = await ctx.session.Target.createTarget({ url: "about:blank", background: false });
  const tab = await attachTab(ctx, targetId);
  await tab.send("Page.enable");
  if (!(await openSignatureSettings(tab, authuser))) return { targetId, stop: "settings-not-rendered" };
  await wait(1000);

  if (!(await clickByText(tab, name, "span,div,td"))) {
    if (!create) return { targetId, stop: "signature-not-found" };
    if (!(await clickByText(tab, "Create new", "span,div,button,[role=button]"))) return { targetId, stop: "create-new-not-found" };
    await wait(800);
    const inputRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
      const dlg = [...document.querySelectorAll('[role=dialog]')].pop();
      const input = dlg && dlg.querySelector('input[type=text]');
      return input ? input.getBoundingClientRect() : null;
    })())`)) || "null");
    if (!inputRect) return { targetId, stop: "dialog-input-not-found" };
    await clickRect(tab, { x: inputRect.x, y: inputRect.y, width: inputRect.width, height: inputRect.height });
    await tab.send("Input.insertText", { text: name });
    await wait(300);
    const createRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
      const btn = [...document.querySelectorAll('[role=dialog] button,[role=dialog] [role=button]')].find((b) => (b.innerText || '').trim() === 'Create');
      return btn ? btn.getBoundingClientRect() : null;
    })())`)) || "null");
    if (!createRect) return { targetId, stop: "create-button-not-found" };
    await clickRect(tab, createRect);
    await wait(1500);
  }
  await wait(800);

  // Trusted Types blocks innerHTML/insertHTML, so paste real HTML from the clipboard.
  execFileSync("osascript", ["-e", `set the clipboard to {«class HTML»:«data HTML${hex}», string:"sig"}`]);
  if (!(await evaluate(tab, `(() => { const e = document.querySelector('${SIG_EDITOR}'); if (!e) return false; e.focus(); return true; })()`))) {
    return { targetId, stop: "editor-not-found" };
  }
  for (const command of ["selectAll", "paste"]) {
    for (const type of ["keyDown", "keyUp"]) {
      await tab.send("Input.dispatchKeyEvent", { type, modifiers: 4, commands: [command] });
    }
    await wait(800);
  }

  const saveRect = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const btn = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === 'Save Changes');
    if (btn) btn.scrollIntoView({ block: 'center' });
    return btn ? btn.getBoundingClientRect() : null;
  })())`)) || "null");
  if (!saveRect) return { targetId, stop: "save-button-not-found" };
  await clickRect(tab, saveRect);
  await wait(5000);

  if (!(await openSignatureSettings(tab, authuser))) return { targetId, stop: "settings-not-rendered-after-save" };
  await wait(1000);
  if (!(await clickByText(tab, name, "span,div,td"))) return { targetId, stop: "signature-not-found-after-save" };
  await wait(800);
  const readback = JSON.parse((await evaluate(tab, `JSON.stringify((() => {
    const e = document.querySelector('${SIG_EDITOR}');
    const imgs = [...e.querySelectorAll('img')];
    return { text: (e.innerText || '').slice(0, 300), imgs: imgs.length, imgsLoaded: imgs.filter((i) => i.naturalWidth > 0).length, links: e.querySelectorAll('a').length };
  })())`)) || "{}");
  return { targetId, name, ...readback };
}

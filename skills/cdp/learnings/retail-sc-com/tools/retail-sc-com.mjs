// learnings/retail-sc-com/tools/retail-sc-com.mjs
// Read-only Standard Chartered Singapore retail online banking (https://retail.sc.com/sg/nfs/ibank/*).
// No transfers, no form submits. Every call attaches to the existing tab and sends each CDP call
// with that explicit sessionId (ctx.cdp), never session.use, so the shared REPL pointer is left alone.
//
// Facts these tools rely on (verified live):
// - Every in-app menu link is `javascript: blockUI(); window.location="<page>.htm?r=<session token>"`.
//   Navigate by clicking the menu anchor in-page. A direct Page.navigate to a bare ibank URL has no
//   token and dropped the session to /sg/nfs/login.htm, which needed a fresh OTP login. So this file
//   never calls Page.navigate.
// - The eStatements page is /sg/nfs/ibank/estatement_list_summary.htm. Its PDF anchors look like
//   estatement_download_pdf.htm?estatementSelectIndex=N&documentType=0&a=doDownloadLatestPDFviaKong&r=<token>
//   and return application/octet-stream. An in-page fetch with credentials works while logged in.
// - The URL query carries the session token: results here report the path only, never the query.
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HOST = "retail.sc.com";
const LOGIN_PATH = "/sg/nfs/login.htm";
const ESTATEMENT_PATH = "/sg/nfs/ibank/estatement_list_summary.htm";

async function attachTab(ctx) {
  const { targetInfos } = await ctx.session.Target.getTargets();
  const open = targetInfos.find((t) => t.type === "page" && new URL(t.url || "about:blank").hostname === HOST);
  if (!open) return null;
  const { sessionId } = await ctx.session._call("Target.attachToTarget", { targetId: open.targetId, flatten: true });
  const send = (method, params = {}) => ctx.cdp(sessionId, method, params);
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception || {}).description || "Runtime.evaluate failed");
    return result ? result.value : undefined;
  };
  const detach = () => ctx.session._call("Target.detachFromTarget", { sessionId }).catch(() => {});
  return { targetId: open.targetId, evaluate, detach };
}

async function withTab(ctx, fn) {
  const tab = await attachTab(ctx);
  if (!tab) return { state: "no-tab", hint: `no open tab on ${HOST}; open and log in to retail.sc.com in the browser first` };
  try {
    return await fn(tab);
  } finally {
    await tab.detach();
  }
}

async function poll(evaluate, expression, { timeoutMs = 20000, intervalMs = 500 } = {}) {
  const end = Date.now() + timeoutMs;
  let value;
  while (Date.now() < end) {
    try { value = await evaluate(expression); } catch (e) { value = undefined; /* context destroyed mid-navigation */ }
    if (value) return { ok: true, value };
    await wait(intervalMs);
  }
  return { ok: false, value };
}

export async function status(ctx) {
  return withTab(ctx, async ({ evaluate }) => {
    const path = await evaluate("location.pathname");
    const loggedIn = path !== LOGIN_PATH && path.startsWith("/sg/nfs/ibank/");
    return { state: "tab", path, loggedIn, hint: loggedIn ? undefined : "login page or outside ibank: log in by hand (OTP), then re-run" };
  });
}

// Move to the eStatements page by clicking its menu anchor in-page (carries the session token).
async function ensureEstatementsPage({ evaluate }) {
  const path = await evaluate("location.pathname");
  if (path === ESTATEMENT_PATH) return { ok: true };
  if (path === LOGIN_PATH || !path.startsWith("/sg/nfs/ibank/")) return { ok: false, stop: "not-logged-in", path };
  const clicked = await evaluate(`(() => {
    const a = [...document.querySelectorAll("a")].find((x) => /e-?statements/i.test(x.innerText || x.textContent || ""));
    if (!a) return false;
    a.click();
    return true;
  })()`);
  if (!clicked) return { ok: false, stop: "menu-link-not-found", path };
  const arrived = await poll(evaluate, `location.pathname === ${JSON.stringify(ESTATEMENT_PATH)} && document.readyState === "complete"`);
  if (!arrived.ok) return { ok: false, stop: "page-not-reached", path: await evaluate("location.pathname") };
  return { ok: true };
}

const MONTH = /\d{1,2}\/\d{1,2}\/\d{4}|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*[-/]?\s*\d{2,4}|\d{1,2}\s*[-/]\s*\d{4}|\d{4}\s*[-/]\s*\d{1,2}/i;

// Rows that carry a View PDF anchor. The token in each href stays inside the page.
const ROWS_EXPR = `JSON.stringify([...document.querySelectorAll('a[href*="estatement_download_pdf.htm"]')].map((a, i) => {
  const row = a.closest("tr") || a.closest("li") || a.parentElement;
  const cells = row ? [...row.querySelectorAll("td")].map((c) => (c.innerText || "").replace(/\\s+/g, " ").trim()).filter(Boolean) : [];
  const q = new URL(a.href, location.href).searchParams;
  return {
    anchorIndex: i,
    selectIndex: q.get("estatementSelectIndex"),
    documentType: q.get("documentType"),
    cells,
    rowText: row ? (row.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 200) : "",
  };
}))`;

function describeRow(r) {
  const monthCell = r.cells.find((c) => MONTH.test(c)) || (r.rowText.match(MONTH) || [])[0] || "";
  const typeCell = r.cells.find((c) => c !== monthCell && !/view pdf/i.test(c)) || "";
  return { type: typeCell, month: monthCell.match(MONTH) ? monthCell.match(MONTH)[0] : monthCell };
}

function safeName(s) {
  return String(s).normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|_+$/g, "").slice(0, 80) || "statement";
}

export async function estatements(ctx, { dest } = {}) {
  return withTab(ctx, async ({ evaluate }) => {
    const nav = await ensureEstatementsPage({ evaluate });
    if (!nav.ok) return { stop: nav.stop, path: nav.path, hint: "log in by hand if needed; the tool only clicks in-app menu links and never navigates by URL" };
    const found = await poll(evaluate, `document.querySelectorAll('a[href*="estatement_download_pdf.htm"]').length`);
    if (!found.ok) return { stop: "no-pdf-links", hint: "no View PDF anchors within 20s: empty list or layout changed" };
    const raw = JSON.parse(await evaluate(ROWS_EXPR));
    const rows = raw.map((r) => ({ ...r, ...describeRow(r) }));
    if (!dest) return { count: rows.length, rows };

    const outDir = resolve(dest);
    await mkdir(outDir, { recursive: true });
    const used = new Set();
    const files = [];
    for (const r of rows) {
      // base64 of the PDF comes back to node; the token-bearing href never leaves the page.
      const res = await evaluate(`(async () => {
        const a = document.querySelectorAll('a[href*="estatement_download_pdf.htm"]')[${r.anchorIndex}];
        if (!a) return { error: "anchor-gone" };
        const resp = await fetch(a.href, { credentials: "include" });
        if (!resp.ok) return { error: "http-" + resp.status };
        const blob = await resp.blob();
        const dataUrl = await new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => no(fr.error); fr.readAsDataURL(blob); });
        return { b64: dataUrl.slice(dataUrl.indexOf(",") + 1) };
      })()`);
      if (res.error) { files.push({ type: r.type, month: r.month, error: res.error }); continue; }
      const bytes = Buffer.from(res.b64, "base64");
      let name = `${safeName(r.type)}-${safeName(r.month)}`;
      if (used.has(name)) name += `-${r.selectIndex ?? r.anchorIndex}`;
      used.add(name);
      const path = join(outDir, `${name}.pdf`);
      await writeFile(path, bytes);
      files.push({ path, bytes: bytes.length, isPdf: bytes.subarray(0, 5).toString("latin1") === "%PDF-" });
    }
    return { count: rows.length, files };
  });
}

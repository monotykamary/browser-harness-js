/**
 * REPL-extended agent helpers for browser-harness-js. These exist for things
 * CDP structurally LACKS — never to wrap or hide a CDP method (the SDK's
 * ethos: if Chrome can do it, call it directly). They close over the live
 * `session` set in repl.ts via globalThis (read each call so a reconnect or a
 * different session replaces them transparently).
 *
 *   - drainSignals / attachSignals   : drainable async event queue (dialogs,
 *                                       downloads, navigations, crashes) +
 *                                       the modal-dialog tracker pageInfo() needs.
 *   - pageInfo                       : meta (url/title/viewport) via a timed
 *                                       Runtime.evaluate; surfaces {dialog} or
 *                                       {unresponsive} instead of silently hanging.
 *   - parseLocator / resolveLocator  : turn axView's `loc=role:R["N"]` into a
 *                                       backendDOMNodeId via queryAXTree — survives
 *                                       snapshot rebuilds ([n] refs do not).
 *   - help                           : per-helper usage so the model doesn't reload docs.
 *   - listLearnings / learnings       : registry over skills/cdp/learnings/<domain>/
 *                                       manifest.json — codified per-site tools so
 *                                       the agent stops re-deriving recipes each call.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { readdir, readFile, stat } from 'node:fs/promises';
import type { Session } from './session.ts';

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const LEARNINGS_DIR = join(SKILL_DIR, 'learnings');

function sessionOrThrow(): Session {
  const s = (globalThis as any).session as Session | undefined;
  if (!s) throw new Error('helpers: globalThis.session not initialized — start the REPL first (browser-harness-js).');
  return s;
}

// --- Locators -------------------------------------------------------------
// parseLocator is backslash-free: hand-written scanner with a Set-based char
// class so the file (and pi.write transport) doesn't have to dance around d
// / [ / s regex-literal escapes.
const STOP_CHARS = new Set<string>([
  ' ',
  String.fromCharCode(9),
  String.fromCharCode(10),
  String.fromCharCode(13),
  '[',
  ']',
  '"',
  String.fromCharCode(39),
  String.fromCharCode(96),
]);
const BACKSLASH = String.fromCharCode(92);

function parseLocator(loc: string): { role: string; name?: string } {
  let s = loc.trim();
  if (s.startsWith('loc=')) s = s.slice(4).trim();
  const ROLE_MARKER = 'role:';
  if (!s.startsWith(ROLE_MARKER)) {
    throw new Error('Invalid locator ' + JSON.stringify(loc) + '. Expected role:<role>["<accessibleName>"] (optionally with a loc= prefix).');
  }
  let roleEnd = ROLE_MARKER.length;
  while (roleEnd < s.length && !STOP_CHARS.has(s.charAt(roleEnd))) roleEnd++;
  if (roleEnd === ROLE_MARKER.length) throw new Error('Invalid locator (no role): ' + JSON.stringify(loc));
  const role = s.slice(ROLE_MARKER.length, roleEnd);
  let p = roleEnd;
  while (p < s.length && (s.charAt(p) === ' ' || s.charAt(p) === String.fromCharCode(9))) p++;
  if (p >= s.length) return { role };
  if (s.charAt(p) !== '[' || s.charAt(p + 1) !== '"') {
    throw new Error('Invalid locator (trailing chars after role): ' + JSON.stringify(loc) + ' at offset ' + p);
  }
  let q = p + 2;
  let buf = '';
  while (q < s.length) {
    const ch = s.charAt(q);
    if (ch === BACKSLASH) {
      buf += BACKSLASH + s.charAt(q + 1);
      q += 2;
      continue;
    }
    if (ch === '"') break;
    buf += ch;
    q++;
  }
  if (q >= s.length || s.charAt(q) !== '"') throw new Error('Invalid locator (unterminated name string): ' + JSON.stringify(loc));
  if (s.charAt(q + 1) !== ']') throw new Error('Invalid locator (missing ] after name): ' + JSON.stringify(loc));
  const name = JSON.parse('"' + buf + '"');
  return { role, name };
}

function isLocatorString(ref: number | string): boolean {
  return typeof ref === 'string' && (ref.startsWith('loc=') || ref.startsWith('role:'));
}

async function resolveLocator(loc: string): Promise<number> {
  const session = sessionOrThrow();
  const { role, name } = parseLocator(loc);
  // queryAXTree is the cheap, scoped path. It hangs on some Chromium versions
  // (see interaction-skills/accessibility-tree.md: same hang the doc warns about
  // for the shim path surfaces for the active-session call too in some builds).
  // Race it against a short timeout; on timeout fall through to a full-tree scan.
  try {
    const { root } = await session.domains.DOM.getDocument({});
    const params: any = name != null
      ? { nodeId: root.nodeId, role, accessibleName: name }
      : { nodeId: root.nodeId, role };
    const { nodes } = await Promise.race([
      session.domains.Accessibility.queryAXTree(params),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('queryAXTree timeout')), 3_000)),
    ]);
    const node = (nodes || []).find((n: any) => !n.ignored && n.backendDOMNodeId);
    if (node) return (node as any).backendDOMNodeId as number;
  } catch {
    // queryAXTree failed/timed out — fall through to getFullAXTree scan.
  }
  // Fallback: scan the full AX tree for a node matching (role[, name]).
  // More expensive than queryAXTree (the whole tree, not a subtree scope) but
  // reliable when the served build doesn't answer queryAXTree.
  const { nodes: all } = await session.domains.Accessibility.getFullAXTree({});
  const wantName = name != null;
  const node = (all || []).find((n: any) => {
    if (n.ignored || !n.backendDOMNodeId) return false;
    const r = n.role && n.role.value;
    if (!r || r.toLowerCase() !== role.toLowerCase()) return false;
    if (wantName) {
      const nm = String((n.name && n.name.value) || String.fromCharCode(0)).trim();
      if (nm !== name) return false;
    }
    return true;
  });
  if (!node) {
    throw new Error('No element found for locator ' + JSON.stringify(loc) + ' (scanned ' + (all || []).length + ' AX node(s) via getFullAXTree; role="' + role + '"' + (wantName ? (', name="' + name + '"') : '') + ').');
  }
  return (node as any).backendDOMNodeId as number;
}

// --- Agent signals --------------------------------------------------------
let _signalsAttached = false;
let _sigOff = () => {};
const _signalQueue: string[] = [];
let _lastDialog: { type: string; message: string; defaultPrompt?: string } | undefined;
let _dlName = '';

const SIGNAL_HANDLERS: Record<string, (p: any) => string | null> = {
  'Page.javascriptDialogOpening': (p) => {
    _lastDialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt ?? '' };
    return 'dialog ' + p.type + ': ' + JSON.stringify(p.message);
  },
  'Page.javaScriptDialogClosed': () => { _lastDialog = undefined; return null; },
  'Page.fileChooserOpened': (p) => 'file chooser (' + p.mode + ')',
  'Page.downloadWillBegin': (p) => {
    _dlName = p.suggestedFilename ?? p.url ?? '';
    return 'download start: ' + _dlName;
  },
  'Page.downloadProgress': (p) => p.state === 'inProgress' ? null : 'download ' + p.state + ': ' + _dlName,
  'Page.windowOpen': (p) => 'window.open -> ' + (p.url ?? ''),
  'Page.frameNavigated': (p) => 'navigated -> ' + (p.frame && p.frame.url ? p.frame.url : ''),
  'Target.targetCreated': (p) => 'new ' + (p.targetInfo && p.targetInfo.type ? p.targetInfo.type : 'target') + ': ' + (p.targetInfo && p.targetInfo.url ? p.targetInfo.url : ''),
  'Target.targetDestroyed': (p) => 'target closed: ' + (p.targetInfo && p.targetInfo.url ? p.targetInfo.url : ''),
  'Target.targetCrashed': (p) => 'target CRASHED: ' + (p.targetInfo && p.targetInfo.url ? p.targetInfo.url : ''),
  'Network.loadingFailed': (p) => 'request FAILED (' + p.type + '): ' + p.url + ' [' + (p.errorText ?? '') + ']',
};

function attachSignals(): void {
  if (_signalsAttached) return;
  const session = sessionOrThrow();
  _signalsAttached = true;
  const active = () => session.getActiveSession();
  _sigOff = session.onEvent((method: string, p: any, sid?: string) => {
    if (sid && sid !== active() && method.startsWith('Page.')) return;
    const fn = SIGNAL_HANDLERS[method];
    if (!fn) return;
    try {
      const m = fn(p);
      if (m) _signalQueue.push(m);
    } catch {
      // Never let a subscriber throw into the event loop.
    }
  });
}

function drainSignals(): string[] {
  attachSignals();
  return _signalQueue.splice(0, _signalQueue.length);
}

function detachSignals(): void {
  _sigOff();
  _signalsAttached = false;
  _lastDialog = undefined;
  _signalQueue.length = 0;
}

// --- pageInfo -------------------------------------------------------------
async function pageInfo(opts: { timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
  const session = sessionOrThrow();
  const timeoutMs = opts.timeoutMs ?? 2000;
  const EXPR = 'JSON.stringify({ url: location.href, title: document.title, w: window.innerWidth, h: window.innerHeight, sx: window.scrollX, sy: window.scrollY, pw: document.documentElement ? document.documentElement.clientWidth : 0, ph: document.documentElement ? document.documentElement.clientHeight : 0 })';
  const evalP = session.domains.Runtime.evaluate({ expression: EXPR, returnByValue: true });
  const timeoutP = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('pageInfo timeout after ' + timeoutMs + 'ms')), timeoutMs));
  try {
    const result = (await Promise.race([evalP, timeoutP])) as any;
    if (result && result.exceptionDetails) {
      const e = result.exceptionDetails;
      throw new Error(e.text ?? (e.exception && e.exception.description) ?? 'Runtime.evaluate exception');
    }
    if (result && result.result && result.result.value) return JSON.parse(result.result.value);
    return {};
  } catch {
    if (_lastDialog) return { dialog: _lastDialog };
    return { unresponsive: true, hint: 'Page JS did not respond in time. Likely a blocking modal dialog, a long-running synchronous task, or the page navigated away mid-eval.' };
  }
}

// --- learnings registry ---------------------------------------------------
async function listLearnings(): Promise<string[]> {
  let entries: string[] = [];
  try { entries = await readdir(LEARNINGS_DIR); } catch { return []; }
  const found: string[] = [];
  for (const c of entries) {
    const st = await stat(join(LEARNINGS_DIR, c)).catch(() => null);
    if (st && st.isDirectory()) {
      try { await readFile(join(LEARNINGS_DIR, c, 'manifest.json'), 'utf8'); found.push(c); }
      catch { /* no manifest */ }
    }
  }
  return found.sort();
}

async function loadManifest(domain: string): Promise<any> {
  let text: string;
  try { text = await readFile(join(LEARNINGS_DIR, domain, 'manifest.json'), 'utf8'); }
  catch { throw new Error('learnings: no manifest.json for "' + domain + '" (looked in ' + LEARNINGS_DIR + '/' + domain + '/manifest.json).'); }
  try { return JSON.parse(text); }
  catch (e) { throw new Error('learnings: ' + domain + '/manifest.json is not valid JSON: ' + (e as Error).message); }
}

function ctxForTool(): Record<string, unknown> {
  const g = globalThis as any;
  return {
    session: g.session, cdp: g.cdp, axView: g.axView, axClick: g.axClick, axType: g.axType,
    listPageTargets: g.listPageTargets, parseAxRefs: g.parseAxRefs, parseAxLocators: g.parseAxLocators,
    drainSignals, attachSignals, detachSignals, pageInfo, help, listLearnings, learnings,
  };
}

async function learnings(domain: string, tool?: string, args?: unknown): Promise<unknown> {
  const manifest = await loadManifest(domain);
  if (!tool) {
    return {
      nodeTools: Object.keys(manifest.nodeTools ?? {}),
      browserTools: Object.keys(manifest.browserTools ?? {}),
      notes: manifest.notes ?? [],
    };
  }
  const nodeDecl = manifest.nodeTools ? manifest.nodeTools[tool] : undefined;
  if (nodeDecl) {
    const fileUrl = pathToFileURL(join(LEARNINGS_DIR, domain, nodeDecl.path)).href;
    let mod: any;
    try { mod = await import(fileUrl); }
    catch (e) { throw new Error('learnings: cannot load ' + domain + '/' + nodeDecl.path + ': ' + (e as Error).message); }
    const fn = mod ? mod[nodeDecl.callable] : undefined;
    if (typeof fn !== 'function') {
      throw new Error('learnings: "' + tool + '" expected export "' + nodeDecl.callable + '" from ' + nodeDecl.path + '; found: ' + ((mod && Object.keys(mod).join(', ')) || '(none)'));
    }
    return await fn(ctxForTool(), args);
  }
  const brDecl = manifest.browserTools ? manifest.browserTools[tool] : undefined;
  if (brDecl) {
    const src = await readFile(join(LEARNINGS_DIR, domain, brDecl.path), 'utf8');
    const expr = '(async function(args){ ' + src + '; return typeof ' + brDecl.callable + ' === \'function\' ? await (' + brDecl.callable + ')(args) : ' + brDecl.callable + '; })(' + JSON.stringify(args ?? {}) + ')';
    const r = ((await sessionOrThrow().domains.Runtime.evaluate({ expression: expr, returnByValue: true, awaitPromise: true })) as any);
    if (r && r.exceptionDetails) {
      throw new Error('learnings browser tool "' + tool + '" failed: ' + (r.exceptionDetails.text ?? (r.exceptionDetails.exception && r.exceptionDetails.exception.description) ?? ''));
    }
    return r && r.result ? r.result.value : undefined;
  }
  throw new Error('learnings: "' + tool + '" not declared in ' + domain + '/manifest.json (nodeTools: ' + (Object.keys(manifest.nodeTools ?? {}).join(', ') || 'none') + '; browserTools: ' + (Object.keys(manifest.browserTools ?? {}).join(', ') || 'none') + ').');
}

// --- help -----------------------------------------------------------------
const HELP: Record<string, string> = {
  axView: 'axView(nodes, opts?) -> string. Compress Accessibility.getFullAXTree nodes into a tree with [n] refs -> backendDOMNodeId. opts: { interactive?, refs?, maxDepth?, redactSensitive?, locators? }',
  axDiff: 'axDiff(prev, next) -> string. Structural diff of two axView strings; refs stripped before compare.',
  parseAxRefs: 'parseAxRefs(view) -> Map<refNumber, backendDOMNodeId>. From the trailing # refs -> backendDOMNodeId map.',
  parseAxLocators: 'parseAxLocators(view) -> Map<refNumber, locatorString>. Reads the loc=role:R["N"] field. Locators survive re-snapshots; resolve via axClick(locator).',
  axClick: 'axClick(ref, refs?) -> void. ref = number | "[n]" | role:button["Submit"]. Omit refs when ref is a locator.',
  axType: 'axType(ref, refs, text) -> void. Click-focus ref then Input.insertText. Pass null for refs if ref is a locator.',
  attachSignals: 'attachSignals(). Subscribe once and start buffering CDP signals (dialogs, downloads, navigation, crashes). Idempotent.',
  drainSignals: 'drainSignals() -> string[]. Drain+clear the buffer (auto-attaches on first call). React in priority order: dialog > crash > download > navigation > other.',
  detachSignals: 'detachSignals(). Stop buffering; clear dialog state.',
  pageInfo: 'pageInfo(opts?) -> {url,title,w,h,sx,sy,pw,ph} | {dialog:{type,message,...}} | {unresponsive:true, hint:string}. opts.timeoutMs default 2000. {dialog} when a modal blocks page JS; {unresponsive} if eval hung with no dialog.',
  help: 'help(name?) -> string. This. Call with no arg to list all helpers.',
  listPageTargets: 'listPageTargets() -> PageTarget[]. Filters chrome:// / devtools:// from Target.getTargets.',
  listLearnings: 'listLearnings() -> string[]. Domains under skills/cdp/learnings/.',
  learnings: 'learnings(domain, tool?, args?) -> any. learnings("site") -> {nodeTools, browserTools, notes}. learnings("site", "toolName", args) calls the registered node/browser tool; the tool function receives (ctx, args) where ctx carries session/cdp/axView/axClick/axType/listPageTargets/parseAxRefs/parseAxLocators/drainSignals/pageInfo/help.',
};

function help(name?: string): string {
  const names = Object.keys(HELP).sort();
  if (!name) return 'helpers: ' + names.join(', ');
  return HELP[name] ?? '(no help for "' + name + '". helpers: ' + names.join(', ') + ')';
}

export const extraHelpers = {
  parseLocator,
  isLocatorString,
  resolveLocator,
  attachSignals,
  drainSignals,
  detachSignals,
  pageInfo,
  help,
  listLearnings,
  learnings,
  ctxForTool,
};

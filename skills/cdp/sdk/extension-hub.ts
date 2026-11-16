/**
 * Inbound extension connections. The MV3 service worker dials
 * `ws://127.0.0.1:<port>/extension?id=<instanceId>&label=<label>&v=<version>`;
 * the REPL upgrades that request and registers the socket here.
 * `Session.connect()` prefers this over remote-debugging CDP.
 *
 * One browser can run several copies of the extension: one per Chromium
 * profile (an Ardia space, a Chrome person). Each copy keeps a stable
 * `instanceId` in its own `chrome.storage.local`, so the hub keys clients by
 * it. A reconnect from the same instance replaces its old socket; other
 * instances are left alone. A worker that sends no id (pre-0.14 extension)
 * shares the single `legacy` slot, which keeps the old last-writer-wins rule.
 */
import { WIRE_OPEN, type Wire, type WireListener } from './wire.ts';
import type { TextSocket } from './ws-server.ts';

export type ExtensionHello = { id?: string; label?: string; version?: string };

export type ExtensionInfo = {
  /** Stable per-profile id (or `legacy` for an extension that sends none). */
  id: string;
  /** Human name stored in the profile; set with `browser.labelExtension()`. */
  label?: string;
  /** Extension manifest version. */
  version?: string;
  /** ms since epoch when this socket registered. */
  connectedAt: number;
};

export type ExtensionClient = { readonly info: ExtensionInfo; readonly wire: Wire };

type Waiter = {
  selector?: string;
  resolve: (client: ExtensionClient) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type HubRequest = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

const LEGACY_ID = 'legacy';
const clients = new Map<string, { info: ExtensionInfo; wire: Wire; requests: Map<number, HubRequest> }>();
let waiters: Waiter[] = [];
// Hub-originated requests use negative ids so they never collide with Session's.
let nextHubId = -1;

export function asWire(sock: TextSocket): Wire {
  const listeners: Record<'message' | 'close' | 'error' | 'open', WireListener[]> = {
    message: [],
    close: [],
    error: [],
    open: [],
  };
  sock.onMessage(text => {
    for (const fn of listeners.message) fn({ data: text });
  });
  sock.onClose(() => {
    for (const fn of listeners.close) fn({});
  });
  return {
    get readyState() {
      return sock.readyState;
    },
    send(data: string) {
      sock.send(data);
    },
    close() {
      sock.close();
    },
    addEventListener(type, listener) {
      listeners[type].push(listener);
    },
  };
}

/** Read the worker's identity from the upgrade URL's query string. */
export function helloFromUrl(rawUrl: string | undefined): ExtensionHello {
  const url = new URL(rawUrl ?? '/', 'http://127.0.0.1');
  const clean = (v: string | null, max: number) => {
    const s = (v ?? '').trim();
    return s ? s.slice(0, max) : undefined;
  };
  return {
    id: clean(url.searchParams.get('id'), 128),
    label: clean(url.searchParams.get('label'), 128),
    version: clean(url.searchParams.get('v'), 32),
  };
}

function isOpen(c: { wire: Wire }): boolean {
  return c.wire.readyState === WIRE_OPEN;
}

function openClients(): ExtensionClient[] {
  return [...clients.values()].filter(isOpen).map(c => ({ info: c.info, wire: c.wire }));
}

/** Does `selector` name this instance? Exact id, label (case-insensitive), or a unique-enough id prefix. */
export function matchesExtension(info: ExtensionInfo, selector: string): boolean {
  const s = selector.trim();
  if (!s) return false;
  if (info.id === s) return true;
  if (info.label && info.label.toLowerCase() === s.toLowerCase()) return true;
  return s.length >= 6 && info.id.startsWith(s);
}

function describe(list: ExtensionClient[]): string {
  return list.map(c => `  ${c.info.id}${c.info.label ? ` (${JSON.stringify(c.info.label)})` : ''}`).join('\n');
}

export class AmbiguousExtensionError extends Error {
  readonly extensions: ExtensionInfo[];
  constructor(list: ExtensionClient[], selector?: string) {
    super(
      (selector
        ? `extension selector ${JSON.stringify(selector)} matches ${list.length} connected browser-harness-js extensions`
        : `${list.length} browser-harness-js extensions are connected (one per browser profile / space)`)
      + `; pick one with connect({ extension: '<id or label>' }). See browser.extensions() for what each one has open.\n`
      + describe(list),
    );
    this.name = 'AmbiguousExtensionError';
    this.extensions = list.map(c => c.info);
  }
}

/**
 * The connected instance `selector` names; with no selector, the only
 * connected instance. Throws `AmbiguousExtensionError` rather than guess
 * between profiles. `undefined` when nothing matches yet.
 */
export function getExtension(selector?: string): ExtensionClient | undefined {
  const open = openClients();
  const hits = selector ? open.filter(c => matchesExtension(c.info, selector)) : open;
  if (hits.length > 1) {
    const exact = selector ? hits.filter(c => c.info.id === selector) : [];
    if (exact.length === 1) return exact[0];
    throw new AmbiguousExtensionError(hits, selector);
  }
  return hits[0];
}

export function listExtensions(): ExtensionInfo[] {
  return openClients().map(c => ({ ...c.info }));
}

export function extensionConnected(): boolean {
  return openClients().length > 0;
}

function settleWaiters(): void {
  const keep: Waiter[] = [];
  for (const w of waiters) {
    let client: ExtensionClient | undefined;
    try {
      client = getExtension(w.selector);
    } catch (e) {
      clearTimeout(w.timer);
      w.reject(e as Error);
      continue;
    }
    if (!client) { keep.push(w); continue; }
    clearTimeout(w.timer);
    w.resolve(client);
  }
  waiters = keep;
}

/** Register an inbound worker socket. Replaces only the same instance's previous socket. */
export function setExtensionClient(wire: Wire, hello: ExtensionHello = {}): ExtensionClient {
  const id = hello.id ?? LEGACY_ID;
  const prev = clients.get(id);
  const entry = {
    info: { id, label: hello.label, version: hello.version, connectedAt: Date.now() },
    wire,
    requests: new Map<number, HubRequest>(),
  };
  clients.set(id, entry);
  if (prev && prev.wire !== wire) {
    failRequests(prev, new Error('extension socket replaced'));
    try { prev.wire.close(); } catch { /* ignore */ }
  }
  wire.addEventListener('message', e => {
    let m: any;
    try { m = JSON.parse(String(e.data ?? '')); } catch { return; }
    if (typeof m?.id !== 'number' || m.id >= 0) return;
    const req = entry.requests.get(m.id);
    if (!req) return;
    entry.requests.delete(m.id);
    clearTimeout(req.timer);
    if (m.error) req.reject(new Error(String(m.error.message ?? 'extension error')));
    else req.resolve(m.result);
  });
  wire.addEventListener('close', () => {
    failRequests(entry, new Error('extension socket closed'));
    if (clients.get(id) === entry) clients.delete(id);
  });
  settleWaiters();
  return { info: entry.info, wire };
}

function failRequests(entry: { requests: Map<number, HubRequest> }, err: Error): void {
  for (const [, req] of entry.requests) {
    clearTimeout(req.timer);
    req.reject(err);
  }
  entry.requests.clear();
}

/** Back-compat: the wire of the only (or named) connected instance. */
export function getExtensionClient(selector?: string): Wire | undefined {
  return getExtension(selector)?.wire;
}

export function waitForExtension(timeoutMs: number, selector?: string): Promise<ExtensionClient> {
  let existing: ExtensionClient | undefined;
  try {
    existing = getExtension(selector);
  } catch (e) {
    return Promise.reject(e);
  }
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      selector,
      resolve,
      reject,
      timer: setTimeout(() => {
        waiters = waiters.filter(w => w !== waiter);
        const others = openClients();
        reject(new Error(
          `timed out after ${timeoutMs}ms waiting for the browser-harness-js extension`
          + (selector ? ` ${JSON.stringify(selector)}` : '')
          + (selector && others.length ? `; connected:\n${describe(others)}` : ''),
        ));
      }, timeoutMs),
    };
    waiters.push(waiter);
  });
}

/** Send a hub-owned request (`Extension.*`) to one instance, outside any Session. */
export function extensionRequest(id: string, method: string, params: unknown = {}, timeoutMs = 3_000): Promise<unknown> {
  const entry = clients.get(id);
  if (!entry || !isOpen(entry)) return Promise.reject(new Error(`extension ${id} is not connected`));
  const reqId = nextHubId--;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.requests.delete(reqId);
      reject(new Error(`extension ${id} did not answer ${method} within ${timeoutMs}ms`));
    }, timeoutMs);
    entry.requests.set(reqId, { resolve, reject, timer });
    try {
      entry.wire.send(JSON.stringify({ id: reqId, method, params }));
    } catch (e) {
      entry.requests.delete(reqId);
      clearTimeout(timer);
      reject(e as Error);
    }
  });
}

export type ExtensionDescription = ExtensionInfo & {
  /** Session currently bound to this instance. */
  selected?: boolean;
  tabCount?: number;
  /** Open tabs (http/https/file first), for telling profiles apart. */
  tabs?: Array<{ targetId: string; url: string; title: string; active: boolean }>;
  error?: string;
};

/** Every connected instance with what it has open — enough to tell profiles apart. */
export async function describeExtensions(): Promise<ExtensionDescription[]> {
  return Promise.all(openClients().map(async c => {
    try {
      const r = await extensionRequest(c.info.id, 'Extension.getInfo', {}) as { label?: string; tabCount?: number; tabs?: ExtensionDescription['tabs'] };
      if (typeof r?.label === 'string') c.info.label = r.label || undefined;
      return { ...c.info, tabCount: r?.tabCount, tabs: r?.tabs };
    } catch (e) {
      const error = c.info.id === LEGACY_ID
        ? 'pre-0.14 extension build: reload it at chrome://extensions to get a per-profile id, label and tab listing'
        : (e as Error).message;
      return { ...c.info, error };
    }
  }));
}

/** Name the instance `selector` picks; stored in that profile, so it survives restarts. */
export async function labelExtension(selector: string, label: string): Promise<ExtensionInfo> {
  const client = getExtension(selector);
  if (!client) throw new Error(`no connected browser-harness-js extension matches ${JSON.stringify(selector)}`);
  const clean = String(label ?? '').trim().slice(0, 128);
  const clash = openClients().find(c => c.info.id !== client.info.id && c.info.label?.toLowerCase() === clean.toLowerCase());
  if (clean && clash) throw new Error(`label ${JSON.stringify(clean)} is already used by extension ${clash.info.id}`);
  await extensionRequest(client.info.id, 'Extension.setLabel', { label: clean });
  client.info.label = clean || undefined;
  return { ...client.info };
}

/** Test-only: drop every client and fail any waiters. */
export function resetExtensionHub(): void {
  const prev = [...clients.values()];
  clients.clear();
  const ready = waiters.splice(0);
  for (const w of ready) {
    clearTimeout(w.timer);
    w.reject(new Error('extension hub reset'));
  }
  for (const c of prev) {
    failRequests(c, new Error('extension hub reset'));
    try { c.wire.close(); } catch { /* ignore */ }
  }
}

import { createHash, randomUUID } from 'node:crypto';

export type InteractionScope = { sessionId: string };
export type InteractionSession = {
  _call(method: string, params: unknown, opts: { sessionId: string; expectedGeneration?: number }): Promise<unknown>;
  onEvent?(fn: (method: string, params: any, sessionId?: string) => void): () => void;
  getConnectionGeneration?(): number;
  isConnected?(): boolean;
};
export type InteractionCandidate = {
  id: string;
  role: string;
  label: string;
  operations: string[];
  value?: string;
  checked?: boolean;
  selected?: boolean;
  expanded?: boolean;
  /** Native <select> option labels; `select` takes an index into this list. */
  options?: string[];
  /** Nearest named dialog, grid, group, list, form... around the target, e.g. "dialog: Departure". */
  context?: string;
};
export type InteractionObservation = {
  scope: InteractionScope;
  observationId: string;
  revision: string;
  candidates: InteractionCandidate[];
  url: string;
  title: string;
  truncated: boolean;
  truncation: { elements: boolean; scan: boolean; text: boolean };
};
export type InteractionAction = {
  targetId: string;
  operation: string;
  /** `type`: the complete replacement value. */
  text?: string;
  /** `select`: index into the candidate's `options`. */
  option?: number;
  /** `press` (trusted input only): one of PRESS_KEYS. */
  key?: string;
};
export type InteractionReceipt = {
  status: 'executed' | 'stale' | 'blocked' | 'outcome_unknown';
  reason?: string;
};
/**
 * `synthetic` (default) activates controls through the DOM: `element.click()` and a
 * native value setter plus one `input` event. `trusted` dispatches real CDP mouse and
 * keyboard input at the freshly rechecked element center, which widgets listening for
 * pointer or key events require, and enables `press` and contenteditable typing.
 */
export type InteractionInput = 'synthetic' | 'trusted';
export type InteractionOptions = { allowedOrigins: string[]; input?: InteractionInput };

type Options = { signal?: AbortSignal };
type RecordState = {
  objectId: string;
  generation?: number;
  epoch: symbol;
  frame: string;
  observation: InteractionObservation;
  targets: Map<string, number>;
  consumed: boolean;
  maxElements: number;
};
type PageReceipt =
  | InteractionReceipt
  | { status: 'ready'; input: 'click' | 'type' | 'press'; x: number; y: number };

// Controllers sharing a transport also share scope mutation queues.
type ScopeQueue = { tail: Promise<unknown>; pending: number; transport: Set<Promise<unknown>> };
const scopeQueues = new WeakMap<InteractionSession, Map<string, ScopeQueue>>();
const MAX_SCOPES = 32;
const MAX_PENDING = 32;
const MAX_ORIGINS = 32;
const MAX_ORIGIN_LENGTH = 2048;
const MAX_HANDLE_LENGTH = 256;
const MAX_TEXT_LENGTH = 4096;
const MAX_OPTIONS = 64;
const DEFAULT_ELEMENTS = 64;
const MAX_ELEMENTS = 128;
const DEFAULT_WAIT_MS = 5000;
const MAX_WAIT_MS = 60000;
const WAIT_INTERVAL_MS = 500;
const OPERATIONS = ['click', 'type', 'select', 'press', 'scroll_down', 'scroll_up'];

/** Keys `press` may send, with the CDP key event fields each needs. */
export const PRESS_KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
};

/** Model-neutral, explicit-scope guard; not an authorization boundary for raw CDP. */
export class InteractionController {
  private readonly session: InteractionSession;
  private readonly origins: string[];
  private readonly input: InteractionInput;
  private readonly records = new Map<string, RecordState>();
  private readonly epochs = new Map<string, symbol>();
  private readonly queues: Map<string, ScopeQueue>;
  private waiters = 0;
  private readonly releases = new Set<Promise<unknown>>();
  private readonly lifetime = new AbortController();
  private readonly unsubscribe?: () => void;

  constructor(session: InteractionSession, options: InteractionOptions) {
    const origins = options?.allowedOrigins;
    if (!Array.isArray(origins) || origins.length < 1 || origins.length > MAX_ORIGINS ||
        origins.some(origin => typeof origin !== 'string' || origin.length > MAX_ORIGIN_LENGTH)) {
      throw new Error('allowedOrigins requires 1..32 exact origins, each at most 2048 characters');
    }
    this.origins = [...new Set(origins)];
    for (const origin of this.origins) {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) {
        throw new Error('allowedOrigins must contain exact HTTP(S) origins (no paths, wildcards or credentials)');
      }
    }
    const input = options.input ?? 'synthetic';
    if (input !== 'synthetic' && input !== 'trusted') throw new Error("input must be 'synthetic' or 'trusted'");
    this.input = input;
    this.session = session;
    this.queues = scopeQueues.get(session) ?? new Map();
    scopeQueues.set(session, this.queues);
    this.unsubscribe = session.onEvent?.((method, params, sid) => {
      if (method === 'Session.connectionChanged') {
        this.invalidate();
      } else if (method === 'Target.detachedFromTarget') {
        if (params?.sessionId) this.invalidate({ sessionId: params.sessionId });
      } else if (INVALIDATING_EVENTS.includes(method)) {
        if (sid) this.invalidate({ sessionId: sid });
      }
    });
  }

  invalidate(scope?: InteractionScope): void {
    const ids = scope ? [this.scopeId(scope)] : [...new Set([...this.epochs.keys(), ...this.records.keys()])];
    for (const sid of ids) {
      // Unique snapshot tokens avoid ABA without retaining invalidated scope tombstones.
      this.epochs.delete(sid);
      const record = this.records.get(sid);
      this.records.delete(sid);
      if (record) this.release(sid, record.objectId, record.generation);
    }
  }

  close(): void {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.unsubscribe?.();
    this.invalidate();
  }

  async observe(
    input: { scope: InteractionScope; maxElements?: number },
    options: Options = {},
  ): Promise<InteractionObservation> {
    const sid = this.scopeId(input.scope);
    const max = input.maxElements ?? DEFAULT_ELEMENTS;
    if (!Number.isInteger(max) || max < 1 || max > MAX_ELEMENTS) {
      throw new Error('maxElements must be an integer from 1 to 128');
    }
    const signal = this.signal(options);
    return this.serial(sid, () => this.snapshot(sid, max, signal), signal);
  }

  async act(
    input: { scope: InteractionScope; observationId: string; action: InteractionAction },
    options: Options = {},
  ): Promise<InteractionReceipt> {
    const sid = this.scopeId(input.scope);
    // Copy caller-owned data before queuing; one attempted action consumes the observation.
    const observationId = input.observationId;
    const signal = this.signal(options);
    if (signal.aborted) return { status: 'blocked', reason: 'cancelled' };
    if (typeof observationId !== 'string' || observationId.length > MAX_HANDLE_LENGTH ||
        typeof input.action?.targetId !== 'string' || input.action.targetId.length > MAX_HANDLE_LENGTH) {
      return { status: 'stale', reason: 'unknown_target' };
    }
    const existing = this.records.get(sid);
    if (!existing || existing.consumed || existing.observation.observationId !== observationId ||
        !this.current(sid, existing)) {
      return { status: 'stale', reason: 'observation_expired' };
    }
    // Do not retain arbitrary caller payloads (including unsupported oversized text) in queues.
    const action = this.normalize(input.action);
    let dispatched = false;
    return this.serial<InteractionReceipt>(sid, async () => {
      const record = this.records.get(sid);
      try {
        if (signal.aborted) return { status: 'blocked', reason: 'cancelled' };
        if (!record || record.consumed || record.observation.observationId !== observationId ||
            !this.current(sid, record)) {
          return { status: 'stale', reason: 'observation_expired' };
        }
        record.consumed = true;
        const index = record.targets.get(action.targetId);
        if (index === undefined) return { status: 'stale', reason: 'unknown_target' };
        if (!this.supported(action, record.observation.candidates[index])) {
          return { status: 'blocked', reason: 'unsupported_action' };
        }
        const frame = await this.frame(sid, record.generation, signal);
        if (!this.allowed(frame.url)) return { status: 'blocked', reason: 'origin_denied' };
        if (frame.key !== record.frame || !this.current(sid, record)) {
          return { status: 'stale', reason: 'navigation_or_connection_changed' };
        }
        signal.throwIfAborted();
        // Last host check is synchronous with dispatch. Session's generation fence also forbids auto-reconnect.
        if (!this.current(sid, record)) return { status: 'stale', reason: 'observation_expired' };
        dispatched = true;
        const result = await this.call(sid, 'Runtime.callFunctionOn', {
          objectId: record.objectId,
          functionDeclaration: 'function(index, operation, payload, trusted) { return this.act(index, operation, payload, trusted); }',
          arguments: [
            { value: index },
            { value: action.operation },
            { value: action.payload ?? '' },
            { value: this.input === 'trusted' },
          ],
          returnByValue: true,
        }, record.generation, signal);
        let receipt = this.value(result) as PageReceipt;
        if (receipt?.status === 'ready') {
          if (this.input !== 'trusted') throw new Error('Unexpected trusted receipt');
          // The page rechecked the target at this point; dispatch without another round trip.
          await this.dispatchInput(sid, record.generation, receipt, action, signal);
          receipt = { status: 'executed', reason: 'dispatched_not_verified' };
        }
        if (!['executed', 'stale', 'blocked'].includes(receipt?.status)) throw new Error('Invalid action receipt');
        // Navigation may be a legitimate effect. Never turn a dispatched action into a retryable stale receipt.
        if (!this.current(sid, record) || signal.aborted) {
          return { status: 'outcome_unknown', reason: 'changed_during_dispatch' };
        }
        return receipt as InteractionReceipt;
      } catch {
        if (dispatched) return { status: 'outcome_unknown', reason: 'dispatch_unconfirmed' };
        return signal.aborted
          ? { status: 'blocked', reason: 'cancelled' }
          : { status: 'stale', reason: 'revalidation_failed' };
      }
    }, signal).catch(() => ({
      status: dispatched ? 'outcome_unknown' : 'blocked',
      reason: signal.aborted ? 'cancelled' : 'capacity_exceeded',
    }));
  }

  async waitForChange(
    input: { scope: InteractionScope; revision: string; timeoutMs?: number },
    options: Options = {},
  ): Promise<{ changed: boolean; observation: InteractionObservation }> {
    const sid = this.scopeId(input.scope);
    const timeout = input.timeoutMs ?? DEFAULT_WAIT_MS;
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > MAX_WAIT_MS) {
      throw new Error('timeoutMs must be from 0 to 60000');
    }
    const signal = this.signal(options);
    signal.throwIfAborted();
    if (typeof input.revision !== 'string' || input.revision.length > MAX_HANDLE_LENGTH) {
      throw new Error('revision must be at most 256 characters');
    }
    if (this.waiters >= MAX_PENDING) throw new Error('Interaction wait capacity exceeded');
    this.waiters++;
    try {
      const max = this.records.get(sid)?.maxElements ?? DEFAULT_ELEMENTS;
      const end = Date.now() + timeout;
      for (;;) {
        const observation = await this.observe({ scope: { sessionId: sid }, maxElements: max }, { signal });
        if (observation.revision !== input.revision) return { changed: true, observation };
        if (Date.now() >= end) return { changed: false, observation };
        await sleep(Math.min(WAIT_INTERVAL_MS, end - Date.now()), signal);
      }
    } finally {
      this.waiters--;
    }
  }

  /** Keeps only the payload the operation uses; anything malformed becomes unsupported. */
  private normalize(action: InteractionAction): { targetId: string; operation: string; payload?: string | number } {
    const { targetId, operation } = action;
    const unsupported = { targetId, operation: '' };
    if (!OPERATIONS.includes(operation)) return unsupported;
    if (operation === 'type') {
      const text = action.text;
      return typeof text === 'string' && text.length <= MAX_TEXT_LENGTH ? { targetId, operation, payload: text } : unsupported;
    }
    if (operation === 'select') {
      const option = action.option;
      return Number.isInteger(option) && option! >= 0 && option! < MAX_OPTIONS ? { targetId, operation, payload: option } : unsupported;
    }
    if (operation === 'press') {
      const key = action.key;
      return this.input === 'trusted' && typeof key === 'string' && Object.hasOwn(PRESS_KEYS, key)
        ? { targetId, operation, payload: key }
        : unsupported;
    }
    return { targetId, operation };
  }

  private supported(
    action: { operation: string; payload?: string | number },
    candidate: InteractionCandidate | undefined,
  ): boolean {
    if (!candidate?.operations.includes(action.operation)) return false;
    if (action.operation === 'select') return (action.payload as number) < (candidate.options?.length ?? 0);
    return true;
  }

  /** Real input at the point the page just revalidated (trusted mode only). */
  private async dispatchInput(
    sid: string,
    generation: number | undefined,
    ready: { input: 'click' | 'type' | 'press'; x: number; y: number },
    action: { payload?: string | number },
    signal: AbortSignal,
  ): Promise<void> {
    const send = (method: string, params: unknown) => this.call(sid, method, params, generation, signal);
    if (ready.input === 'click') {
      if (!Number.isFinite(ready.x) || !Number.isFinite(ready.y)) throw new Error('Invalid click point');
      const point = { x: ready.x, y: ready.y };
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
    } else if (ready.input === 'type') {
      // The page focused the target and selected its whole value; replace it.
      const text = action.payload as string;
      if (text) await send('Input.insertText', { text });
      else await pressKey(send, 'Delete');
    } else {
      await pressKey(send, action.payload as string);
    }
  }

  private scopeId(scope: InteractionScope): string {
    if (!scope || typeof scope.sessionId !== 'string' || !scope.sessionId.trim() ||
        scope.sessionId.length > MAX_HANDLE_LENGTH) {
      throw new Error('Explicit nonempty scope.sessionId of at most 256 characters is required');
    }
    return scope.sessionId;
  }

  private signal(options: Options): AbortSignal {
    return options.signal ? AbortSignal.any([options.signal, this.lifetime.signal]) : this.lifetime.signal;
  }

  private serial<T>(sid: string, task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    let queue = this.queues.get(sid);
    if ((!queue && this.queues.size >= MAX_SCOPES) || (queue && queue.pending >= MAX_PENDING)) {
      return Promise.reject(new Error('Interaction queue capacity exceeded'));
    }
    if (!queue) {
      queue = { tail: Promise.resolve(), pending: 0, transport: new Set() };
      this.queues.set(sid, queue);
    }
    const entry = queue;
    entry.pending++;
    const next = entry.tail.then(task);
    // Cancellation returns promptly, but cannot unlock an unresolved dispatched CDP call.
    // Keep a bounded quarantine until settlement; never replay a late effect.
    entry.tail = next.catch(() => {}).then(async () => {
      await Promise.allSettled([...entry.transport]);
      if (--entry.pending === 0) this.queues.delete(sid);
    });
    return abortable(next, signal);
  }

  private allowed(url: string): boolean {
    try {
      return this.origins.includes(new URL(url).origin);
    } catch {
      return false;
    }
  }

  private current(sid: string, record: RecordState): boolean {
    return !this.lifetime.signal.aborted
      && this.records.get(sid) === record
      && this.epochs.get(sid) === record.epoch
      && record.generation === this.session.getConnectionGeneration?.()
      && this.session.isConnected?.() !== false;
  }

  private async call(
    sid: string,
    method: string,
    params: unknown,
    generation: number | undefined,
    signal: AbortSignal,
  ): Promise<any> {
    signal.throwIfAborted();
    if (this.session.isConnected?.() === false || generation !== this.session.getConnectionGeneration?.()) {
      throw new Error('Connection changed');
    }
    const pending = this.session._call(method, params, { sessionId: sid, expectedGeneration: generation });
    const transport = this.queues.get(sid)!.transport;
    transport.add(pending);
    void pending.then(result => {
      // An aborted evaluate may still allocate a remote guard after snapshot() has unwound.
      if (method === 'Runtime.evaluate' && signal.aborted) {
        const objectId = (result as any)?.result?.objectId;
        if (objectId) this.release(sid, objectId, generation);
      }
    }, () => {}).finally(() => transport.delete(pending));
    return abortable(pending, signal);
  }

  private value(result: any): any {
    if (result?.exceptionDetails || !result?.result || !('value' in result.result)) {
      throw new Error('Guard context unavailable');
    }
    return result.result.value;
  }

  private async frame(sid: string, generation: number | undefined, signal: AbortSignal) {
    const tree = await this.call(sid, 'Page.getFrameTree', {}, generation, signal);
    const frame = tree.frameTree?.frame;
    if (!frame?.id || !frame.loaderId) throw new Error('No committed main frame');
    return {
      id: frame.id as string,
      url: frame.url as string,
      key: JSON.stringify([frame.id, frame.loaderId, frame.url]),
    };
  }

  private release(sid: string, objectId: string, generation?: number): void {
    if (this.session.isConnected?.() === false || generation !== this.session.getConnectionGeneration?.()) return;
    const pending = this.session._call('Runtime.releaseObject', { objectId }, { sessionId: sid, expectedGeneration: generation });
    this.releases.add(pending);
    void pending.catch(() => {}).finally(() => this.releases.delete(pending));
  }

  private async snapshot(sid: string, max: number, signal: AbortSignal): Promise<InteractionObservation> {
    signal.throwIfAborted();
    if ((!this.epochs.has(sid) && this.epochs.size >= MAX_SCOPES) || this.releases.size >= MAX_SCOPES) {
      throw new Error('Interaction retained scope capacity exceeded; invalidate unused scopes');
    }
    this.invalidate({ sessionId: sid });
    const epoch = Symbol();
    this.epochs.set(sid, epoch);
    const generation = this.session.getConnectionGeneration?.();
    let objectId: string | undefined;
    try {
      await this.call(sid, 'Page.enable', {}, generation, signal);
      if (this.input === 'trusted') {
        // Background tabs keep focus and rendering, so focused typing and key presses land.
        await this.call(sid, 'Emulation.setFocusEmulationEnabled', { enabled: true }, generation, signal);
      }
      const frame = await this.frame(sid, generation, signal);
      if (!this.allowed(frame.url)) throw new Error('origin_denied');
      const world = await this.call(sid, 'Page.createIsolatedWorld', {
        frameId: frame.id,
        worldName: 'browser-harness-guard',
      }, generation, signal);
      const evaluated = await this.call(sid, 'Runtime.evaluate', {
        expression: `(${projection})(${JSON.stringify(this.origins)}, ${max}, ${this.input === 'trusted'})`,
        contextId: world.executionContextId,
        objectGroup: 'browser-harness-guard',
        awaitPromise: true,
      }, generation, signal);
      objectId = evaluated.result?.objectId;
      if (!objectId || evaluated.exceptionDetails) throw new Error('Guard context unavailable');
      const data = this.value(await this.call(sid, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function() { return this.snapshot; }',
        returnByValue: true,
      }, generation, signal));
      if (data.denied || !this.allowed(data.url)) throw new Error('origin_denied');
      const after = await this.frame(sid, generation, signal);
      if (after.key !== frame.key || this.epochs.get(sid) !== epoch ||
          generation !== this.session.getConnectionGeneration?.()) {
        throw new Error('Observation changed; reobserve');
      }
      const targets = new Map<string, number>();
      const candidates = data.candidates.map((candidate: Omit<InteractionCandidate, 'id'>, index: number) => {
        const id = randomUUID();
        targets.set(id, index);
        return { ...candidate, id };
      });
      const observation: InteractionObservation = {
        scope: { sessionId: sid },
        observationId: randomUUID(),
        revision: createHash('sha256').update(JSON.stringify([generation, frame.key, data])).digest('hex'),
        candidates,
        url: data.url,
        title: data.title,
        truncated: data.truncated,
        truncation: data.truncation,
      };
      this.records.set(sid, {
        objectId,
        epoch,
        generation,
        frame: frame.key,
        observation: structuredClone(observation),
        targets,
        consumed: false,
        maxElements: max,
      });
      return observation;
    } catch (error) {
      if (objectId) this.release(sid, objectId, generation);
      if (this.epochs.get(sid) === epoch) this.epochs.delete(sid);
      throw error;
    }
  }
}

const INVALIDATING_EVENTS = [
  'Page.frameNavigated',
  'Page.navigatedWithinDocument',
  'Runtime.executionContextsCleared',
  'DOM.documentUpdated',
  'Inspector.detached',
  'Inspector.targetCrashed',
];

async function pressKey(send: (method: string, params: unknown) => Promise<unknown>, name: string): Promise<void> {
  const key = PRESS_KEYS[name];
  if (!key) throw new Error('Unsupported key');
  const fields = { key: name === 'Space' ? ' ' : name, code: key.code, windowsVirtualKeyCode: key.keyCode };
  // keyDown with text also produces the keypress/input a real keystroke would.
  await send('Input.dispatchKeyEvent', key.text ? { type: 'keyDown', ...fields, text: key.text } : { type: 'rawKeyDown', ...fields });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...fields });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

// Runs in a CDP isolated world: page-defined prototypes cannot replace these guards.
// Bounded controls from the document and its open shadow roots, with an explicit role
// allowlist, plus scrollable regions. Not a complete accessibility tree; trusted input
// is opt-in and dispatched by the host.
const projection = String.raw`async function(allowedOrigins, maxElements, trustedInput) {
  const doc = document;
  const url = location.href;
  if (!allowedOrigins.includes(location.origin)) return { snapshot: { denied: true } };

  const LIMITS = {
    label: 256, text: 2048, value: 4096, labels: 8, labelledBy: 8, options: 64, optionLabel: 256,
    attributes: 64, attributeName: 256, attributeValue: 1024, attributeTotal: 8192, fingerprint: 8192, scan: 4096,
    contentNodes: 256, contentDepth: 8, shadowDepth: 8, contextDepth: 32, minScrollHeight: 40,
  };
  const CLICK_ROLES = ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'option', 'treeitem'];
  const TEXT_ROLES = ['textbox', 'searchbox', 'combobox'];
  const CHECKED_ROLES = ['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio'];
  const SELECTED_ROLES = ['option', 'tab', 'treeitem'];
  const TEXT_INPUT_TYPES = ['text', 'search', 'url', 'number'];
  const IDENTITY_ATTRIBUTES = ['id', 'name', 'type', 'href', 'role', 'for', 'form', 'action'];
  const BUTTON_INPUT_TYPES = ['button', 'submit', 'reset', 'checkbox', 'radio'];
  const GROUP_ROLES = ['dialog', 'alertdialog', 'grid', 'group', 'listbox', 'menu', 'menubar', 'tablist',
    'radiogroup', 'region', 'form', 'toolbar', 'tree', 'rowgroup', 'table', 'navigation', 'search', 'list'];
  const IMPLICIT_GROUPS = { DIALOG: 'dialog', FORM: 'form', NAV: 'navigation', TABLE: 'table', FIELDSET: 'group', SECTION: 'region' };
  const SCROLL_ROLES = ['listbox', 'dialog', 'grid', 'region', 'list', 'menu', 'tree', 'tabpanel', 'feed', 'log', 'document'];

  // Composed tree: parents cross open shadow roots, so hidden/inert/disabled ancestors,
  // hit tests and containment hold inside web components too.
  const shadowHost = node => {
    const root = typeof node.getRootNode === 'function' ? node.getRootNode() : null;
    return root && root !== doc && root.host ? root.host : null;
  };
  const composedParent = node => node.parentElement || shadowHost(node);
  const closestComposed = (el, selector) => {
    for (let node = el; node; node = shadowHost(node)) {
      const found = node.closest(selector);
      if (found) return found;
    }
    return null;
  };
  const composedContains = (el, node) => {
    for (let current = node; current; current = composedParent(current)) {
      if (current === el) return true;
    }
    return false;
  };
  const deepHit = (x, y) => {
    let hit = doc.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) {
      const inner = hit.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === hit) break;
      hit = inner;
    }
    return hit;
  };
  // The first sample point (center first) whose hit lands in scope; null if all are
  // covered or offscreen. Trusted input clicks exactly this point.
  const SAMPLE_POINTS = [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75],
    [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  const clearPoint = (rect, scope) => {
    for (const [fx, fy] of SAMPLE_POINTS) {
      const x = rect.x + rect.width * fx;
      const y = rect.y + rect.height * fy;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const hit = deepHit(x, y);
      if (hit && (hit === scope || scope.contains(hit) || composedContains(scope, hit))) return { x, y };
    }
    return null;
  };
  const byId = (el, id) => {
    const root = typeof el.getRootNode === 'function' ? el.getRootNode() : doc;
    return (root && root.getElementById ? root.getElementById(id) : null) ||
      (doc.getElementById ? doc.getElementById(id) : null);
  };

  const refs = [];
  let textTruncated = false;
  const bounded = (value, max) => {
    const text = String(value || '');
    if (text.length > max) textTruncated = true;
    return text.slice(0, max);
  };
  // Oversized evidence is never guessed at: the element is omitted and truncation disclosed.
  const tooLong = (text, max) => {
    if ((text || '').length <= max) return false;
    textTruncated = true;
    return true;
  };

  const sensitiveName = /pass(?:word|code|phrase)?|secret|token|api[\s_-]*key|auth|credential|security|user[\s_-]*name|login|full[\s_-]*name|first[\s_-]*name|last[\s_-]*name|surname|otp|one[\s_-]*time|mfa|2fa|\bpin\b|ssn|social[\s_-]*security|credit|card|cvv|cvc|iban|routing|account|bank|birth|\bdob\b|e[\s_-]*mail|phone|\btel\b|mobile|address|postal|zip/i;
  const secure = el => {
    if (el.type === 'password' || el.hasAttribute('data-private') || el.hasAttribute('data-sensitive')) return true;
    const autocomplete = el.getAttribute('autocomplete') || '';
    if (tooLong(autocomplete, LIMITS.text)) return true;
    const tokens = autocomplete.toLowerCase().split(/\s+/);
    if (tokens.some(token => token.includes('password') || token.startsWith('cc-') || token === 'one-time-code')) return true;
    // Inspect every naming source, not only the winning accessible label. False positives are intentional.
    const names = ['name', 'id', 'aria-label', 'title', 'placeholder'].map(key => el.getAttribute(key) || '');
    if (el.labels && el.labels.length > LIMITS.labels) {
      textTruncated = true;
      return true;
    }
    names.push(autocomplete, el.textContent || '', ...Array.from(el.labels || []).map(label => label.textContent || ''));
    for (const name of names) {
      if (tooLong(name, LIMITS.text)) return true;
      if (sensitiveName.test(name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' '))) return true;
    }
    return false;
  };

  // Native semantics: the implicit role and how the element is operated.
  const native = el => {
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href') ? { role: 'link', kind: 'click' } : null;
    if (tag === 'BUTTON') return { role: 'button', kind: 'click' };
    if (tag === 'TEXTAREA') return { role: 'textbox', kind: 'value' };
    if (tag === 'SELECT') return el.multiple || el.size > 1 ? null : { role: 'combobox', kind: 'select' };
    if (tag !== 'INPUT') return null;
    if (TEXT_INPUT_TYPES.includes(el.type)) return { role: el.type === 'search' ? 'searchbox' : 'textbox', kind: 'value' };
    if (!BUTTON_INPUT_TYPES.includes(el.type)) return null;
    return { role: ['checkbox', 'radio'].includes(el.type) ? el.type : 'button', kind: 'click' };
  };

  // An explicit role must be allowlisted; unknown roles are not guessed at.
  const roleOf = el => {
    const base = native(el);
    const explicit = (el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
    if (!explicit) return base;
    const editable = el.isContentEditable === true;
    if (TEXT_ROLES.includes(explicit)) {
      if (base && base.kind === 'value') return { role: explicit, kind: 'value' };
      if (base && base.kind === 'select') return { role: explicit, kind: 'select' };
      if (editable) return { role: explicit, kind: 'editable' };
      return explicit === 'combobox' ? { role: explicit, kind: 'click' } : null;
    }
    if (CLICK_ROLES.includes(explicit)) return base && base.kind !== 'click' ? null : { role: explicit, kind: 'click' };
    return null;
  };

  // Accessible name, in ARIA precedence: aria-labelledby, aria-label, <label>, then
  // title/placeholder (fields) or content/title (clickable roles). Every source is bounded.
  const labelledBy = el => {
    const ids = (el.getAttribute('aria-labelledby') || '').trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return '';
    if (ids.length > LIMITS.labelledBy) {
      textTruncated = true;
      return null;
    }
    const parts = ids.map(id => byId(el, id)?.textContent || '');
    if (parts.some(part => tooLong(part, LIMITS.text))) return null;
    return parts.join(' ').trim();
  };

  // ARIA name-from-content, bounded: descendants contribute their own aria-labelledby,
  // aria-label or img alt instead of their text, and hidden subtrees contribute nothing.
  // A calendar day rendered as "20" with an aria-label child is named "Sunday, October 20".
  const contentName = el => {
    if (!el.childNodes) return el.textContent || '';
    const parts = [];
    let budget = LIMITS.contentNodes;
    const visit = (node, depth) => {
      if (budget-- <= 0) {
        textTruncated = true;
        return;
      }
      if (node.nodeType === 3) {
        parts.push(node.nodeValue);
        return;
      }
      if (node.nodeType !== 1 || depth > LIMITS.contentDepth) return;
      if (node !== el) {
        const tag = node.tagName;
        if (node.hidden || node.getAttribute('aria-hidden') === 'true' || ['SCRIPT', 'STYLE', 'TEMPLATE'].includes(tag)) return;
        const referenced = node.hasAttribute('aria-labelledby') ? labelledBy(node) : '';
        if (referenced) {
          parts.push(referenced);
          return;
        }
        const aria = (node.getAttribute('aria-label') || '').trim();
        if (aria) {
          parts.push(aria);
          return;
        }
        if (tag === 'IMG') {
          parts.push(node.getAttribute('alt') || '');
          return;
        }
      }
      for (const child of node.childNodes) visit(child, depth + 1);
    };
    visit(el, 0);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };

  // The nearest *named* grouping container: disambiguates repeated labels ("20" in two
  // month grids, "Done" in two dialogs). Unnamed containers are skipped, not guessed.
  const contextOf = el => {
    let node = composedParent(el);
    for (let depth = 0; node && depth < LIMITS.contextDepth; depth++, node = composedParent(node)) {
      const explicit = (node.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
      const role = explicit || IMPLICIT_GROUPS[node.tagName];
      if (!role || !GROUP_ROLES.includes(role)) continue;
      const legend = node.tagName === 'FIELDSET' && node.querySelector ? node.querySelector('legend') : null;
      const name = (labelledBy(node) || node.getAttribute('aria-label') || (legend ? legend.textContent : '') || '').trim();
      if (name && !tooLong(name, LIMITS.text)) return bounded(role + ': ' + name, LIMITS.label);
    }
    return '';
  };

  const semantics = el => {
    if (!(el instanceof HTMLElement) || secure(el) || closestComposed(el, '[data-private], [data-sensitive]')) return null;
    const described = roleOf(el);
    if (!described) return null;
    const { role, kind } = described;
    if (tooLong(el.textContent, LIMITS.text)) return null;
    if (el.labels && (el.labels.length > LIMITS.labels ||
        Array.from(el.labels).some(label => tooLong(label.textContent, LIMITS.text)))) {
      textTruncated = true;
      return null;
    }
    const referenced = labelledBy(el);
    if (referenced === null) return null;
    const labels = el.labels ? Array.from(el.labels).map(label => label.textContent || '').join(' ') : '';
    const textLike = kind === 'value' || kind === 'editable';
    // Fields fall back to title then placeholder; clickable roles are named by their
    // content first, with title only as a last-resort tooltip (ARIA name-from-content).
    const fallback = textLike
      ? el.getAttribute('title') || el.getAttribute('placeholder')
      : contentName(el) || el.getAttribute('title');
    const label = referenced || el.getAttribute('aria-label') || labels || fallback || '';

    const result = { role, label: bounded(label.trim(), LIMITS.label), operations: [] };
    // The untruncated name stays in-page for identity checks: a change past the
    // displayed 256 characters ("... Cancel" -> "... Delete") must still invalidate.
    Object.defineProperty(result, 'fullName', { value: label.trim(), enumerable: false });
    if (kind === 'value') {
      if (tooLong(el.value, LIMITS.value)) return null;
      result.value = el.value;
      if (!el.readOnly) result.operations.push('type');
      if (role === 'combobox') result.operations.push('click');
    } else if (kind === 'editable') {
      if (tooLong(el.textContent, LIMITS.value)) return null;
      result.value = el.textContent || '';
      // A contenteditable value can only be replaced with real text input.
      if (trustedInput) result.operations.push('type');
    } else if (kind === 'select') {
      const options = Array.from(el.options || []);
      if (options.length > LIMITS.options) textTruncated = true;
      result.options = options.slice(0, LIMITS.options).map(option => bounded(option.label || option.text, LIMITS.optionLabel));
      result.value = el.selectedIndex >= 0 && options[el.selectedIndex]
        ? bounded(options[el.selectedIndex].label || options[el.selectedIndex].text, LIMITS.optionLabel)
        : '';
      result.operations.push('select');
    } else {
      result.operations.push('click');
    }
    if (trustedInput && result.operations.length) result.operations.push('press');

    if (CHECKED_ROLES.includes(role)) {
      result.checked = native(el) && ['checkbox', 'radio'].includes(el.type)
        ? !!el.checked
        : el.getAttribute('aria-checked') === 'true';
    }
    if (SELECTED_ROLES.includes(role) && el.hasAttribute('aria-selected')) {
      result.selected = el.getAttribute('aria-selected') === 'true';
    }
    if (el.hasAttribute('aria-expanded')) result.expanded = el.getAttribute('aria-expanded') === 'true';
    const context = contextOf(el);
    if (context) result.context = context;
    return result;
  };

  const isHidden = element => {
    const style = getComputedStyle(element);
    return style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 ||
      element.hidden || element.inert || element.getAttribute('aria-hidden') === 'true';
  };

  const state = el => {
    const semantic = semantics(el);
    if (!semantic || !semantic.operations.length || !el.isConnected || el.ownerDocument !== doc) return null;
    const rect = el.getBoundingClientRect();
    let visible = rect.width > 0 && rect.height > 0 && rect.x + rect.width > 0 && rect.y + rect.height > 0 &&
      rect.x < innerWidth && rect.y < innerHeight;
    for (let parent = el; parent; parent = composedParent(parent)) {
      if (isHidden(parent)) visible = false;
    }
    // A pointer-events:none control (an accessibility overlay over its row) is reached
    // through its own component: a hit inside its parent counts, a foreign overlay does not.
    const passThrough = getComputedStyle(el).pointerEvents === 'none';
    const point = visible ? clearPoint(rect, passThrough ? composedParent(el) || el : el) : null;
    const clear = !!point;
    const x = point ? point.x : rect.x + rect.width / 2;
    const y = point ? point.y : rect.y + rect.height / 2;
    const enabled = !el.matches(':disabled') && !closestComposed(el, '[aria-disabled="true"], [inert]');
    // Bounded internal semantic/value fingerprint, never exposed in observations.
    if (el.attributes.length > LIMITS.attributes) {
      textTruncated = true;
      return null;
    }
    const attrs = Array.from(el.attributes);
    if (attrs.some(a => a.name.length > LIMITS.attributeName || a.value.length > LIMITS.attributeValue) ||
        ('value' in el && tooLong(String(el.value), LIMITS.value))) {
      textTruncated = true;
      return null;
    }
    // Exact local identity, never a sliced fingerprint. Bound even the pre-serialization input.
    if (attrs.reduce((n, a) => n + a.name.length + a.value.length, 0) > LIMITS.attributeTotal) {
      textTruncated = true;
      return null;
    }
    // Identity is what the target means, not how it looks: role, name, operations,
    // value/checked state and identifying attributes. Cosmetic churn (class, style,
    // title tooltips, data-*) and layout shifts do not invalidate a target; trusted
    // input always uses the fresh center, and occlusion is rechecked before effects.
    const parts = [
      el.tagName,
      [semantic.role, semantic.fullName, semantic.operations, semantic.options || null, semantic.checked ?? null],
      el.textContent,
      IDENTITY_ATTRIBUTES.map(name => el.getAttribute(name)),
      'value' in el ? el.value : null,
      'checked' in el ? el.checked : null,
      'selectedIndex' in el ? el.selectedIndex : null,
    ];
    const fingerprint = JSON.stringify(parts);
    if (fingerprint.length > LIMITS.fingerprint) {
      textTruncated = true;
      return null;
    }
    return { semantic, visible, clear, enabled, fingerprint, x, y };
  };

  // Scrolling: the page itself and visible, named (or roled) scroll containers. Their
  // identity is only what they are; the scroll position is reported as a value.
  const scrollOperations = (top, max) => {
    const operations = [];
    if (top > 1) operations.push('scroll_up');
    if (top < max - 1) operations.push('scroll_down');
    return operations;
  };
  const scroller = doc.scrollingElement || null;
  const pageState = () => {
    if (!scroller) return null;
    const max = scroller.scrollHeight - scroller.clientHeight;
    if (max <= 1) return null;
    const semantic = {
      role: 'page',
      label: bounded(doc.title || 'page', LIMITS.label),
      operations: scrollOperations(scroller.scrollTop, max),
      value: Math.round(scroller.scrollTop / max * 100) + '% scrolled',
    };
    return { semantic, visible: true, clear: true, enabled: true, fingerprint: '["page"]', x: innerWidth / 2, y: innerHeight / 2 };
  };
  const scrollState = el => {
    if (!(el instanceof HTMLElement) || el === scroller || el === doc.body) return null;
    if (!(el.scrollHeight > el.clientHeight + 1) || el.clientHeight < LIMITS.minScrollHeight) return null;
    const style = getComputedStyle(el);
    if (!['auto', 'scroll'].includes(style.overflowY)) return null;
    const role = (el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
    const referenced = labelledBy(el);
    if (referenced === null) return null;
    const name = (referenced || el.getAttribute('aria-label') || '').trim();
    if (!name && !SCROLL_ROLES.includes(role)) return null;
    if (tooLong(name, LIMITS.text) || closestComposed(el, '[data-private], [data-sensitive]')) return null;
    const rect = el.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    let visible = rect.width > 0 && rect.height > 0 && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    for (let parent = el; parent; parent = composedParent(parent)) {
      if (isHidden(parent)) visible = false;
    }
    const hit = deepHit(x, y);
    const clear = !!hit && (hit === el || composedContains(el, hit));
    const max = el.scrollHeight - el.clientHeight;
    const semantic = {
      role: role || 'region',
      label: bounded(name, LIMITS.label),
      operations: scrollOperations(el.scrollTop, max),
      value: Math.round(el.scrollTop / max * 100) + '% scrolled',
    };
    const context = contextOf(el);
    if (context) semantic.context = context;
    const fingerprint = JSON.stringify(['scroll', el.tagName, role, name, IDENTITY_ATTRIBUTES.map(key => el.getAttribute(key))]);
    return { semantic, visible, clear, enabled: !closestComposed(el, '[inert]'), fingerprint, x, y };
  };

  // Depth-first over the document and each open shadow root, in document order.
  const walkers = [doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_ELEMENT)];
  const nextNode = () => {
    while (walkers.length) {
      const node = walkers[walkers.length - 1].nextNode();
      if (!node) {
        walkers.pop();
        continue;
      }
      if (node.shadowRoot && walkers.length <= LIMITS.shadowDepth) {
        walkers.push(doc.createTreeWalker(node.shadowRoot, NodeFilter.SHOW_ELEMENT));
      }
      return node;
    }
    return null;
  };
  const page = pageState();
  // The page's scroll candidate always fits: it takes the last slot.
  const capacity = page ? maxElements - 1 : maxElements;
  let scanned = 0;
  let elementsTruncated = false;
  let node;
  while (scanned < LIMITS.scan && (node = nextNode())) {
    scanned++;
    let kind = 'control';
    let current = state(node);
    if (!current) {
      kind = 'scroll';
      current = scrollState(node);
    }
    if (!current || !current.visible || !current.clear || !current.enabled || !current.semantic.operations.length) continue;
    if (refs.length === capacity) {
      elementsTruncated = true;
      break;
    }
    refs.push({ element: node, kind, initial: current });
  }
  if (page && page.semantic.operations.length) refs.push({ element: scroller, kind: 'page', initial: page });
  const truncation = { elements: elementsTruncated, scan: scanned === LIMITS.scan, text: textTruncated };
  // Only SHA-256 digests cross CDP (at most 128 * 64 characters); raw attributes stay in-page.
  // Fail closed when SubtleCrypto is unavailable (e.g. an insecure non-local HTTP context).
  const revisionState = await Promise.all(refs.map(async ref => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ref.initial.fingerprint));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }));
  const snapshot = {
    url: bounded(url, 2048),
    title: bounded(doc.title, 512),
    candidates: refs.map(ref => ref.initial.semantic),
    revisionState,
    truncated: Object.values(truncation).some(Boolean),
    truncation,
  };

  const setValue = (element, text) => {
    const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, text);
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  };
  const selectOption = (element, index) => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex').set.call(element, index);
    element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // Focus the target and select its whole content, so inserted text replaces it.
  const focusForReplacement = element => {
    HTMLElement.prototype.focus.call(element);
    if ('select' in element && typeof element.select === 'function') {
      element.select();
    } else {
      const range = doc.createRange();
      range.selectNodeContents(element);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  };

  let consumed = false;
  return { snapshot, act(index, operation, payload, trusted) {
    if (consumed) return { status: 'stale', reason: 'replayed' };
    consumed = true;
    if (!allowedOrigins.includes(location.origin)) return { status: 'blocked', reason: 'origin_denied' };
    if (document !== doc || location.href !== url) return { status: 'stale', reason: 'navigation' };
    const ref = refs[index];
    if (!ref) return { status: 'stale', reason: 'target_missing' };
    const current = ref.kind === 'page' ? pageState() : ref.kind === 'scroll' ? scrollState(ref.element) : state(ref.element);
    if (!current) return { status: 'stale', reason: 'target_changed' };
    if (!current.enabled || !current.visible || !current.clear) return { status: 'blocked', reason: 'not_interactable' };
    if (current.fingerprint !== ref.initial.fingerprint) return { status: 'stale', reason: 'target_changed' };
    if (!current.semantic.operations.includes(operation)) return { status: 'blocked', reason: 'unsupported_action' };
    const element = ref.element;
    const ready = input => ({ status: 'ready', input, x: current.x, y: current.y });

    if (operation === 'click') {
      if (trusted === true && trustedInput) return ready('click');
      // Synthetic DOM activation, not a trusted pointer event. No scrolling/focus side effects first.
      HTMLElement.prototype.click.call(element);
    } else if (operation === 'type' && typeof payload === 'string' && payload.length <= LIMITS.value) {
      if (trusted === true && trustedInput) {
        focusForReplacement(element);
        return ready('type');
      }
      if (!('value' in element)) return { status: 'blocked', reason: 'unsupported_action' };
      setValue(element, payload);
    } else if (operation === 'select' && Number.isInteger(payload) && payload >= 0 &&
        payload < (current.semantic.options || []).length) {
      selectOption(element, payload);
    } else if (operation === 'press' && trusted === true && trustedInput && typeof payload === 'string') {
      HTMLElement.prototype.focus.call(element);
      return ready('press');
    } else if (operation === 'scroll_down' || operation === 'scroll_up') {
      // Deterministic in both modes: 80% of the visible height, like Page Down.
      const height = ref.kind === 'page' ? innerHeight : element.clientHeight;
      const distance = Math.max(LIMITS.minScrollHeight, Math.round(height * 0.8));
      element.scrollBy(0, operation === 'scroll_down' ? distance : -distance);
    } else {
      return { status: 'blocked', reason: 'unsupported_action' };
    }
    return { status: 'executed', reason: 'dispatched_not_verified' };
  } };
}`;

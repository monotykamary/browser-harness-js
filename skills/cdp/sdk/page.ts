import { randomBytes, randomUUID } from 'node:crypto';
import type { Session } from './session.ts';
import { InteractionController, type InteractionAction, type InteractionObservation, type InteractionReceipt, type InteractionInput } from './interaction.ts';
import { renderAX, snapshotDiff, snapshotLimits, nodeIdentity, roleOf, nameOf, SnapshotLimitError,
  type AXNode, type SnapshotOptions, type SnapshotFrame, type SnapshotRef, type PageSnapshot } from './snapshot.ts';
export type { PageSnapshot, SnapshotOptions } from './snapshot.ts';

export type PageOptions = { sessionId: string; targetId?: string; allowedOrigins: string[]; input?: InteractionInput; timeoutMs?: number; ownsAttachment?: boolean };
export type CallOptions = { signal?: AbortSignal; timeoutMs?: number };
export type ActionOptions = CallOptions & { verify?: (snapshot: PageSnapshot) => boolean };
export type ActionResult = InteractionReceipt & {
  /** null means no goal predicate/read-back was established. Dispatch is not success. */
  verified: boolean | null;
  snapshot?: PageSnapshot;
  observation?: InteractionObservation;
  verificationError?: string;
};
export type RoleOptions = { name?: string; exact?: boolean; context?: string };
type Query = { kind: 'ref'; ref: string; epoch: number } | { kind: 'css'; selector: string; frameId?: string } |
  { kind: 'role'; role: string; options: RoleOptions; frameId?: string };
type Frame = SnapshotFrame & { parentId?: string };
const invalidations = new Set(['Page.frameNavigated', 'Page.navigatedWithinDocument', 'Page.frameDetached',
  'Runtime.executionContextsCleared', 'DOM.documentUpdated', 'Inspector.detached', 'Inspector.targetCrashed']);
const MAX_FRAMES = 64;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const frameKey = (frame: any) => JSON.stringify([frame.id, frame.loaderId, frame.url]);

/** Scope-bound page. No method reads or changes Session's mutable active-target pointer. */
export class Page {
  readonly scope: Readonly<{ sessionId: string }>;
  readonly targetId?: string;
  private readonly session: Session;
  private readonly guard: InteractionController;
  private readonly origins: string[];
  private readonly generation: number;
  private readonly timeoutMs: number;
  private readonly ownsAttachment: boolean;
  private readonly lifetime = new AbortController();
  private readonly off: () => void;
  private readonly childSessions = new Map<string, string>();
  private refs = new Map<string, SnapshotRef>();
  private epoch = 0;
  private snapshotSequence = 0;
  private readonly refNamespace = randomBytes(9).toString('base64url');
  private previous?: { tree: string; keys: Map<string, string>; scope: string };
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closing = false;
  private events: { method: string; detail: string }[] = [];
  private droppedEvents = 0;
  private dialog?: { type: string; message: string };

  constructor(session: Session, options: PageOptions) {
    if (!options?.sessionId || options.sessionId.length > 256) throw new Error('Page requires an explicit sessionId');
    this.guard = new InteractionController(session, { allowedOrigins: options.allowedOrigins, input: options.input ?? 'trusted' });
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      this.guard.close(); throw new Error('timeoutMs must be 1..60000');
    }
    this.session = session;
    this.ownsAttachment = options.ownsAttachment === true;
    this.scope = Object.freeze({ sessionId: options.sessionId });
    this.targetId = options.targetId;
    this.origins = [...options.allowedOrigins];
    this.generation = session.getConnectionGeneration();
    this.off = session.onEvent((method, data: any, sid) => {
      if (method === 'Session.connectionChanged' ||
          (method === 'Target.detachedFromTarget' && data?.sessionId === this.scope.sessionId)) {
        this.invalidate();
        if (!this.closing || method === 'Session.connectionChanged') this.dispose();
        return;
      }
      if (sid !== this.scope.sessionId && ![...this.childSessions.values()].includes(sid ?? '')) return;
      if (invalidations.has(method)) this.invalidate();
      if (method === 'Page.javascriptDialogOpening') this.dialog = { type: String(data.type), message: String(data.message).slice(0, 512) };
      if (method === 'Page.javascriptDialogClosed') this.dialog = undefined;
      if (['Page.javascriptDialogOpening', 'Page.javascriptDialogClosed', 'Page.fileChooserOpened', 'Page.downloadWillBegin',
        'Page.downloadProgress', 'Page.windowOpen', 'Page.frameNavigated', 'Inspector.targetCrashed'].includes(method)) {
        if (this.events.length === 64) { this.events.shift(); this.droppedEvents++; }
        this.events.push({ method, detail: String(data.message ?? data.url ?? data.frame?.url ?? data.state ?? data.mode ?? '').slice(0, 512) });
      }
    });
  }

  get disposed(): boolean { return this.lifetime.signal.aborted; }
  private invalidate(): void { this.epoch++; this.refs.clear(); this.guard.invalidate(); }
  private assertLive(signal: AbortSignal): void {
    signal.throwIfAborted(); this.lifetime.signal.throwIfAborted();
    if (!this.session.isConnected() || this.session.getConnectionGeneration() !== this.generation) throw new Error('Page disconnected; attach again');
  }
  private allowed(frame: any): boolean {
    try {
      const origin = new URL(frame.url).origin;
      return this.origins.includes(origin) ||
        (['about:blank', 'about:srcdoc'].includes(frame.url) && this.origins.includes(frame.securityOrigin));
    } catch { return false; }
  }
  private async call(method: string, params: unknown, signal: AbortSignal, sid = this.scope.sessionId): Promise<any> {
    this.assertLive(signal);
    // Await the actual transport, not just a timeout race: a timed-out queue remains
    // quarantined until its already-dispatched work settles. Every later dispatch checks signal.
    const result: any = await this.session._call(method, params, { sessionId: sid, expectedGeneration: this.generation });
    if (signal.aborted || this.disposed) {
      if (method === 'Target.attachToTarget' && result?.sessionId) {
        await this.session._call('Target.detachFromTarget', { sessionId: result.sessionId }, { expectedGeneration: this.generation }).catch(() => {});
      }
    }
    this.assertLive(signal);
    return result;
  }
  private run<T>(fn: (signal: AbortSignal) => Promise<T>, options: CallOptions = {}): Promise<T> {
    const timeout = options.timeoutMs ?? this.timeoutMs;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) return Promise.reject(new Error('timeoutMs must be 1..60000'));
    if (this.pending >= 32) return Promise.reject(new Error('Page queue capacity exceeded'));
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('Page call timed out')), timeout);
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal, ...(options.signal ? [options.signal] : [])]);
    this.pending++;
    const work = this.tail.then(() => { this.assertLive(signal); return fn(signal); });
    this.tail = work.catch(() => {}).finally(() => { this.pending--; });
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    }).finally(() => clearTimeout(timer));
  }

  /** Consume bounded, per-page browser events. Listening starts when this Page is constructed. */
  signals() { const result = { events: this.events.splice(0), dropped: this.droppedEvents }; this.droppedEvents = 0; return result; }
  async info(options: CallOptions = {}): Promise<Record<string, unknown>> {
    return this.run(async signal => {
      await this.framesInternal(signal);
      if (this.dialog) return { dialog: { ...this.dialog } };
      const result = await this.call('Runtime.evaluate', {
        expression: '({url:location.href,title:document.title.slice(0,512),width:innerWidth,height:innerHeight,scrollX,scrollY})', returnByValue: true,
      }, signal);
      if (result.exceptionDetails) throw new Error('Page information unavailable');
      return result.result.value;
    }, options);
  }

  private async framesInternal(signal: AbortSignal): Promise<{ frames: Frame[]; omissions: string[] }> {
    const { frameTree } = await this.call('Page.getFrameTree', {}, signal);
    if (!frameTree?.frame || !this.allowed(frameTree.frame)) throw new Error('origin_denied');
    const frames: Frame[] = [], omissions: string[] = [];
    const visited = new Set<string>();
    const visit = (entry: any, sid = this.scope.sessionId) => {
      const f = entry.frame;
      if (visited.has(f.id)) return;
      visited.add(f.id);
      // Denied frames (cross-origin ads, trackers) are only listed as omissions and never read,
      // so only readable frames count toward the limit.
      if (!this.allowed(f)) { omissions.push(`frame ${f.id}: origin_denied`); return; }
      if (!f.loaderId) { omissions.push(`frame ${f.id}: not committed`); return; }
      if (frames.length >= MAX_FRAMES) throw new SnapshotLimitError(`Frame count exceeds ${MAX_FRAMES}`);
      frames.push({ frameId: f.id, sessionId: this.childSessions.get(f.id) ?? sid, key: frameKey(f), url: f.url, parentId: f.parentId });
      for (const child of entry.childFrames ?? []) visit(child, sid);
    };
    visit(frameTree);
    if (!frames.length) throw new Error('No committed page');
    // Chrome omits OOPIFs from the parent's Page.getFrameTree. Discover only
    // targets whose frame owner belongs to a renderer already in this page.
    const { targetInfos } = await this.call('Target.getTargets', {}, signal);
    const targets = targetInfos.filter((t: any) => t.type === 'iframe').sort((a: any, b: any) => a.targetId.localeCompare(b.targetId));
    const active = new Set(targets.map((t: any) => t.targetId));
    for (const [id, sid] of this.childSessions) {
      if (active.has(id)) continue;
      this.childSessions.delete(id);
      await this.call('Target.detachFromTarget', { sessionId: sid }, signal).catch(() => {});
    }
    if (targets.length > 128) throw new SnapshotLimitError('Iframe discovery exceeds 128 targets');
    let progress = true;
    while (progress) {
      progress = false;
      for (const target of targets) {
        if (visited.has(target.targetId)) continue;
        let owner: Frame | undefined;
        for (const frame of frames) {
          try {
            await this.call('DOM.getFrameOwner', { frameId: target.targetId }, signal, frame.sessionId);
            owner = frame; break;
          } catch { this.assertLive(signal); }
        }
        if (!owner) continue;
        progress = true;
        if (!this.allowed({ url: target.url })) {
          visited.add(target.targetId); omissions.push(`frame ${target.targetId}: origin_denied`); continue;
        }
        let sid = this.childSessions.get(target.targetId);
        if (!sid) {
          if (this.childSessions.size >= 32) throw new SnapshotLimitError('Owned iframe attachment count exceeds 32');
          const attached = await this.call('Target.attachToTarget', { targetId: target.targetId, flatten: true }, signal);
          sid = attached.sessionId;
          this.childSessions.set(target.targetId, sid!);
        }
        try {
          const child = await this.call('Page.getFrameTree', {}, signal, sid);
          child.frameTree.frame.parentId ??= owner.frameId;
          visit(child.frameTree, sid);
        } catch {
          this.assertLive(signal); visited.add(target.targetId); omissions.push(`frame ${target.targetId}: unavailable`);
        }
      }
    }
    return { frames, omissions };
  }
  frames(options: CallOptions = {}) { return this.run(signal => this.framesInternal(signal), options); }

  private async frameNodes(frame: Frame, signal: AbortSignal): Promise<AXNode[]> {
    try {
      return (await this.call('Accessibility.getFullAXTree', { frameId: frame.frameId }, signal, frame.sessionId)).nodes;
    } catch (error) {
      this.assertLive(signal);
      // OOPIF target IDs equal frame IDs in native CDP. Never guess by URL: two
      // same-URL frames are not interchangeable. Unsupported relays disclose omission.
      if (!frame.parentId || this.childSessions.has(frame.frameId)) throw error;
      const { targetInfos } = await this.call('Target.getTargets', {}, signal);
      const target = targetInfos.find((t: any) => t.type === 'iframe' && t.targetId === frame.frameId);
      if (!target) throw error;
      if (this.childSessions.size >= 32) throw new SnapshotLimitError('Owned iframe attachment count exceeds 32');
      const attached = await this.call('Target.attachToTarget', { targetId: target.targetId, flatten: true }, signal);
      this.childSessions.set(frame.frameId, attached.sessionId);
      frame.sessionId = attached.sessionId;
      return (await this.call('Accessibility.getFullAXTree', { frameId: frame.frameId }, signal, frame.sessionId)).nodes;
    }
  }

  private async selectorNode(selector: string, frame: Frame, signal: AbortSignal): Promise<number> {
    if (!selector || selector.length > 2048) throw new Error('CSS selector must be 1..2048 characters');
    const world = await this.call('Page.createIsolatedWorld', { frameId: frame.frameId, worldName: 'browser-harness-read' }, signal, frame.sessionId);
    const group = `browser-harness-selector-${randomUUID()}`;
    try {
      const result = await this.call('Runtime.evaluate', {
        contextId: world.executionContextId, objectGroup: group,
        expression: `(() => { const found = document.querySelectorAll(${JSON.stringify(selector)}); if (found.length !== 1) throw new Error('Strict locator: ' + found.length + ' matches'); return found[0]; })()`,
      }, signal, frame.sessionId);
      if (result.exceptionDetails || !result.result?.objectId) throw new Error(result.exceptionDetails?.exception?.description ?? 'Strict locator did not resolve');
      const { node } = await this.call('DOM.describeNode', { objectId: result.result.objectId }, signal, frame.sessionId);
      return node.backendNodeId;
    } finally {
      // Release even after cancellation, but never reconnect a stale attachment for cleanup.
      if (this.session.getConnectionGeneration() === this.generation && this.session.isConnected()) {
        await this.session._call('Runtime.releaseObjectGroup', { objectGroup: group }, { sessionId: frame.sessionId, expectedGeneration: this.generation }).catch(() => {});
      }
    }
  }

  snapshot(options: SnapshotOptions & CallOptions = {}): Promise<PageSnapshot> {
    const copy = { ...options };
    return this.run(signal => this.snapshotInternal(copy, signal), copy);
  }
  private async snapshotInternal(options: SnapshotOptions, signal: AbortSignal): Promise<PageSnapshot> {
    const limits = snapshotLimits(options);
    const selected = options.ref !== undefined ? this.refs.get(options.ref) : undefined;
    if (options.ref !== undefined && !selected) throw new Error('stale_ref: take a new snapshot');
    if (selected && options.frameId && options.frameId !== selected.frame.frameId) throw new Error('Ref belongs to a different frame');
    this.invalidate();
    const epoch = this.epoch;
    const { frames, omissions } = await this.framesInternal(signal);
    const main = frames[0]!;
    const frameId = selected?.frame.frameId ?? options.frameId;
    const wanted = frameId ? frames.filter(f => f.frameId === frameId) : (options.selector ? [main] : frames);
    if (!wanted.length) throw new Error('Frame unavailable or origin_denied');
    const sequence = ++this.snapshotSequence;
    const refs = new Map<string, SnapshotRef>(), keys = new Map<string, string>();
    const lines = [`url: ${JSON.stringify(main.url)}`];
    let title = '', truncated = false, number = 0;
    for (const frame of wanted) {
      let nodes: AXNode[];
      try { nodes = await this.frameNodes(frame, signal); }
      catch (error) {
        this.assertLive(signal);
        if (!frame.parentId || frameId) throw error;
        omissions.push(`frame ${frame.frameId}: unavailable`); continue;
      }
      if (selected && selected.frame.key !== frame.key) throw new Error('stale_ref: document changed');
      const rootBackendId = selected?.backendNodeId ?? (options.selector ? await this.selectorNode(options.selector, frame, signal) : undefined);
      if (selected) {
        const target = nodes.find(n => n.backendDOMNodeId === selected.backendNodeId && !n.ignored);
        if (!target || nodeIdentity(target) !== selected.identity) throw new Error('stale_ref: target changed');
      }
      const root = nodes.find(n => roleOf(n) === 'RootWebArea');
      if (frame === main) title = nameOf(root ?? { nodeId: '', ignored: false });
      const prefix = frames.indexOf(frame) === 0 ? '' : `f${frames.indexOf(frame)}`;
      const rendered = renderAX(nodes, options, (node, context) => {
        // Snapshot generations are part of the printed ID, so old strings cannot
        // accidentally resolve to a different element on a later snapshot.
        const ref = `${prefix}s${this.refNamespace}_${sequence}e${++number}`;
        refs.set(ref, { frame: { ...frame }, backendNodeId: node.backendDOMNodeId!, identity: nodeIdentity(node), role: roleOf(node), name: nameOf(node), context });
        keys.set(ref, `${frame.key}:${node.backendDOMNodeId}`);
        return ref;
      }, rootBackendId);
      if (frame !== main) lines.push(`frame ${prefix} url: ${JSON.stringify(frame.url)}`);
      lines.push(rendered.tree);
      truncated ||= rendered.truncated;
    }
    if (omissions.length) lines.push(...omissions.map(o => `[omitted ${o}]`));
    const tree = lines.join('\n');
    if (tree.length > limits.maxChars) throw new SnapshotLimitError(`Snapshot exceeds ${limits.maxChars} characters`);
    const after = await this.framesInternal(signal);
    if (epoch !== this.epoch || JSON.stringify(after.frames.map(f => f.key)) !== JSON.stringify(frames.map(f => f.key))) throw new Error('Page changed while reading; take a new snapshot');
    this.assertLive(signal);
    const scope = JSON.stringify([main.key, frameId, selected?.backendNodeId, options.selector, !!options.interactive, limits.maxDepth]);
    const previous = this.previous?.scope === scope ? this.previous : undefined;
    const result: PageSnapshot = { id: randomUUID(), url: main.url, title, tree,
      diff: snapshotDiff(previous?.tree, tree, keys, previous?.keys ?? new Map()), truncated: truncated || omissions.length > 0, omissions };
    this.refs = refs; this.previous = { tree, keys, scope };
    return result;
  }

  locator(selectorOrRef: string): Locator {
    if (typeof selectorOrRef !== 'string') throw new Error('locator requires a CSS selector or snapshot ref');
    return new Locator(this, /^(?:f\d+)?s[A-Za-z0-9_-]{12}_\d+e\d+$/.test(selectorOrRef)
      ? { kind: 'ref', ref: selectorOrRef, epoch: this.epoch }
      : { kind: 'css', selector: selectorOrRef });
  }
  getByRole(role: string, options: RoleOptions = {}): Locator { return new Locator(this, { kind: 'role', role, options: { ...options } }); }
  frame(frameId: string) {
    return {
      snapshot: (options: SnapshotOptions & CallOptions = {}) => this.snapshot({ ...options, frameId }),
      locator: (selector: string) => new Locator(this, { kind: 'css', selector, frameId }),
      getByRole: (role: string, options: RoleOptions = {}) => new Locator(this, { kind: 'role', role, options: { ...options }, frameId }),
    };
  }

  private async resolve(query: Query, signal: AbortSignal): Promise<SnapshotRef> {
    if (query.kind === 'ref') {
      const ref = this.refs.get(query.ref);
      if (!ref || query.epoch !== this.epoch) throw new Error('stale_ref: take a new snapshot');
      return ref;
    }
    if (query.kind === 'css') {
      await this.snapshotInternal({ selector: query.selector, frameId: query.frameId }, signal);
      // The scoped tree's root may be an ignored wrapper; resolve the CSS identity
      // again rather than choosing an arbitrary descendant control.
      const { frames } = await this.framesInternal(signal);
      const frame = frames.find(f => f.frameId === query.frameId) ?? (query.frameId ? undefined : frames[0]);
      if (!frame) throw new Error('Frame unavailable');
      const backendNodeId = await this.selectorNode(query.selector, frame, signal);
      const nodes = await this.frameNodes(frame, signal);
      const node = nodes.find(n => n.backendDOMNodeId === backendNodeId && !n.ignored);
      if (!node) throw new Error('No accessible target for selector');
      return { frame, backendNodeId, identity: nodeIdentity(node), role: roleOf(node), name: nameOf(node) };
    }
    const snapshot = await this.snapshotInternal({ frameId: query.frameId }, signal);
    if (snapshot.truncated) throw new Error('Strict locator requires a complete snapshot; narrow the frame or use a selector');
    const matches = [...this.refs.values()].filter(ref => ref.role === query.role &&
      (query.options.name === undefined || (query.options.exact === false ? ref.name.includes(query.options.name) : ref.name === query.options.name)) &&
      (query.options.context === undefined || ref.context === query.options.context));
    if (matches.length !== 1) throw new Error(`Strict locator: ${matches.length} matches; narrow name, context or frame`);
    return matches[0]!;
  }

  private async currentTarget(ref: SnapshotRef, signal: AbortSignal): Promise<void> {
    const { frames } = await this.framesInternal(signal);
    const current = frames.find(f => f.frameId === ref.frame.frameId);
    if (!current || current.key !== ref.frame.key) throw new Error('stale_ref: document changed');
    const result = await this.call('Accessibility.getPartialAXTree', { backendNodeId: ref.backendNodeId, fetchRelatives: false }, signal, ref.frame.sessionId);
    const node = (result.nodes as AXNode[]).find(n => n.backendDOMNodeId === ref.backendNodeId && !n.ignored);
    if (!node || nodeIdentity(node) !== ref.identity) throw new Error('stale_ref: target changed');
  }

  /** Internal Locator entry point; selection never dispatches raw input. */
  async perform(query: Query, operation: string, payload: string | number | undefined, options: ActionOptions = {}): Promise<ActionResult> {
    options = { ...options };
    let attempted = false;
    return this.run<ActionResult>(async signal => {
      if ((operation === 'type' && (typeof payload !== 'string' || payload.length > 4096)) ||
          (operation === 'press' && typeof payload !== 'string') ||
          (operation === 'select' && typeof payload !== 'string' && (!Number.isInteger(payload) || Number(payload) < 0 || Number(payload) >= 64))) {
        return { status: 'blocked', reason: 'invalid_action_payload', verified: null };
      }
      const ref = await this.resolve(query, signal);
      await this.currentTarget(ref, signal);
      const { frames } = await this.framesInternal(signal);
      if (ref.frame.frameId !== frames[0]!.frameId) return { status: 'blocked', reason: 'frame_actions_unsupported', verified: null };
      const observe = () => this.guard.observe({ scope: this.scope, backendNodeId: ref.backendNodeId }, { signal });
      let seen = await observe();
      let candidate = seen.candidates[0];
      if (!candidate || seen.truncated) return { status: 'blocked', reason: 'not_interactable_or_unsupported', verified: null };
      if (operation !== 'scroll_into_view' && candidate.operations.length === 1 && candidate.operations[0] === 'scroll_into_view') {
        attempted = true;
        const scroll = await this.guard.act({ scope: this.scope, observationId: seen.observationId, action: { targetId: candidate.id, operation: 'scroll_into_view' } }, { signal });
        if (scroll.status !== 'executed') return { ...scroll, verified: null };
        await this.currentTarget(ref, signal);
        seen = await observe(); candidate = seen.candidates[0];
      }
      if (!candidate || !candidate.operations.includes(operation)) return { status: 'blocked', reason: 'unsupported_action', verified: null };
      const action: InteractionAction = { targetId: candidate.id, operation };
      let expected: string | undefined;
      if (operation === 'type') { action.text = String(payload); expected = action.text; }
      if (operation === 'press') action.key = String(payload);
      if (operation === 'select') {
        if (typeof payload === 'number') action.option = payload;
        else {
          const matches = (candidate.options ?? []).flatMap((label, index) => label === payload ? [index] : []);
          if (matches.length !== 1) return { status: 'blocked', reason: 'ambiguous_or_missing_option', verified: null };
          action.option = matches[0];
        }
        expected = candidate.options?.[action.option!];
      }
      attempted = true;
      const receipt = await this.guard.act({ scope: this.scope, observationId: seen.observationId, action }, { signal });
      this.refs.clear(); this.epoch++;
      if (receipt.status !== 'executed') return { ...receipt, verified: null };
      const result: ActionResult = { ...receipt, verified: null };
      try {
        if (expected !== undefined) {
          result.observation = await observe();
          result.verified = result.observation.candidates.length === 1 && result.observation.candidates[0]?.value === expected;
        }
        result.snapshot = await this.snapshotInternal({}, signal);
        if (options.verify) result.verified = options.verify(result.snapshot) === true;
      } catch (error) { result.verificationError = message(error); }
      return result;
    }, options).catch(error => ({ status: attempted ? 'outcome_unknown' : message(error).startsWith('stale_ref') ? 'stale' : 'blocked', reason: message(error), verified: null }));
  }

  observe(options: CallOptions & { maxElements?: number } = {}): Promise<InteractionObservation> {
    return this.run(signal => this.guard.observe({ scope: this.scope, maxElements: options.maxElements }, { signal }), options);
  }
  act(observation: InteractionObservation, action: InteractionAction, options: ActionOptions = {}): Promise<ActionResult> {
    observation = structuredClone(observation); action = { ...action };
    options = { ...options };
    let attempted = false;
    return this.run<ActionResult>(async signal => {
      if (observation.scope.sessionId !== this.scope.sessionId) return { status: 'stale', reason: 'scope_mismatch', verified: null } as ActionResult;
      attempted = true;
      const receipt = await this.guard.act({ scope: this.scope, observationId: observation.observationId, action }, { signal });
      this.refs.clear(); this.epoch++;
      const result: ActionResult = { ...receipt, verified: null };
      if (receipt.status === 'executed') {
        try { result.snapshot = await this.snapshotInternal({}, signal); if (options.verify) result.verified = options.verify(result.snapshot) === true; }
        catch (error) { result.verificationError = message(error); }
      }
      return result;
    }, options).catch(error => ({ status: attempted ? 'outcome_unknown' : 'blocked', reason: message(error), verified: null }));
  }
  waitForChange(revision: string, options: CallOptions & { waitMs?: number } = {}) {
    return this.run(signal => this.guard.waitForChange({ scope: this.scope, revision, timeoutMs: options.waitMs ?? 5000 }, { signal }), options);
  }

  async goto(url: string, options: CallOptions = {}): Promise<ActionResult> {
    let dispatched = false;
    return this.run<ActionResult>(async signal => {
      if (!this.allowed({ url })) throw new Error('origin_denied');
      this.invalidate();
      await this.call('Page.enable', {}, signal);
      await this.call('Page.setLifecycleEventsEnabled', { enabled: true }, signal);
      const loaded = new Set<string>();
      let loader: string | undefined, ready!: () => void;
      const promise = new Promise<void>(resolve => { ready = resolve; });
      const off = this.session.onEvent((method, p: any, sid) => {
        if (sid === this.scope.sessionId && method === 'Page.lifecycleEvent' && p.name === 'load') {
          loaded.add(p.loaderId); if (p.loaderId === loader) ready();
        }
      });
      const abort = () => ready();
      signal.addEventListener('abort', abort, { once: true });
      try {
        dispatched = true;
        const nav = await this.call('Page.navigate', { url }, signal);
        if (nav.errorText) throw new Error(nav.errorText);
        loader = nav.loaderId;
        if (loader && !loaded.has(loader)) await promise;
        this.assertLive(signal);
        const result: ActionResult = { status: 'executed', reason: 'navigation_observed', verified: null };
        try { result.snapshot = await this.snapshotInternal({}, signal); }
        catch (error) { result.verificationError = message(error); }
        return result;
      } finally { off(); signal.removeEventListener('abort', abort); }
    }, options).catch(error => ({ status: dispatched ? 'outcome_unknown' : 'blocked', reason: message(error), verified: null }));
  }

  /** Explicit raw escape hatch. Invalidates observations; never used by Locator actions. */
  cdp(method: string, params: unknown = {}, options: CallOptions = {}): Promise<any> {
    return this.run(signal => { this.invalidate(); return this.call(method, params, signal); }, options);
  }
  async close(options: CallOptions = {}): Promise<void> {
    if (!this.targetId) throw new Error('Page.close requires targetId; use dispose to release a borrowed scope');
    this.closing = true;
    try { await this.run(signal => this.call('Target.closeTarget', { targetId: this.targetId }, signal), options); }
    finally { this.closing = false; this.dispose(); }
  }
  /** Release local handles/listeners and owned attachments, not the tab or Session. */
  dispose(): void {
    if (this.disposed) return;
    this.lifetime.abort(new Error('Page disposed')); this.off(); this.guard.close(); this.refs.clear(); this.previous = undefined;
    const owned = [...this.childSessions.values(), ...(this.ownsAttachment ? [this.scope.sessionId] : [])];
    for (const sessionId of owned) {
      void this.session._call('Target.detachFromTarget', { sessionId }, { expectedGeneration: this.generation }).catch(() => {});
    }
    this.childSessions.clear();
  }
}

export class Locator {
  private readonly page: Page;
  private readonly query: Query;
  constructor(page: Page, query: Query) { this.page = page; this.query = structuredClone(query); }
  click(options?: ActionOptions) { return this.page.perform(this.query, 'click', undefined, options); }
  fill(text: string, options?: ActionOptions) { return this.page.perform(this.query, 'type', text, options); }
  press(key: string, options?: ActionOptions) { return this.page.perform(this.query, 'press', key, options); }
  /** A unique option label or zero-based index, not an HTML value or selector DSL. */
  selectOption(option: string | number, options?: ActionOptions) { return this.page.perform(this.query, 'select', option, options); }
  scrollIntoView(options?: ActionOptions) { return this.page.perform(this.query, 'scroll_into_view', undefined, options); }
}

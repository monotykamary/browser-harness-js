import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext, type Context } from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { InteractionController, type InteractionObservation } from './interaction.ts';

// Minimal injected DOM, not a browser emulator. Execute the actual isolated-world
// projection/guard source to probe its decisions without touching a live browser.
class ElementFixture {
  tagName: string;
  type = '';
  attrs: Record<string, string> = {};
  textContent = '';
  labels: ElementFixture[] = [];
  readOnly = false;
  isConnected = true;
  ownerDocument: any;
  parentElement: ElementFixture | null = null;
  hidden = false;
  inert = false;
  disabled = false;
  checked = false;
  clicks = 0;
  inputs = 0;
  hit = true;
  style = { display: 'block', visibility: 'visible', opacity: '1' };
  rect = { x: 10, y: 10, width: 100, height: 30 };
  constructor(tag = 'BUTTON', text = 'Continue') { this.tagName = tag; this.textContent = text; }
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
  hasAttribute(key: string) { return key in this.attrs; }
  getAttribute(key: string) { return this.attrs[key] ?? null; }
  getBoundingClientRect() { return this.rect; }
  contains(el: ElementFixture) { return el === this; }
  closest(selector: string): ElementFixture | null {
    if ((selector.includes('data-private') && 'data-private' in this.attrs) ||
        (selector.includes('data-sensitive') && 'data-sensitive' in this.attrs) ||
        (selector.includes('aria-disabled') && this.attrs['aria-disabled'] === 'true') ||
        (selector.includes('inert') && this.inert)) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  matches(selector: string) {
    if (selector === ':disabled') return this.disabled;
    return this.type === 'password' || /password|cc-|one-time-code/.test(this.attrs.autocomplete ?? '') ||
      'data-private' in this.attrs || 'data-sensitive' in this.attrs;
  }
  click() { this.clicks++; if (this.type === 'checkbox') this.checked = !this.checked; }
  focuses = 0;
  focus() { this.focuses++; }
  dispatchEvent(_event: Event) { this.inputs++; return true; }
}
class InputFixture extends ElementFixture {
  private text = '';
  constructor(type = 'text') { super('INPUT', ''); this.type = type; this.attrs.type = type; this.attrs['aria-label'] = 'Message'; }
  get value() { return this.text; }
  set value(value: string) { this.text = value; }
}
class TextareaFixture extends InputFixture { constructor() { super(); this.tagName = 'TEXTAREA'; } }
class PageFixture {
  url = 'https://allowed.test/start';
  loader = 'loader-1';
  title = 'Fixture';
  nodes: ElementFixture[] = [new ElementFixture(), new InputFixture()];
  context: Context;
  document: any;
  constructor() {
    const page = this;
    this.document = {
      documentElement: {},
      get title() { return page.title; },
      createTreeWalker() { let index = 0; return { nextNode: () => page.nodes[index++] ?? null }; },
      elementFromPoint(x: number, y: number) { return page.nodes.find(n => n.hit && n.rect.x + n.rect.width / 2 === x && n.rect.y + n.rect.height / 2 === y) ?? null; },
    };
    this.refreshNodes();
    this.context = createContext({
      document: this.document,
      location: { get href() { return page.url; }, get origin() { return new URL(page.url).origin; } },
      HTMLElement: ElementFixture, HTMLInputElement: InputFixture, HTMLTextAreaElement: TextareaFixture,
      NodeFilter: { SHOW_ELEMENT: 1 }, innerWidth: 1200, innerHeight: 800,
      getComputedStyle: (element: ElementFixture) => element.style, Event, crypto: webcrypto, TextEncoder,
    });
  }
  refreshNodes() { this.nodes.forEach((n, i) => { n.ownerDocument = this.document; n.rect.y = i * 40 + 10; }); }
}
class FixtureSession {
  generation = 1;
  connected = true;
  pages = new Map([['one', new PageFixture()], ['two', new PageFixture()]]);
  objects = new Map<string, { sid: string; value: any }>();
  calls: { method: string; sid: string; params: any }[] = [];
  listeners = new Set<(method: string, params: any, sid?: string) => void>();
  before?: (method: string, params: any, sid: string) => void | Promise<void>;
  after?: (method: string, params: any, sid: string) => void | Promise<void>;
  next = 0;
  getConnectionGeneration() { return this.generation; }
  isConnected() { return this.connected; }
  onEvent(fn: (method: string, params: any, sid?: string) => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  emit(method: string, sid?: string, params: any = {}) { for (const fn of this.listeners) fn(method, params, sid); }
  async _call(method: string, params: any, opts: { sessionId: string; expectedGeneration?: number }) {
    assert.ok(opts.sessionId, 'all calls must be explicitly routed');
    assert.equal(opts.expectedGeneration, this.generation);
    assert.equal(this.connected, true);
    const sid = opts.sessionId;
    const page = this.pages.get(sid);
    if (!page) throw new Error('Unknown scope');
    this.calls.push({ method, sid, params });
    await this.before?.(method, params, sid);
    let result: any = {};
    if (method === 'Page.getFrameTree') result = { frameTree: { frame: { id: sid, loaderId: page.loader, url: page.url } } };
    else if (method === 'Page.createIsolatedWorld') result = { executionContextId: sid };
    else if (method === 'Runtime.evaluate') {
      const objectId = `object-${++this.next}`;
      assert.equal(params.awaitPromise, true);
      this.objects.set(objectId, { sid, value: await runInContext(params.expression, page.context) });
      result = { result: { objectId } };
    } else if (method === 'Runtime.callFunctionOn') {
      const obj = this.objects.get(params.objectId);
      if (!obj || obj.sid !== sid) throw new Error('Native object gone');
      const fn = runInContext(`(${params.functionDeclaration})`, page.context);
      result = { result: { value: structuredClone(fn.apply(obj.value, (params.arguments ?? []).map((a: any) => a.value))) } };
    } else if (method === 'Runtime.releaseObject') this.objects.delete(params.objectId);
    await this.after?.(method, params, sid);
    return result;
  }
}
const scope = { sessionId: 'one' };
function setup() { const session = new FixtureSession(); const controller = new InteractionController(session, { allowedOrigins: ['https://allowed.test'] }); return { session, controller, page: session.pages.get('one')! }; }
function action(observation: InteractionObservation, index = 0, operation = 'click', text?: string) {
  return { scope: observation.scope, observationId: observation.observationId, action: { targetId: observation.candidates[index]!.id, operation, text } };
}
const isDispatch = (method: string, params: any) => method === 'Runtime.callFunctionOn' && params.functionDeclaration.includes('this.act');
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

test('literal typing boundary is 4096 at host and isolated page, with safe read-back', async () => {
  const { controller, session, page } = setup();
  const text = 'x'.repeat(4096);
  let seen = await controller.observe({ scope });
  const before = session.calls.filter(c => isDispatch(c.method, c.params)).length;
  assert.equal((await controller.act(action(seen, 1, 'type', text + 'x'))).status, 'blocked');
  assert.equal(session.calls.filter(c => isDispatch(c.method, c.params)).length, before);
  seen = await controller.observe({ scope });
  assert.equal((await controller.act(action(seen, 1, 'type', text))).status, 'executed');
  seen = await controller.observe({ scope });
  assert.equal(seen.candidates[1]!.value, text);
  assert.equal((page.nodes[1] as InputFixture).value, text);
  const native = [...session.objects.values()][0]!.value;
  assert.equal(native.act(1, 'type', text + 'x').status, 'blocked', 'page guard independent of host');
  assert.equal(page.nodes[1]!.inputs, 1);
  assert.equal(native.act(1, 'type', 'replay').status, 'stale');
  controller.close();
});

test('direct isolated DOM probe: replacement input event and checkbox verification', async () => {
  const { controller, session, page } = setup();
  const input = page.nodes[1] as InputFixture;
  input.value = 'old';
  const checkbox = new InputFixture('checkbox'); checkbox.attrs['aria-label'] = 'Enable feature';
  page.nodes.push(checkbox); page.refreshNodes();
  const events: Event[] = [];
  input.dispatchEvent = event => { events.push(event); return true; };
  let seen = await controller.observe({ scope });
  assert.equal(seen.candidates[1]!.value, 'old'); assert.equal(seen.candidates[2]!.checked, false);
  // Execute the actual isolated-world guard directly, independently of act's host adapter.
  const native = [...session.objects.values()][0]!.value;
  assert.equal(native.act(1, 'type', 'replacement').status, 'executed');
  assert.equal(events.length, 1); assert.equal(events[0]!.type, 'input');
  assert.equal(events[0]!.bubbles, true); assert.equal(events[0]!.composed, true); assert.equal(events[0]!.isTrusted, false);
  seen = await controller.observe({ scope }); assert.equal(seen.candidates[1]!.value, 'replacement');
  const revision = seen.revision;
  assert.equal((await controller.act(action(seen, 2))).status, 'executed');
  const verified = await controller.waitForChange({ scope, revision, timeoutMs: 0 });
  assert.equal(verified.changed, true); assert.equal(verified.observation.candidates[2]!.checked, true);
  checkbox.checked = false;
  assert.equal((await controller.act(action(verified.observation, 2))).status, 'stale');
  controller.close();
});

test('sensitive naming sources exclude controls even when a benign aria-label wins', async () => {
  const { controller, session, page } = setup();
  const cases: [string, string][] = [['name', 'api_key'], ['id', 'accessToken'], ['name', 'pin_code'],
    ['aria-label', 'Security code'], ['title', 'Social Security Number'], ['placeholder', 'Email address'],
    ['id', 'cardNumber'], ['name', 'first_name'], ['autocomplete', 'email']];
  for (const [key, value] of cases) {
    const input = new InputFixture(); input.attrs[key] = value; input.value = 'PRIVATE_RAW_SENTINEL';
    page.nodes.push(input);
  }
  const labelled = new InputFixture(); labelled.labels = [new ElementFixture('LABEL', 'Bank account')]; labelled.value = 'PRIVATE_RAW_SENTINEL';
  const ancestor = new InputFixture(); ancestor.parentElement = new ElementFixture('DIV'); ancestor.parentElement.attrs['data-private'] = '';
  ancestor.value = 'PRIVATE_RAW_SENTINEL'; page.nodes.push(labelled, ancestor); page.refreshNodes();
  const seen = await controller.observe({ scope }); assert.equal(seen.candidates.length, 2);
  const snapshot = [...session.objects.values()][0]!.value.snapshot;
  assert.ok(!JSON.stringify(snapshot).includes('PRIVATE_RAW_SENTINEL'));
  assert.ok(!JSON.stringify(seen).includes('revisionState'));
  // Privacy is checked again at the effect boundary, including newly sensitive identity.
  (page.nodes[1] as InputFixture).attrs.name = 'password';
  assert.equal((await controller.act(action(seen, 1, 'type', 'no'))).status, 'stale');
  controller.close();
});

test('exact constructor and scope boundaries reject before transport or persistent allocation', async () => {
  const { session, controller } = setup();
  const origin = 'https://' + 'a'.repeat(2040);
  assert.equal(origin.length, 2048);
  const bounded = new InteractionController(session, { allowedOrigins: Array(32).fill(origin) }); bounded.close();
  for (const origins of [[], Array(33).fill('https://allowed.test'), [origin + 'a'], [null], [42]]) {
    assert.throws(() => new InteractionController(session, { allowedOrigins: origins as string[] }));
  }
  const longScope = { sessionId: 's'.repeat(257) };
  await assert.rejects(controller.observe({ scope: longScope }), /256/);
  await assert.rejects(controller.act({ scope: longScope, observationId: '', action: { targetId: '', operation: 'click' } }), /256/);
  await assert.rejects(controller.waitForChange({ scope: longScope, revision: '' }), /256/);
  assert.throws(() => controller.invalidate(longScope), /256/); assert.equal(session.calls.length, 0);
  const edge = { sessionId: 's'.repeat(256) }; session.pages.set(edge.sessionId, session.pages.get('one')!);
  assert.ok((await controller.observe({ scope: edge })).observationId); controller.close();
});

test('fingerprint transport is digest-only and oversized exact identities are excluded, never sliced', async () => {
  const { controller, session, page } = setup();
  page.nodes = Array.from({ length: 128 }, (_, i) => {
    const el = new ElementFixture('BUTTON', `Button ${i}`); el.attrs['data-internal'] = 'RAW_FINGERPRINT_SENTINEL';
    el.ownerDocument = page.document; el.rect = { x: i * 2, y: 10, width: 1, height: 1 }; return el;
  });
  const seen = await controller.observe({ scope, maxElements: 128 });
  const snapshot = [...session.objects.values()][0]!.value.snapshot;
  assert.equal(snapshot.revisionState.length, 128);
  assert.ok(snapshot.revisionState.every((hash: string) => /^[a-f0-9]{64}$/.test(hash)));
  assert.ok(JSON.stringify(snapshot.revisionState).length < 9000);
  assert.ok(!JSON.stringify(snapshot).includes('RAW_FINGERPRINT_SENTINEL'));
  assert.ok(!JSON.stringify(seen).includes('fingerprint'));
  // Cosmetic attributes are not identity; identifying ones are.
  page.nodes[0]!.attrs['data-internal'] += 'tail';
  assert.equal((await controller.act(action(seen))).status, 'executed');
  const again = await controller.observe({ scope, maxElements: 128 });
  page.nodes[0]!.attrs.id = 'renamed';
  assert.equal((await controller.act(action(again))).status, 'stale');
  page.nodes[0]!.attrs = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`data-${i}`, 'x'.repeat(1024)]));
  const truncated = await controller.observe({ scope, maxElements: 128 });
  assert.equal(truncated.candidates.length, 127); assert.equal(truncated.truncation.text, true);
  page.nodes[1]!.attrs['x'.repeat(257)] = '';
  assert.equal((await controller.observe({ scope, maxElements: 128 })).candidates.length, 126);
  controller.close();
});

test('oversized values are flagged and unavailable crypto fails closed without raw identity fallback', async () => {
  const { controller, session, page } = setup();
  (page.nodes[1] as InputFixture).value = 'x'.repeat(4097);
  const seen = await controller.observe({ scope });
  assert.equal(seen.candidates.length, 1); assert.equal(seen.truncation.text, true);
  page.context.crypto = {};
  await assert.rejects(controller.observe({ scope }));
  assert.equal(session.objects.size, 0); assert.equal((controller as any).epochs.size, 0);
  controller.close();
});

test('stalled remote releases backpressure observations rather than growing retained objects indefinitely', async () => {
  const { controller, session } = setup(); const held = gate();
  session.before = method => method === 'Runtime.releaseObject' ? held.promise : undefined;
  for (let i = 0; i < 33; i++) await controller.observe({ scope });
  await assert.rejects(controller.observe({ scope }), /capacity/);
  assert.equal(session.objects.size, 33); assert.equal((controller as any).releases.size, 32);
  controller.close(); held.release(); await tick(); await tick();
  assert.equal(session.objects.size, 0); assert.equal((controller as any).releases.size, 0);
});

test('retained scopes and invalidation tombstones are bounded and reusable', async () => {
  const { controller, session } = setup();
  for (let i = 0; i < 32; i++) {
    const sid = `scope-${i}`; session.pages.set(sid, session.pages.get('one')!);
    await controller.observe({ scope: { sessionId: sid } });
  }
  session.pages.set('extra', session.pages.get('one')!);
  await assert.rejects(controller.observe({ scope: { sessionId: 'extra' } }), /capacity/);
  for (let i = 0; i < 1000; i++) controller.invalidate({ sessionId: `unseen-${i}` });
  assert.equal((controller as any).epochs.size, 32); assert.equal(session.objects.size, 32);
  controller.invalidate({ sessionId: 'scope-0' });
  await controller.observe({ scope: { sessionId: 'extra' } });
  controller.close(); await tick();
  assert.equal((controller as any).epochs.size, 0); assert.equal(session.objects.size, 0);
});

test('shared queue admission and sleeping waits have hard pending limits', async () => {
  const { controller, session } = setup(); const entered = gate(); const held = gate();
  session.before = method => { if (method === 'Page.enable') { entered.release(); return held.promise; } };
  const first = controller.observe({ scope }).catch(error => error); await entered.promise;
  const pending = Array.from({ length: 31 }, () => controller.observe({ scope }).catch(error => error));
  await assert.rejects(controller.observe({ scope }), /capacity/);
  const other = new InteractionController(session, { allowedOrigins: ['https://allowed.test'] });
  await assert.rejects(other.observe({ scope }), /capacity/);
  const waits = Array.from({ length: 32 }, () => controller.waitForChange({ scope: { sessionId: 'two' }, revision: '', timeoutMs: 1000 }).catch(error => error));
  await assert.rejects(controller.waitForChange({ scope, revision: '' }), /wait capacity/);
  controller.close(); other.close();
  await Promise.all([first, ...pending, ...waits]);
  held.release(); await tick(); await tick();
  assert.equal((controller as any).queues.size, 0); assert.equal((controller as any).waiters, 0);
});

test('shared queue scope count cannot grow indefinitely', async () => {
  const { controller, session } = setup(); const held = gate();
  session.before = method => method === 'Page.enable' ? held.promise : undefined;
  const pending = Array.from({ length: 32 }, (_, i) => {
    const sid = `pending-${i}`; session.pages.set(sid, session.pages.get('one')!);
    return controller.observe({ scope: { sessionId: sid } }).catch(error => error);
  });
  await assert.rejects(controller.observe({ scope }), /queue capacity/);
  controller.close(); await Promise.all(pending); held.release(); await tick(); await tick();
  assert.equal((controller as any).queues.size, 0);
});

test('cancelled dispatch remains quarantined until its late effect settles, without stale replay', async () => {
  const { controller, session, page } = setup(); const other = new InteractionController(session, { allowedOrigins: ['https://allowed.test'] });
  const seen = await controller.observe({ scope }); const entered = gate(); const held = gate(); const abort = new AbortController();
  session.before = (method, params) => { if (isDispatch(method, params)) { entered.release(); return held.promise; } };
  const effect = controller.act(action(seen), { signal: abort.signal }); await entered.promise;
  abort.abort(); assert.equal((await effect).status, 'outcome_unknown'); assert.equal(page.nodes[0]!.clicks, 0);
  assert.equal((await controller.act(action(seen))).status, 'stale');
  const calls = session.calls.length; const fresh = other.observe({ scope }); await tick();
  assert.equal(session.calls.length, calls, 'no observation can overtake an unresolved effect');
  held.release(); await fresh;
  assert.equal(page.nodes[0]!.clicks, 1); assert.equal(session.calls.filter(c => isDispatch(c.method, c.params)).length, 1);
  controller.close(); other.close();
});

test('cooperative close returns promptly, blocks queued effects and releases late snapshot objects', async () => {
  const { controller, session, page } = setup(); const seen = await controller.observe({ scope });
  const entered = gate(); const held = gate();
  session.after = (method, params) => { if (isDispatch(method, params)) { entered.release(); return held.promise; } };
  const effect = controller.act(action(seen)); await entered.promise;
  const queued = controller.observe({ scope }); const rejected = assert.rejects(queued);
  controller.close(); controller.close();
  assert.equal((await effect).status, 'outcome_unknown'); await rejected;
  assert.equal(page.nodes[0]!.clicks, 1); assert.equal(session.listeners.size, 0);
  held.release(); await tick(); assert.equal((controller as any).queues.size, 0);
  const late = setup(); const evaluated = gate(); const response = gate();
  late.session.after = method => { if (method === 'Runtime.evaluate') { evaluated.release(); return response.promise; } };
  const observation = late.controller.observe({ scope }); const cancelled = assert.rejects(observation);
  await evaluated.promise; late.controller.close(); await cancelled;
  response.release(); await tick(); await tick(); assert.equal(late.session.objects.size, 0);
});

test('exports and REPL registration are additive, exact origins and explicit scope required', async () => {
  const { session, controller } = setup();
  for (const origin of ['*', 'https://allowed.test/', 'https://allowed.test/path', 'https://u:p@allowed.test', 'null', 'file://']) {
    assert.throws(() => new InteractionController(session, { allowedOrigins: [origin] }));
  }
  assert.throws(() => new InteractionController(session, {} as any));
  await assert.rejects(controller.observe({ scope: {} as any }), /scope/);
  await assert.rejects(controller.observe({ scope, maxElements: 129 }), /maxElements/);
  assert.throws(() => new InteractionController(session, { allowedOrigins: [] }), /1..32/);
  const source = readFileSync(new URL('./repl.ts', import.meta.url), 'utf8');
  for (const name of ['InteractionController', 'createInteractionController', 'axClick', 'axType', 'cdp', 'session']) assert.ok(source.includes(`(globalThis as any).${name} =`));
  controller.close();
});

test('opaque scoped handles, replacement typing, receipts, replay and fresh observations', async () => {
  const { controller, page } = setup();
  const seen = await controller.observe({ scope });
  assert.equal(seen.candidates.length, 2);
  assert.equal(seen.candidates[0]!.role, 'button');
  assert.ok(!JSON.stringify(seen).includes('object-'));
  const click = action(seen);
  const [first, second] = await Promise.all([controller.act(click), controller.act(click)]);
  assert.equal(first.status, 'executed'); assert.equal(second.status, 'stale'); assert.equal(page.nodes[0]!.clicks, 1);
  const next = await controller.observe({ scope });
  (page.nodes[1] as InputFixture).value = 'old';
  assert.equal((await controller.act(action(next, 1, 'type', 'new'))).status, 'stale');
  const fresh = await controller.observe({ scope });
  assert.equal((await controller.act(action(fresh, 1, 'type', 'replacement'))).status, 'executed');
  assert.equal((page.nodes[1] as InputFixture).value, 'replacement'); assert.equal(page.nodes[1]!.inputs, 1);
  assert.equal((await controller.act(action(seen))).status, 'stale');
  controller.close();
});

test('cross-scope handles and caller mutation cannot widen native authority', async () => {
  const { session, controller, page } = setup();
  const one = await controller.observe({ scope });
  const two = await controller.observe({ scope: { sessionId: 'two' } });
  assert.equal((await controller.act({ ...action(one), scope: two.scope })).status, 'stale');
  const fresh = await controller.observe({ scope });
  fresh.candidates[0]!.operations.push('type');
  assert.equal((await controller.act(action(fresh, 0, 'type', 'bad'))).status, 'blocked');
  assert.equal(page.nodes[0]!.inputs, 0);
  assert.ok(session.calls.every(call => ['one', 'two'].includes(call.sid)));
  controller.close();
});

test('native identity, labels, geometry, visibility, disabled state and occlusion rechecked', async () => {
  const mutations: [(page: PageFixture) => void, string][] = [
    [page => { page.nodes[0]!.isConnected = false; page.nodes[0] = new ElementFixture(); page.refreshNodes(); }, 'stale'],
    [page => { page.nodes[0]!.textContent = 'Delete'; }, 'stale'],
    [page => { page.nodes[0]!.attrs.href = 'https://elsewhere.test/'; }, 'stale'],
    [page => { page.nodes[0]!.attrs.role = 'link'; }, 'stale'],
    [page => { page.nodes[0]!.hidden = true; }, 'blocked'],
    [page => { page.nodes[0]!.disabled = true; }, 'blocked'],
    [page => { page.nodes[0]!.hit = false; }, 'blocked'],
  ];
  for (const [mutate, status] of mutations) {
    const { controller, page } = setup(); const seen = await controller.observe({ scope }); mutate(page);
    assert.equal((await controller.act(action(seen))).status, status);
    assert.equal(page.nodes[0]!.clicks, 0); controller.close();
  }
});

test('navigation and connection generation invalidate, including denied post-navigation origins', async () => {
  for (const mode of ['loader', 'origin', 'event', 'generation', 'disconnect']) {
    const { session, controller, page } = setup(); const seen = await controller.observe({ scope });
    if (mode === 'loader') page.loader = 'loader-2';
    if (mode === 'origin') page.url = 'https://denied.test/';
    if (mode === 'event') session.emit('Page.frameNavigated', 'one');
    if (mode === 'generation') session.generation++;
    if (mode === 'disconnect') session.connected = false;
    const result = await controller.act(action(seen));
    assert.equal(result.status, mode === 'origin' ? 'blocked' : 'stale');
    assert.equal(page.nodes[0]!.clicks, 0);
    if (mode === 'origin') await assert.rejects(controller.observe({ scope }), /origin_denied/);
    controller.close();
  }
});

test('origin/navigation races inside the effect guard are denied before activation', async () => {
  const { session, controller, page } = setup(); const seen = await controller.observe({ scope });
  session.before = (method, params) => { if (isDispatch(method, params)) page.url = 'https://denied.test/'; };
  assert.equal((await controller.act(action(seen))).status, 'blocked'); assert.equal(page.nodes[0]!.clicks, 0);
  controller.close();
});

test('redaction, explicit output bounds and stable semantic revisions', async () => {
  const { controller, page } = setup();
  const password = new InputFixture('password'); password.value = 'SECRET'; password.attrs['aria-label'] = 'SECRET';
  const cc = new InputFixture(); cc.attrs.autocomplete = 'cc-number'; cc.value = 'CARD';
  const otp = new InputFixture(); otp.attrs.autocomplete = 'section-login ONE-TIME-CODE'; otp.value = 'OTP_SECRET';
  page.nodes.push(password, cc, otp); page.refreshNodes();
  const seen = await controller.observe({ scope });
  assert.equal(seen.candidates.length, 2); assert.ok(!JSON.stringify(seen).includes('SECRET')); assert.ok(!JSON.stringify(seen).includes('CARD'));
  const again = await controller.observe({ scope }); assert.equal(again.revision, seen.revision); assert.notEqual(again.observationId, seen.observationId);
  const small = await controller.observe({ scope, maxElements: 1 }); assert.equal(small.truncated, true); assert.equal(small.truncation.elements, true);
  page.nodes[0]!.attrs['aria-label'] = 'x'.repeat(300);
  const long = await controller.observe({ scope }); assert.equal(long.candidates[0]!.label.length, 256); assert.equal(long.truncation.text, true);
  page.nodes = Array.from({ length: 4100 }, () => new ElementFixture('DIV', '')); page.refreshNodes();
  assert.equal((await controller.observe({ scope })).truncation.scan, true);
  controller.close();
});

test('cancellation before dispatch blocks; cancellation after dispatch is unknown and never retried', async () => {
  const { session, controller, page } = setup(); const signal = new AbortController();
  const seen = await controller.observe({ scope }); signal.abort();
  assert.equal((await controller.act(action(seen), { signal: signal.signal })).status, 'blocked'); assert.equal(page.nodes[0]!.clicks, 0);
  const mid = new AbortController();
  session.after = (method) => { if (method === 'Page.getFrameTree') mid.abort(); };
  assert.equal((await controller.act(action(seen), { signal: mid.signal })).status, 'blocked'); assert.equal(page.nodes[0]!.clicks, 0);
  session.after = undefined;
  const fresh = await controller.observe({ scope }); const during = new AbortController();
  session.after = (method, params) => { if (isDispatch(method, params)) { during.abort(); return new Promise(() => {}); } };
  assert.equal((await controller.act(action(fresh), { signal: during.signal })).status, 'outcome_unknown');
  assert.equal(page.nodes[0]!.clicks, 1); assert.equal((await controller.act(action(fresh))).status, 'stale');
  controller.close();
});

test('transport failure after dispatch and navigation during dispatch return unknown', async () => {
  for (const mode of ['error', 'navigation']) {
    const { session, controller, page } = setup(); const seen = await controller.observe({ scope });
    session.after = (method, params) => { if (isDispatch(method, params)) { if (mode === 'error') throw new Error('lost response'); session.emit('Page.frameNavigated', 'one'); } };
    assert.equal((await controller.act(action(seen))).status, 'outcome_unknown'); assert.equal(page.nodes[0]!.clicks, 1);
    assert.equal((await controller.act(action(seen))).status, 'stale'); controller.close();
  }
});

test('wait returns fresh shape on timeout or change, catches value changes, and cancels', async () => {
  const { controller, page } = setup(); const seen = await controller.observe({ scope });
  const same = await controller.waitForChange({ scope, revision: seen.revision, timeoutMs: 0 });
  assert.equal(same.changed, false); assert.ok(same.observation.observationId);
  (page.nodes[1] as InputFixture).value = 'updated';
  const changed = await controller.waitForChange({ scope, revision: seen.revision, timeoutMs: 0 }); assert.equal(changed.changed, true);
  const abort = new AbortController(); const waiting = controller.waitForChange({ scope, revision: changed.observation.revision, timeoutMs: 1000 }, { signal: abort.signal });
  setTimeout(() => abort.abort(), 10); await assert.rejects(waiting);
  controller.close();
});

test('invalidate/close stop queued work and unsubscribe without closing the session', async () => {
  const { controller, session, page } = setup(); const seen = await controller.observe({ scope });
  controller.invalidate(scope); assert.equal((await controller.act(action(seen))).status, 'stale');
  const fresh = await controller.observe({ scope }); controller.close();
  assert.equal((await controller.act(action(fresh))).status, 'blocked'); await assert.rejects(controller.observe({ scope }));
  assert.equal(session.listeners.size, 0); assert.equal(session.connected, true); assert.equal(page.nodes[0]!.clicks, 0);
});

test('default/max element limits, long-label semantic changes and unsupported controls', async () => {
  const { controller, page } = setup();
  page.nodes = Array.from({ length: 130 }, (_, index) => {
    const el = new ElementFixture('BUTTON', `Button ${index}`);
    el.ownerDocument = page.document; el.rect = { x: index * 2, y: 10, width: 1, height: 1 }; return el;
  });
  const defaultView = await controller.observe({ scope }); assert.equal(defaultView.candidates.length, 64); assert.equal(defaultView.truncated, true);
  const maxView = await controller.observe({ scope, maxElements: 128 }); assert.equal(maxView.candidates.length, 128);
  page.nodes[0]!.textContent = 'x'.repeat(300);
  const long = await controller.observe({ scope }); page.nodes[0]!.textContent = 'x'.repeat(299) + 'y';
  assert.equal((await controller.act(action(long))).status, 'stale');
  page.nodes[0]!.textContent = 'x'.repeat(3000);
  const oversized = await controller.observe({ scope }); assert.equal(oversized.truncation.text, true);
  page.nodes = [new ElementFixture('DIV', 'custom'), new InputFixture('email'), new ElementFixture()];
  page.nodes[2]!.attrs['aria-labelledby'] = 'external'; page.refreshNodes();
  // Plain DIVs and email inputs stay unsupported; an unresolvable aria-labelledby
  // falls back to the next naming source instead of hiding the control.
  const fallback = await controller.observe({ scope });
  assert.deepEqual(fallback.candidates.map(c => [c.role, c.label]), [['button', 'Continue']]);
  controller.close();
});

test('invalidation during snapshot fails closed and observed scopes remain independent', async () => {
  const { session, controller } = setup();
  const two = await controller.observe({ scope: { sessionId: 'two' } });
  session.after = (method, _params, sid) => { if (method === 'Runtime.evaluate' && sid === 'one') controller.invalidate(scope); };
  await assert.rejects(controller.observe({ scope }), /changed/);
  assert.equal((await controller.act(action(two))).status, 'executed');
  controller.close();
});

test('controllers share scope serialization, including cancellation of queued mutations', async () => {
  const { controller, session, page } = setup(); const other = new InteractionController(session, { allowedOrigins: ['https://allowed.test'] });
  const a = await controller.observe({ scope }); const b = await other.observe({ scope });
  let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  session.after = (method, params) => { if (isDispatch(method, params)) { entered(); return new Promise<void>(resolve => { release = resolve; }); } };
  const first = controller.act(action(a)); await started;
  const abort = new AbortController(); const second = other.act(action(b), { signal: abort.signal }); abort.abort();
  release(); assert.equal((await first).status, 'executed'); assert.equal((await second).status, 'blocked'); assert.equal(page.nodes[0]!.clicks, 1);
  controller.close(); other.close();
});

test('trusted input: the page revalidates, then the host sends real mouse, text and key events', async () => {
  const session = new FixtureSession();
  const controller = new InteractionController(session, { allowedOrigins: ['https://allowed.test'], input: 'trusted' });
  const page = session.pages.get('one')!;
  const inputCalls = () => session.calls.filter(c => c.method.startsWith('Input.')).map(c => [c.method, c.params]);

  let seen = await controller.observe({ scope });
  assert.ok(session.calls.some(c => c.method === 'Emulation.setFocusEmulationEnabled'));
  assert.deepEqual(seen.candidates[0]!.operations, ['click', 'press']);
  assert.equal((await controller.act(action(seen, 0))).status, 'executed');
  // No synthetic click: the page only rechecked the target and reported its center.
  assert.equal(page.nodes[0]!.clicks, 0);
  const point = { x: 60, y: 25 };
  assert.deepEqual(inputCalls(), [
    ['Input.dispatchMouseEvent', { type: 'mouseMoved', ...point }],
    ['Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 }],
    ['Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 }],
  ]);

  session.calls.length = 0;
  seen = await controller.observe({ scope });
  const press = (key: string) => ({ scope, observationId: seen.observationId, action: { targetId: seen.candidates[0]!.id, operation: 'press', key } });
  assert.equal((await controller.act(press('F12'))).reason, 'unsupported_action');
  assert.deepEqual(inputCalls(), [], 'unknown keys never reach the page');
  seen = await controller.observe({ scope });
  assert.equal((await controller.act(press('Enter'))).status, 'executed');
  assert.equal(page.nodes[0]!.focuses, 1, 'the page focuses the rechecked target first');
  assert.deepEqual(inputCalls(), [
    ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' }],
    ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }],
  ]);
  controller.close();
});

test('synthetic controllers refuse press and malformed select/type payloads before dispatch', async () => {
  const { controller, session } = setup();
  const dispatches = () => session.calls.filter(c => isDispatch(c.method, c.params)).length;
  let seen = await controller.observe({ scope });
  assert.ok(seen.candidates.every(c => !c.operations.includes('press')));
  const attempt = (extra: Record<string, unknown>) =>
    controller.act({ scope, observationId: seen.observationId, action: { targetId: seen.candidates[0]!.id, ...extra } as any });
  for (const extra of [
    { operation: 'press', key: 'Enter' },
    { operation: 'select', option: -1 },
    { operation: 'select', option: 1.5 },
    { operation: 'select', option: 0 },
    { operation: 'scroll' },
  ]) {
    assert.equal((await attempt(extra)).reason, 'unsupported_action', JSON.stringify(extra));
    seen = await controller.observe({ scope });
  }
  assert.equal(dispatches(), 0);
  assert.throws(() => new InteractionController(session, { allowedOrigins: ['https://allowed.test'], input: 'fast' as any }), /input must be/);
  controller.close();
});

test('layout shifts and cosmetic churn keep a target; its meaning and occlusion still decide', async () => {
  const cosmetic: ((page: PageFixture) => void)[] = [
    page => { page.nodes[0]!.rect.x += 1; },
    page => { page.nodes[0]!.attrs.class = 'hovered'; },
    page => { page.nodes[0]!.attrs.style = 'outline: 1px solid'; },
    page => { page.nodes[0]!.attrs.title = 'Continue [ctrl-option-c]'; },
  ];
  for (const mutate of cosmetic) {
    const { controller, page } = setup(); const seen = await controller.observe({ scope }); mutate(page);
    assert.equal((await controller.act(action(seen))).status, 'executed');
    assert.equal(page.nodes[0]!.clicks, 1); controller.close();
  }
  const { controller, page } = setup(); const seen = await controller.observe({ scope });
  page.nodes[0]!.rect.x += 1; page.nodes[0]!.hit = false;
  assert.equal((await controller.act(action(seen))).status, 'blocked', 'a shift under an overlay is still occluded');
  controller.close();
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { getBrowserCandidates, resolveWsUrl, Session } from './session.ts';
import { resetExtensionHub, setExtensionClient } from './extension-hub.ts';
import { WIRE_CLOSED, WIRE_OPEN, type Wire, type WireEventType, type WireListener } from './wire.ts';

class FakeWire implements Wire {
  readyState = WIRE_OPEN;
  sent: string[] = [];
  private listeners: Record<WireEventType, WireListener[]> = {
    message: [], close: [], error: [], open: [],
  };
  send(data: string) {
    this.sent.push(data);
    const msg = JSON.parse(data) as { id: number; method: string };
    const result = msg.method === 'Target.getTargets' ? { targetInfos: [] } : {};
    queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id: msg.id, result }) }));
  }
  close() {
    this.readyState = WIRE_CLOSED;
    this.emit('close', {});
  }
  addEventListener(type: WireEventType, listener: WireListener) {
    this.listeners[type].push(listener);
  }
  emit(type: WireEventType, ev: { data?: string }) {
    for (const fn of this.listeners[type]) fn(ev);
  }
}

test('explicit remote host resolution cannot redirect to another host or local discovery', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://other.invalid:9222/devtools/browser/no' }));
    await assert.rejects(resolveWsUrl({ host: 'authorized.invalid', port: 9222 }), /Could not resolve/);
    globalThis.fetch = async () => new Response(JSON.stringify({ webSocketDebuggerUrl: 'ws://authorized.invalid:9222/devtools/browser/yes' }));
    assert.equal(await resolveWsUrl({ host: 'authorized.invalid', port: 9222 }), 'ws://authorized.invalid:9222/devtools/browser/yes');
    globalThis.fetch = async () => { throw new Error('offline'); };
    await assert.rejects(resolveWsUrl({ host: 'authorized.invalid', port: 9222 }), /Could not resolve/);
  } finally { globalThis.fetch = original; }
});

test('getBrowserCandidates includes Helium on every supported platform', () => {
  assert.deepEqual(
    getBrowserCandidates('/Users/me', 'darwin').find(candidate => candidate.name === 'Helium'),
    {
      name: 'Helium',
      profileDir: '/Users/me/Library/Application Support/net.imput.helium',
    },
  );
  assert.deepEqual(
    getBrowserCandidates('/home/me', 'linux').find(candidate => candidate.name === 'Helium'),
    {
      name: 'Helium',
      profileDir: '/home/me/.config/net.imput.helium',
    },
  );
  assert.deepEqual(
    getBrowserCandidates('C:\\Users\\me', 'win32', 'C:\\Users\\me\\AppData\\Local').find(
      candidate => candidate.name === 'Helium',
    ),
    {
      name: 'Helium',
      profileDir: 'C:\\Users\\me\\AppData\\Local\\imput\\Helium\\User Data',
    },
  );
});

test('connect auto prefers a live extension wire over remote debugging', async () => {
  resetExtensionHub();
  const wire = new FakeWire();
  setExtensionClient(wire);
  const session = new Session();
  await session.connect({ extensionWaitMs: 20 });
  assert.equal(session.isConnected(), true);
  assert.equal(session.getTransport(), 'extension');
  const { targetInfos } = await session.domains.Target.getTargets({});
  assert.deepEqual(targetInfos, []);
  session.setActiveSession('sid-keep');
  await session._call('Chrome.group', { tabIds: ['1'] });
  const chromeMsg = JSON.parse(wire.sent.at(-1)!) as { method: string; sessionId?: string };
  assert.equal(chromeMsg.method, 'Chrome.group');
  assert.equal(chromeMsg.sessionId, undefined);
  session.close();
  resetExtensionHub();
});

test('reconnect preserves explicit authorized settings and refuses scoped replay', async () => {
  const session = new Session();
  const options = { wsUrl: 'ws://authorized.invalid/devtools/browser/a', transport: 'cdp' as const, autoAllow: false, timeoutMs: 123, autoAllowDelayMs: 321 };
  const captured: unknown[] = [];
  let wire!: FakeWire;
  // Inject the connection boundary: no real WebSocket/discovery/browser control.
  (session as any)._connect = async (opts: unknown) => {
    captured.push({ ...(opts as object) }); wire = new FakeWire(); (session as any).bindWire(wire, 'cdp');
  };
  await session.connect(options);
  const generation = session.getConnectionGeneration();
  session.setActiveSession('old-active');
  wire.close();
  assert.ok(session.getConnectionGeneration() > generation);
  assert.equal(session.getActiveSession(), undefined);
  await assert.rejects(session._call('Runtime.evaluate', {}, { sessionId: 'old-scoped' }), /reattach/);
  assert.deepEqual(captured, [options, options]);
  assert.equal(wire.sent.length, 0);
  const replacement = new FakeWire(); session.adoptExtension(replacement);
  assert.equal(session.getTransport(), 'cdp');
  await assert.rejects(session._call('Input.insertText', { text: 'no' }, { sessionId: 'sid', expectedGeneration: generation }), /generation/);
  assert.equal(wire.sent.length, 0);
  session.close();
});

test('extension reconnect stays extension-only and connection replacement rejects pending effects', async () => {
  resetExtensionHub(); const first = new FakeWire(); setExtensionClient(first);
  const session = new Session(); await session.connect({ transport: 'extension', autoAllow: false, timeoutMs: 20 });
  first.send = data => { first.sent.push(data); };
  const effect = session._call('Input.insertText', { text: 'one' }, { sessionId: 'sid' });
  const rejected = assert.rejects(effect, /replaced/);
  const generation = session.getConnectionGeneration();
  const second = new FakeWire(); session.adoptExtension(second); await rejected;
  assert.ok(session.getConnectionGeneration() > generation); assert.equal(second.sent.length, 0);
  second.close(); resetExtensionHub();
  await assert.rejects(session._call('Target.getTargets', {}), /waiting for the browser-harness-js extension/);
  session.close(); resetExtensionHub();
});

test('real Session exposes a synchronous generation fence without reconnecting or replaying guarded calls', async () => {
  const session = new Session(); const wire = new FakeWire(); session.adoptExtension(wire);
  const generation = session.getConnectionGeneration();
  await session._call('Runtime.callFunctionOn', { objectId: 'guard', functionDeclaration: 'function() { return this.act(); }' },
    { sessionId: 'scoped', expectedGeneration: generation });
  assert.equal(wire.sent.length, 1); assert.equal(JSON.parse(wire.sent[0]!).sessionId, 'scoped');
  wire.close(); const disconnected = session.getConnectionGeneration(); assert.ok(disconnected > generation);
  session.connect = async () => { assert.fail('guarded dispatch must not reconnect/discover'); };
  await assert.rejects(session._call('Runtime.callFunctionOn', {}, { sessionId: 'scoped', expectedGeneration: disconnected }), /generation/);
  const replacement = new FakeWire(); session.adoptExtension(replacement);
  await assert.rejects(session._call('Runtime.callFunctionOn', {}, { sessionId: 'scoped', expectedGeneration: generation }), /generation/);
  assert.equal(wire.sent.length, 1); assert.equal(replacement.sent.length, 0); session.close();
});

test('connect({ transport: "extension" }) fails closed when the extension is absent', async () => {
  resetExtensionHub();
  const session = new Session();
  await assert.rejects(
    session.connect({ transport: 'extension', timeoutMs: 30 }),
    /timed out after 30ms waiting for the browser-harness-js extension/,
  );
});

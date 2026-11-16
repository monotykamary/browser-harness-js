import assert from 'node:assert/strict';
import test from 'node:test';
import {
  describeExtensions,
  extensionConnected,
  getExtensionClient,
  helloFromUrl,
  labelExtension,
  listExtensions,
  resetExtensionHub,
  setExtensionClient,
  waitForExtension,
} from './extension-hub.ts';
import { WIRE_CLOSED, WIRE_OPEN, type Wire, type WireEventType, type WireListener } from './wire.ts';

class FakeWire implements Wire {
  readyState = WIRE_OPEN;
  private listeners: Record<WireEventType, WireListener[]> = {
    message: [], close: [], error: [], open: [],
  };
  sent: string[] = [];
  /** Answers hub requests the way the worker does. */
  reply?: (msg: { id: number; method: string; params: any }) => unknown;
  send(data: string) {
    this.sent.push(data);
    const msg = JSON.parse(data);
    if (this.reply) {
      const result = this.reply(msg);
      queueMicrotask(() => { for (const fn of this.listeners.message) fn({ data: JSON.stringify({ id: msg.id, result }) }); });
    }
  }
  close() {
    this.readyState = WIRE_CLOSED;
    for (const fn of this.listeners.close) fn({});
  }
  addEventListener(type: WireEventType, listener: WireListener) {
    this.listeners[type].push(listener);
  }
}

test.afterEach(() => resetExtensionHub());

test('waitForExtension resolves immediately when a client is already up', async () => {
  const wire = new FakeWire();
  setExtensionClient(wire);
  assert.equal(extensionConnected(), true);
  assert.equal((await waitForExtension(10)).wire, wire);
  assert.equal(getExtensionClient(), wire);
});

test('waitForExtension resolves when the client connects later', async () => {
  const pending = waitForExtension(200);
  const wire = new FakeWire();
  setExtensionClient(wire);
  assert.equal((await pending).wire, wire);
});

test('waitForExtension times out when nothing connects', async () => {
  await assert.rejects(waitForExtension(20), /timed out after 20ms/);
});

test('a closed client is no longer offered', () => {
  const wire = new FakeWire();
  setExtensionClient(wire);
  wire.close();
  assert.equal(getExtensionClient(), undefined);
  assert.equal(extensionConnected(), false);
});

test('each profile keeps its own slot; only the same instance replaces its socket', () => {
  const a = new FakeWire(); const b = new FakeWire();
  setExtensionClient(a, { id: 'profile-a' });
  setExtensionClient(b, { id: 'profile-b', label: 'Work' });
  assert.equal(a.readyState, WIRE_OPEN);
  assert.deepEqual(listExtensions().map(e => e.id).sort(), ['profile-a', 'profile-b']);
  assert.throws(() => getExtensionClient(), /2 browser-harness-js extensions are connected/);
  assert.equal(getExtensionClient('work'), b);
  const a2 = new FakeWire();
  setExtensionClient(a2, { id: 'profile-a' });
  assert.equal(a.readyState, WIRE_CLOSED);
  assert.equal(getExtensionClient('profile-a'), a2);
  assert.equal(listExtensions().length, 2);
});

test('an extension that sends no id keeps the old single legacy slot', () => {
  const a = new FakeWire(); const b = new FakeWire();
  setExtensionClient(a); setExtensionClient(b);
  assert.equal(a.readyState, WIRE_CLOSED);
  assert.deepEqual(listExtensions().map(e => e.id), ['legacy']);
});

test('an unnamed waiter rejects once a second profile makes the choice ambiguous', async () => {
  setExtensionClient(new FakeWire(), { id: 'one' });
  setExtensionClient(new FakeWire(), { id: 'two' });
  await assert.rejects(waitForExtension(50), /2 browser-harness-js extensions/);
});

test('helloFromUrl reads the worker identity from the upgrade URL', () => {
  assert.deepEqual(helloFromUrl('/extension?id=abc&label=My%20Space&v=0.14.0'), { id: 'abc', label: 'My Space', version: '0.14.0' });
  assert.deepEqual(helloFromUrl('/extension'), { id: undefined, label: undefined, version: undefined });
});

test('describe and label go to the named instance only, outside any Session', async () => {
  const a = new FakeWire(); const b = new FakeWire();
  a.reply = m => m.method === 'Extension.getInfo' ? { label: '', tabCount: 1, tabs: [{ targetId: '1', url: 'https://a.test/', title: 'A', active: true }] } : { label: m.params.label };
  b.reply = () => ({ label: 'Home', tabCount: 0, tabs: [] });
  setExtensionClient(a, { id: 'profile-a' });
  setExtensionClient(b, { id: 'profile-b', label: 'Home' });
  const described = await describeExtensions();
  assert.equal(described.find(d => d.id === 'profile-a')?.tabs?.[0]?.url, 'https://a.test/');
  assert.ok(JSON.parse(a.sent[0]!).id < 0, 'hub requests use negative ids so they never collide with Session calls');
  await assert.rejects(labelExtension('profile-a', 'home'), /already used/);
  const labeled = await labelExtension('profile-a', 'Work');
  assert.equal(labeled.label, 'Work');
  assert.equal(getExtensionClient('work'), a);
  assert.equal(b.sent.length, 1);
});

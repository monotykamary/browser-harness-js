import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('./browser-cdp', import.meta.url));
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);

type Tab = { id: string; type: string; url: string; title: string };
const tabs: Tab[] = [
  { id: 'AAA111', type: 'page', url: 'https://one.example/a', title: 'one a' },
  { id: 'BBB222', type: 'page', url: 'https://one.example/b', title: 'one b' },
  { id: 'CCC333', type: 'page', url: 'https://two.example/', title: 'two' },
  { id: 'SW1', type: 'service_worker', url: 'https://sw.example/worker.js', title: 'sw' },
];

// Fake CDP endpoint: /json lists the tabs; the websocket answers Page.getLayoutMetrics and
// Page.captureScreenshot and records every call so tests can assert on the params sent.
function fakeCdp(): Promise<{ server: http.Server; calls: { method: string; params: any }[]; port: number }> {
  const calls: { method: string; params: any }[] = [];
  const server = http.createServer((_req, res) => {
    const { port } = server.address() as { port: number };
    res.end(JSON.stringify(tabs.map((t) => ({ ...t, webSocketDebuggerUrl: `ws://127.0.0.1:${port}/ws/${t.id}` }))));
  });
  server.on('upgrade', (req, sock) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sock.on('data', (b: Buffer) => {
      if (b[0] !== 0x81) return void sock.end();
      let len = b[1] & 127, off = 2;
      if (len === 126) { len = b.readUInt16BE(2); off = 4; }
      const mask = b.subarray(off, off + 4);
      const body = Buffer.from(b.subarray(off + 4, off + 4 + len).map((x, i) => x ^ mask[i % 4]));
      const msg = JSON.parse(body.toString());
      calls.push({ method: msg.method, params: msg.params });
      const result = msg.method === 'Page.getLayoutMetrics'
        ? { cssContentSize: { width: 800, height: 2400 }, contentSize: { width: 1, height: 1 } }
        : { data: png.toString('base64') };
      const out = Buffer.from(JSON.stringify({ id: msg.id, result }));
      const head = out.length < 126 ? Buffer.from([0x81, out.length]) : Buffer.from([0x81, 126, out.length >> 8, out.length & 255]);
      sock.write(Buffer.concat([head, out]));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, port: (server.address() as { port: number }).port })));
}

function run(port: number, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', bin, ...args], { env: { ...process.env, BROWSER_CDP_PORT: String(port) } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ stdout, stderr, code }));
    child.stdin.end();
  });
}

const scratch = () => mkdtempSync(join(tmpdir(), 'browser-cdp-shot-'));

test('shot <url-substring> writes the decoded png, mode 0644, prints one line', async () => {
  const { server, calls, port } = await fakeCdp();
  try {
    const out = join(scratch(), 'a.png');
    const r = await run(port, ['shot', 'two.example', out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${out} ${png.length} bytes\n`);
    assert.deepEqual(readFileSync(out), png);
    assert.equal(statSync(out).mode & 0o777, 0o644);
    assert.deepEqual(calls, [{ method: 'Page.captureScreenshot', params: { format: 'png' } }]);
  } finally { server.close(); }
});

test('shot <targetId> matches by exact id', async () => {
  const { server, port } = await fakeCdp();
  try {
    const out = join(scratch(), 'b.png');
    const r = await run(port, ['shot', 'BBB222', out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readFileSync(out), png);
  } finally { server.close(); }
});

test('shot --full-page sets captureBeyondViewport and the layout-metrics clip, flag order free', async () => {
  const { server, calls, port } = await fakeCdp();
  try {
    const out = join(scratch(), 'c.png');
    const r = await run(port, ['shot', '--full-page', 'two.example', out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(calls.map((c) => c.method), ['Page.getLayoutMetrics', 'Page.captureScreenshot']);
    assert.deepEqual(calls[1].params, {
      format: 'png', captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: 800, height: 2400, scale: 1 },
    });
  } finally { server.close(); }
});

test('shot with two URL matches lists both and exits 2, writes nothing', async () => {
  const { server, calls, port } = await fakeCdp();
  try {
    const out = join(scratch(), 'd.png');
    const r = await run(port, ['shot', 'one.example', out]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /2 tabs match one\.example/);
    assert.match(r.stderr, /AAA111\thttps:\/\/one\.example\/a/);
    assert.match(r.stderr, /BBB222\thttps:\/\/one\.example\/b/);
    assert.equal(calls.length, 0);
    assert.throws(() => statSync(out));
  } finally { server.close(); }
});

test('shot ignores non-page targets when matching by URL', async () => {
  const { server, port } = await fakeCdp();
  try {
    const r = await run(port, ['shot', 'sw.example', join(scratch(), 'e.png')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no tab matches: sw\.example/);
  } finally { server.close(); }
});

test('shot with no matching tab exits 1', async () => {
  const { server, port } = await fakeCdp();
  try {
    const r = await run(port, ['shot', 'nope.example', join(scratch(), 'f.png')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /no tab matches: nope\.example/);
  } finally { server.close(); }
});

test('shot reports a write failure with a non-zero exit', async () => {
  const { server, port } = await fakeCdp();
  try {
    const r = await run(port, ['shot', 'two.example', join(scratch(), 'missing-dir', 'g.png')]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot write .*g\.png/);
  } finally { server.close(); }
});

test('shot over an existing 0600 file ends 0644', async () => {
  const { server, port } = await fakeCdp();
  try {
    const out = join(scratch(), 'h.png');
    writeFileSync(out, 'old');
    chmodSync(out, 0o600);
    const r = await run(port, ['shot', 'two.example', out]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(statSync(out).mode & 0o777, 0o644);
    assert.deepEqual(readFileSync(out), png);
  } finally { server.close(); }
});

test('shot argument errors and --help need no browser', async () => {
  const missing = await run(1, ['shot', 'two.example']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /usage: browser-cdp shot/);
  const extra = await run(1, ['shot', 'a', 'b.png', 'c']);
  assert.equal(extra.code, 1);
  assert.match(extra.stderr, /usage: browser-cdp shot/);
  const help = await run(1, ['shot', '--help']);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /shot <url-substring-or-targetId> <out\.png> \[--full-page\]/);
});

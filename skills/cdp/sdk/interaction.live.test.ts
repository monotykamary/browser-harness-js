import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';
import { InteractionController, type InteractionObservation } from './interaction.ts';
import { Session } from './session.ts';

// Real headless Chrome against local widgets that a fake DOM cannot model:
// ARIA naming, pointer-only handlers, autocomplete comboboxes, keyboard
// navigation, native selects and contenteditable text.

const PAGE = `<!doctype html>
<html><head><title>Guarded widgets</title>
<style>
  body { font: 14px sans-serif; margin: 16px; }
  [role=listbox] { border: 1px solid #999; margin: 0; padding: 0; list-style: none; width: 220px; }
  [role=option][aria-selected=true] { background: #cde; }
  [contenteditable] { border: 1px solid #999; min-height: 20px; width: 220px; }
  [role=switch] { display: inline-block; width: 36px; height: 18px; border: 1px solid #999; }
</style></head>
<body>
  <span id="save-label">Save draft</span>
  <div role="button" tabindex="0" aria-labelledby="save-label" id="save">💾</div>
  <div role="button" tabindex="0" id="pointer-only">Pointer only</div>

  <label id="from-label" for="from">Where from?</label>
  <input id="from" role="combobox" aria-labelledby="from-label" aria-expanded="false"
         aria-autocomplete="list" aria-controls="from-list" autocomplete="off">
  <ul role="listbox" id="from-list" hidden></ul>

  <select id="cabin" aria-label="Cabin class">
    <option>Economy</option><option>Premium economy</option><option>Business</option>
  </select>

  <div role="textbox" contenteditable="true" aria-label="Notes" id="notes"></div>

  <div role="tablist">
    <div role="tab" aria-selected="true" tabindex="0" id="tab-one">One way</div>
    <div role="tab" aria-selected="false" tabindex="-1" id="tab-round">Round trip</div>
  </div>
  <div role="switch" aria-checked="false" tabindex="0" aria-label="Nonstop only" id="nonstop"></div>

  <output id="log"></output>
<script>
  const log = text => { document.getElementById('log').textContent += text + ';'; };
  const cities = ['Zurich', 'Zug', 'London'];
  const from = document.getElementById('from');
  const list = document.getElementById('from-list');
  let active = -1;
  function render(matches) {
    list.innerHTML = '';
    matches.forEach((city, i) => {
      const li = document.createElement('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      li.textContent = city;
      li.addEventListener('pointerdown', () => choose(city));
      list.appendChild(li);
    });
    list.hidden = matches.length === 0;
    from.setAttribute('aria-expanded', String(matches.length > 0));
  }
  const matches = () => cities.filter(city => from.value && city.toLowerCase().startsWith(from.value.toLowerCase()));
  function choose(city) { from.value = city; active = -1; render([]); log('from=' + city); }
  from.addEventListener('input', () => { active = -1; render(matches()); });
  from.addEventListener('keydown', event => {
    const found = matches();
    if (event.key === 'ArrowDown' && found.length) { active = Math.min(active + 1, found.length - 1); render(found); event.preventDefault(); }
    if (event.key === 'Enter' && active >= 0) { choose(found[active]); event.preventDefault(); }
  });
  document.getElementById('save').addEventListener('click', () => log('saved'));
  // Like many component libraries: acts on pointerdown and ignores synthetic click().
  document.getElementById('pointer-only').addEventListener('pointerdown', () => log('pointer'));
  document.getElementById('cabin').addEventListener('change', event => log('cabin=' + event.target.value));
  for (const tab of document.querySelectorAll('[role=tab]')) {
    tab.addEventListener('click', () => {
      for (const other of document.querySelectorAll('[role=tab]')) other.setAttribute('aria-selected', String(other === tab));
    });
  }
  const nonstop = document.getElementById('nonstop');
  nonstop.addEventListener('click', () => nonstop.setAttribute('aria-checked', String(nonstop.getAttribute('aria-checked') !== 'true')));
</script></body></html>`;

function chromePath(): string | undefined {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find(path => path && existsSync(path));
}

let chrome: ChildProcess | undefined;
let server: Server | undefined;
let profile: string | undefined;
let port = 0;
let origin = '';

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const path = chromePath();
  if (!path) return;
  profile = mkdtempSync(join(tmpdir(), 'browser-harness-js-guard-'));
  chrome = spawn(path, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1200,900', 'about:blank',
  ], { stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise(r => setTimeout(r, 100));
  port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
});

after(async () => {
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise(resolve => chrome!.once('exit', resolve));
    chrome.kill();
    await exited;
  }
  server?.close();
  if (profile) rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function open(input: 'synthetic' | 'trusted') {
  const session = new Session();
  await session.connect({ port });
  const { targetId } = await session.domains.Target.createTarget({ url: `${origin}/` }) as { targetId: string };
  const { sessionId } = await session.domains.Target.attachToTarget({ targetId, flatten: true }) as { sessionId: string };
  await session._call('Page.enable', {}, { sessionId });
  await session._call('Runtime.evaluate', {
    expression: 'new Promise(r => document.readyState === "complete" ? r() : addEventListener("load", r))',
    awaitPromise: true,
  }, { sessionId });
  const controller = new InteractionController(session, { allowedOrigins: [origin], input });
  const scope = { sessionId };
  const readLog = async () => {
    const result = await session._call('Runtime.evaluate', {
      expression: 'document.getElementById("log").textContent', returnByValue: true,
    }, { sessionId }) as { result: { value: string } };
    return result.result.value;
  };
  const close = async () => {
    controller.close();
    await session.domains.Target.closeTarget({ targetId }).catch(() => {});
    session.close();
  };
  return { controller, scope, readLog, close };
}

const find = (seen: InteractionObservation, label: string) => {
  const candidate = seen.candidates.find(c => c.label === label);
  assert.ok(candidate, `no candidate labelled ${label}: ${seen.candidates.map(c => c.label).join(', ')}`);
  return candidate;
};
const act = (controller: InteractionController, seen: InteractionObservation, label: string, operation: string, extra = {}) =>
  controller.act({ scope: seen.scope, observationId: seen.observationId, action: { targetId: find(seen, label).id, operation, ...extra } });

test('ARIA roles, names and states become candidates; synthetic mode keeps DOM activation', async t => {
  if (!port) return t.skip('Chrome not found (set CHROME_PATH)');
  const page = await open('synthetic');
  try {
    let seen = await page.controller.observe({ scope: page.scope });
    const byLabel = Object.fromEntries(seen.candidates.map(c => [c.label, c]));
    assert.equal(byLabel['Save draft']?.role, 'button');
    assert.deepEqual(byLabel['Where from?']?.operations, ['type', 'click']);
    assert.equal(byLabel['Where from?']?.role, 'combobox');
    assert.equal(byLabel['Where from?']?.expanded, false);
    assert.deepEqual(byLabel['Cabin class']?.options, ['Economy', 'Premium economy', 'Business']);
    assert.equal(byLabel['Cabin class']?.value, 'Economy');
    assert.equal(byLabel['One way']?.selected, true);
    assert.equal(byLabel['Nonstop only']?.checked, false);
    // Contenteditable needs real text input; press needs real keys.
    assert.equal(byLabel.Notes, undefined);
    assert.ok(seen.candidates.every(c => !c.operations.includes('press')));

    assert.equal((await act(page.controller, seen, 'Save draft', 'click')).status, 'executed');
    seen = await page.controller.observe({ scope: page.scope });
    assert.equal((await act(page.controller, seen, 'Cabin class', 'select', { option: 2 })).status, 'executed');
    seen = await page.controller.observe({ scope: page.scope });
    assert.equal(find(seen, 'Cabin class').value, 'Business');
    assert.equal((await act(page.controller, seen, 'Round trip', 'click')).status, 'executed');
    seen = await page.controller.observe({ scope: page.scope });
    assert.equal(find(seen, 'Round trip').selected, true);
    assert.equal((await act(page.controller, seen, 'Nonstop only', 'click')).status, 'executed');
    seen = await page.controller.observe({ scope: page.scope });
    assert.equal(find(seen, 'Nonstop only').checked, true);
    // Out-of-range options and trusted-only operations are refused before dispatch.
    assert.equal((await act(page.controller, seen, 'Cabin class', 'select', { option: 3 })).reason, 'unsupported_action');
    seen = await page.controller.observe({ scope: page.scope });
    assert.equal((await act(page.controller, seen, 'Save draft', 'press', { key: 'Enter' })).reason, 'unsupported_action');
    // element.click() never fires pointerdown: the pointer-only widget ignores it.
    seen = await page.controller.observe({ scope: page.scope });
    assert.equal((await act(page.controller, seen, 'Pointer only', 'click')).status, 'executed');
    assert.equal(await page.readLog(), 'saved;cabin=Business;');
  } finally {
    await page.close();
  }
});

test('trusted input drives pointer-only widgets, autocomplete comboboxes, keys and contenteditable', async t => {
  if (!port) return t.skip('Chrome not found (set CHROME_PATH)');
  const page = await open('trusted');
  try {
    let seen = await page.controller.observe({ scope: page.scope });
    assert.ok(find(seen, 'Save draft').operations.includes('press'));
    assert.equal((await act(page.controller, seen, 'Pointer only', 'click')).status, 'executed');

    // Typing opens the listbox; its options become ordinary candidates.
    seen = await page.controller.observe({ scope: page.scope });
    assert.equal((await act(page.controller, seen, 'Where from?', 'type', { text: 'zu' })).status, 'executed');
    const opened = await page.controller.waitForChange({ scope: page.scope, revision: seen.revision, timeoutMs: 2000 });
    assert.equal(find(opened.observation, 'Where from?').expanded, true);
    assert.deepEqual(opened.observation.candidates.filter(c => c.role === 'option').map(c => c.label), ['Zurich', 'Zug']);

    // Keyboard selection: ArrowDown highlights the first option, Enter chooses it.
    assert.equal((await act(page.controller, opened.observation, 'Where from?', 'press', { key: 'ArrowDown' })).status, 'executed');
    seen = await page.controller.observe({ scope: page.scope });
    assert.equal(find(seen, 'Zurich').selected, true);
    assert.equal((await act(page.controller, seen, 'Where from?', 'press', { key: 'Enter' })).status, 'executed');
    seen = await page.controller.observe({ scope: page.scope });
    assert.equal(find(seen, 'Where from?').value, 'Zurich');
    assert.equal(find(seen, 'Where from?').expanded, false);

    // Replacing contenteditable text is only possible with real text input.
    assert.equal((await act(page.controller, seen, 'Notes', 'type', { text: 'window seat' })).status, 'executed');
    seen = await page.controller.observe({ scope: page.scope });
    assert.equal(find(seen, 'Notes').value, 'window seat');
    assert.equal((await act(page.controller, seen, 'Notes', 'type', { text: 'aisle' })).status, 'executed');
    seen = await page.controller.observe({ scope: page.scope });
    assert.equal(find(seen, 'Notes').value, 'aisle');
    // Unknown keys never reach the page.
    assert.equal((await act(page.controller, seen, 'Save draft', 'press', { key: 'F12' })).reason, 'unsupported_action');
    assert.equal(await page.readLog(), 'pointer;from=Zurich;');
  } finally {
    await page.close();
  }
});

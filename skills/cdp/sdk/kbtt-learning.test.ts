// Offline test for the kbtt-tam-tru browser tools: loads them through the real
// learnings() loader with a fake session whose Runtime.evaluate runs the
// wrapped expression in a vm against a tiny hand-built DOM. No browser.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { extraHelpers } from './helpers.ts';

const { learnings } = extraHelpers;

type Fake = Record<string, unknown>;

function el(props: Fake = {}): any {
  const events: string[] = [];
  const node: any = {
    value: '', clicked: 0, events, classList: { contains: () => false },
    focus() {}, click() { node.clicked++; },
    dispatchEvent(e: { type: string }) { events.push(e.type); return true; },
    getAttribute(n: string) { return node.attrs?.[n] ?? null; },
    getBoundingClientRect: () => ({ width: node.width ?? 0 }),
    querySelectorAll: () => [], querySelector: () => null,
    ...props,
  };
  return node;
}

class FakeEvent { type: string; constructor(type: string) { this.type = type; } }

async function runTool(dom: Fake, tool: string, args: unknown, extra: Fake = {}) {
  const g = globalThis as any;
  const prev = g.session;
  const ctx = vm.createContext({ document: dom, window: {}, MouseEvent: FakeEvent, Event: FakeEvent, MessageChannel, ...extra });
  g.session = { domains: { Runtime: { evaluate: async ({ expression }: { expression: string }) => ({ result: { value: JSON.parse(JSON.stringify((await vm.runInContext(expression, ctx)) ?? null)) } }) } } };
  try { return await learnings('kbtt-tam-tru', tool, args); } finally { g.session = prev; }
}

test('learnings("kbtt-tam-tru") lists the five browser tools', async () => {
  const r = (await learnings('kbtt-tam-tru')) as { browserTools: string[]; notes: string[] };
  assert.deepEqual([...r.browserTools].sort(), ['captcha_image', 'fill_login', 'history_range', 'history_rows', 'print_row_pdf']);
  assert.deepEqual(r.notes, ['notes/overview.md']);
});

test('fill_login: sets both fields, fires input+change, returns booleans only', async () => {
  const proto = { set value(v: string) { (this as any).stored = v; }, get value() { return (this as any).stored ?? ''; } };
  const u = el(); const p = el();
  for (const f of [u, p]) { delete f.value; Object.setPrototypeOf(f, proto); }
  const dom = { getElementById: (id: string) => (id === 'form_item_username' ? u : id === 'form_item_password' ? p : null), querySelector: () => null };
  const extra = { HTMLInputElement: { prototype: proto } };
  assert.deepEqual(await runTool(dom, 'fill_login', { username: 'user-x', password: 'pw-x' }, extra), { username: true, password: true });
  assert.deepEqual(u.events, ['input', 'change']);
  assert.equal(u.stored, 'user-x');
  assert.deepEqual(await runTool(dom, 'fill_login', { username: 'a' }, extra), { username: true, password: false });
});

test('captcha_image: returns the wide data:image base64, null otherwise', async () => {
  const small = el({ attrs: { src: 'data:image/png;base64,SMALL' }, width: 20 });
  const wide = el({ attrs: { src: 'data:image/png;base64,QUJD' }, width: 240 });
  assert.equal(await runTool({ querySelectorAll: () => [small, wide] }, 'captcha_image', {}), 'QUJD');
  assert.equal(await runTool({ querySelectorAll: () => [small] }, 'captcha_image', {}), null);
});

test('history_rows: cell text per row, skips placeholder and cell-less rows', async () => {
  const cell = (t: string) => ({ innerText: ' ' + t + ' ' });
  const row = (cells: unknown[], cls = '') => el({ classList: { contains: (c: string) => c === cls }, querySelectorAll: () => cells });
  const rows = [row([cell('1'), cell('A')]), row([cell('Trống')], 'ant-table-placeholder'), row([]), row([cell('2'), cell('B')])];
  const r = await runTool({ querySelectorAll: () => rows }, 'history_rows', {});
  assert.deepEqual(r, [['1', 'A'], ['2', 'B']]);
});

test('history_range: rejects bad dates and a missing picker without touching the page', async () => {
  const bad = (await runTool({ querySelector: () => null }, 'history_range', { from: '31/10/2026', to: '2026-11-01' })) as any;
  assert.equal(bad.ok, false);
  assert.equal(bad.step, 'args');
  const none = (await runTool({ querySelector: () => null }, 'history_range', { from: '2026-10-01', to: '2026-11-01' })) as any;
  assert.equal(none.step, 'picker-input');
});

test('print_row_pdf: clicks the matching row once, returns pending without a blob iframe', async () => {
  const button = el();
  const rowMatch = el({ textContent: 'ROW-42 something', querySelector: () => button });
  const rowOther = el({ textContent: 'other', querySelector: () => el() });
  // One shared window so the re-call guard persists between calls, like a real page.
  const dom = { querySelector: () => null, querySelectorAll: () => [rowOther, rowMatch] };
  const win: any = {};
  const extra = { window: win, Date };
  assert.deepEqual(await runTool(dom, 'print_row_pdf', { match: 'ROW-42' }, extra), { status: 'pending' });
  assert.equal(button.clicked, 1);
  assert.deepEqual(await runTool(dom, 'print_row_pdf', { match: 'ROW-42' }, extra), { status: 'pending' });
  assert.equal(button.clicked, 1, 'second call must not re-click');
  assert.equal(((await runTool(dom, 'print_row_pdf', { match: 'nope' }, extra)) as any).status, 'error');
});

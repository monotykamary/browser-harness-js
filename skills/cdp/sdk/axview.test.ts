import assert from 'node:assert/strict';
import test from 'node:test';
import { axView, parseAxRefs, parseAxLocators } from './axview.ts';

// Minimal AX fixtures shaped like Accessibility.getFullAXTree returns:
// role/name wrapped in {value}, properties as [{name, value:{value}}].
function node(
  n: number, role: string, name: string,
  childIds: number[] = [], backendDOMNodeId?: number,
  ignored = false, properties: any[] = [],
) {
  return {
    nodeId: n,
    role: role ? { value: role, type: 'role' } : undefined,
    name: name ? { value: name } : undefined,
    childIds,
    backendDOMNodeId,
    ignored,
    properties,
  };
}

// DFS pre-order emit: root -> navigation (whose child Log in first) -> Donate -> Submit.
// refs map: [1]=root(100) [2]=navigation(101) [3]=link Log in(104) [4]=link Donate(102) [5]=button Submit(103).
const SAMPLE = [
  node(1, 'RootWebArea', 'Page', [2, 3, 4], 100, false),
  node(2, 'navigation', 'Site', [5], 101, false),
  node(3, 'link', 'Donate', [], 102, false),
  node(4, 'button', 'Submit', [], 103, false, [{ name: 'focused', value: { value: true } }]),
  node(5, 'link', 'Log in', [], 104, false),
];

test('axView assigns [n] refs and a trailing backendDOMNodeId map', () => {
  const view = axView(SAMPLE);
  assert.match(view, /\[1\] RootWebArea "Page"/);
  assert.match(view, /\[2\] navigation "Site"/);
  assert.match(view, /\[3\] link "Log in"/);
  assert.match(view, /\[4\] link "Donate"/);
  assert.match(view, /\[5\] button "Submit"/);
  assert.match(view, /# refs -> backendDOMNodeId/);
  assert.match(view, /\[1\]=100 \[2\]=101 \[3\]=104 \[4\]=102 \[5\]=103/);
});

test('parseAxRefs reads the trailing map (DFS order)', () => {
  const refs = parseAxRefs(axView(SAMPLE));
  assert.equal(refs.get(1), 100);
  assert.equal(refs.get(3), 104); // link "Log in" — child of navigation
  assert.equal(refs.get(4), 102); // link "Donate"
  assert.equal(refs.get(5), 103); // button "Submit"
  assert.equal(refs.get(99), undefined);
});

test('parseAxRefs tolerates an omitted refs map (refs:false)', () => {
  const refs = parseAxRefs(axView(SAMPLE, { refs: false }));
  assert.equal(refs.size, 0);
});

test('locators off by default: no loc= anywhere', () => {
  assert.doesNotMatch(axView(SAMPLE), /loc=/);
});

test('locators: true emits loc=role:<role>["<name>"] per ref', () => {
  const view = axView(SAMPLE, { locators: true });
  assert.match(view, /\[3\]=104 loc=role:link\["Log in"\]/);
  assert.match(view, /\[4\]=102 loc=role:link\["Donate"\]/);
  assert.match(view, /\[5\]=103 loc=role:button\["Submit"\]/);
});

test('parseAxLocators parses emitted locators', () => {
  const view = axView(SAMPLE, { locators: true });
  const locs = parseAxLocators(view);
  assert.equal(locs.get(3), 'role:link["Log in"]');
  assert.equal(locs.get(4), 'role:link["Donate"]');
  assert.equal(locs.get(5), 'role:button["Submit"]');
  assert.equal(locs.get(99), undefined);
});

test('locators + refs:false emits a separate # locators section', () => {
  const view = axView(SAMPLE, { locators: true, refs: false });
  assert.match(view, /# locators/);
  assert.match(view, /\[4\] role:link\["Donate"\]/);
  assert.doesNotMatch(view, /backendDOMNodeId/);
  assert.equal(parseAxLocators(view).get(4), 'role:link["Donate"]');
});

test('parseAxRefs still works on the multi-line locator map', () => {
  const refs = parseAxRefs(axView(SAMPLE, { locators: true }));
  assert.equal(refs.get(3), 104);
  assert.equal(refs.get(4), 102);
});

test('names with spaces survive parse round-trip', () => {
  const q = [
    node(1, 'RootWebArea', 'Page', [2], 100, false),
    node(2, 'link', 'Foo Bar', [], 200, false),
  ];
  const view = axView(q, { locators: true });
  assert.equal(parseAxLocators(view).get(2), 'role:link["Foo Bar"]');
});

test('names with double quotes survive parse round-trip (built via JSON.stringify)', () => {
  const q = [
    node(1, 'RootWebArea', 'Page', [2], 100, false),
    node(2, 'link', 'Foo "Bar" Baz', [], 200, false),
  ];
  const view = axView(q, { locators: true });
  // axView builds locators with JSON.stringify(name); mirror that to avoid hand-escaping quotes.
  const expected = 'role:link[' + JSON.stringify('Foo "Bar" Baz') + ']';
  assert.equal(parseAxLocators(view).get(2), expected);
});

test('interactive mode drops StaticText and headings, keeps interactive + landmarks', () => {
  const withText = [
    node(1, 'RootWebArea', 'P', [2, 3, 4], 1, false),
    node(2, 'link', 'Go', [], 2, false),
    node(3, 'heading', 'Section', [], 3, false),
    node(4, 'StaticText', 'paragraph text here', [], 0, false),
  ];
  const view = axView(withText, { interactive: true });
  assert.match(view, /link "Go"/);
  assert.doesNotMatch(view, /paragraph text here/);
  assert.doesNotMatch(view, /heading "Section"/);
});
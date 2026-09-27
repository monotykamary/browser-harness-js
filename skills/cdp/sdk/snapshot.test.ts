import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAX, snapshotDiff, SnapshotLimitError, nodeIdentity, type AXNode } from './snapshot.ts';
const node = (id: number, role: string, name = '', children: number[] = [], extra: Partial<AXNode> = {}): AXNode => ({
  nodeId: String(id), ignored: false, role: { type: 'role', value: role }, name: { type: 'string', value: name },
  backendDOMNodeId: id, childIds: children.map(String), ...extra,
});
const render = (nodes: AXNode[], options = {}) => renderAX(nodes, options, n => `e${n.backendDOMNodeId}`);

test('real CDP top-level values survive interactive projection, including zero and empty input', () => {
  const nodes = [node(1, 'RootWebArea', 'Page', [2,3,4]),
    node(2, 'textbox', 'Query', [], { value: { type: 'string', value: '' } }),
    node(3, 'slider', 'Budget', [], { value: { type: 'number', value: 0 } }),
    node(4, 'combobox', 'Cabin', [], { value: { type: 'string', value: 'Business' } })];
  const { tree } = render(nodes, { interactive: true });
  assert.match(tree, /textbox.*value=""/); assert.match(tree, /slider.*value=0/); assert.match(tree, /combobox.*value="Business"/);
});
test('table cells, lists, named groups and escaped labels retain content and relationships', () => {
  const nodes = [node(1,'RootWebArea','Page',[2,6]),node(2,'table','Fares',[3]),node(3,'row','',[4]),
    node(4,'cell','Example Air',[5]),node(5,'StaticText','Example Air'),node(6,'group','Outbound',[7]),node(7,'button','Select "seat"')];
  const { tree } = render(nodes);
  assert.match(tree,/table "Fares"/); assert.match(tree,/row/); assert.equal(tree.match(/Example Air/g)?.length,1);
  assert.ok(tree.includes('Select \\"seat\\"')); assert.match(render(nodes,{interactive:true}).tree,/group "Outbound"/);
});
test('forests and ignored roots retain all matches; repeated children and cycles do not recurse forever', () => {
  const nodes = [node(1,'none','',[2],{ignored:true}), node(2,'button','First'),node(3,'button','Second',[3])];
  const tree=render(nodes).tree; assert.match(tree,/First/);assert.match(tree,/Second/);
  assert.equal(tree.match(/Second/g)?.length,1);
});
test('redaction covers real values and all descendant text without exposing secrets in refs', () => {
  const nodes=[node(1,'textbox','Password',[2],{value:{type:'string',value:'secret-value'}}),node(2,'StaticText','secret-value')];
  const {tree}=render(nodes);assert.match(tree,/redacted/);assert.ok(!tree.includes('secret-value'));
  assert.equal(nodeIdentity(nodes[0]!).length,64);
});
test('depth truncation is explicit; character/input limits fail without returning a partial tree', () => {
  const nodes=[node(1,'group','Group',[2]),node(2,'button','Target')];
  assert.equal(render(nodes,{maxDepth:0}).truncated,true);assert.match(render(nodes,{maxDepth:0}).tree,/truncated/);
  assert.throws(()=>render(nodes,{maxChars:5}),SnapshotLimitError);
  assert.throws(()=>render(nodes,{maxDepth:-1}),/maxDepth/);
});
test('diff ignores ref churn, retains duplicate counts and surfaces reorders', () => {
  const a='- button "Save" [ref=s1e1]\n- button "Other" [ref=s1e2]';
  const b='- button "Save" [ref=s2e1]\n- button "Other" [ref=s2e2]';
  const before=new Map([['s1e1','frame:1'],['s1e2','frame:2']]);const after=new Map([['s2e1','frame:1'],['s2e2','frame:2']]);
  assert.equal(snapshotDiff(a,b,after,before),'(no changes)');
  assert.match(snapshotDiff(a,b.split('\n').reverse().join('\n'),after,before),/order changed/);
  assert.equal(snapshotDiff('text\ntext','text',new Map(),new Map()),'- text');
});

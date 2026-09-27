# Native accessibility internals (advanced CDP)

For normal reading and actions use [page.snapshot()](snapshot.md) and
`page.getByRole(role,{name})`. This recipe is for exact AX properties, sources,
wire-sized queries and unsupported mechanics. Raw node IDs are not guarded
handles; never turn a guard denial into a raw coordinate click.

## A scoped semantic query

`Accessibility.queryAXTree` requires a DOM `nodeId`, `backendNodeId` or
`objectId`; a bare role/name query is insufficient. Route every call through
the same explicit attachment:

```js
const {root} = await page.cdp('DOM.getDocument', {});
const {nodes} = await page.cdp('Accessibility.queryAXTree', {
  nodeId: root.nodeId, role: 'button', accessibleName: 'Submit'
});
return nodes.filter(n => !n.ignored).map(n => ({
  role:n.role?.value, name:n.name?.value, value:n.value?.value,
  backendNodeId:n.backendDOMNodeId,
  state:Object.fromEntries((n.properties ?? []).map(p => [p.name,p.value?.value]))
}));
```

For a subtree, first `DOM.querySelector({nodeId:root.nodeId,selector:'#panel'})`,
then pass the returned node ID to `queryAXTree`. Do not pick the first match
when multiple results represent different choices. Explicit routing is also
available as `cdp(page.scope.sessionId,method,params)`; no `session.use()` is
needed or appropriate for concurrent work.

## Methods

| Method | Use |
|---|---|
| `queryAXTree` | Filter a DOM subtree by role/name; may return multiple disconnected roots |
| `getPartialAXTree` | Node plus optional ancestors/siblings/children; `fetchRelatives:false` for the node itself |
| `getFullAXTree` | Complete frame tree; large responses can exceed transport limits |
| `getRootAXNode` / `getChildAXNodes` | Native AX traversal; enable Accessibility first |
| `getAXNodeAndAncestors` | Trace native semantic ancestry |

`queryAXTree` and `getFullAXTree` need no `Accessibility.enable`. Enabling the
domain gives stable AX node IDs for multi-step walks but has a performance
cost; disable it when finished. AX IDs and DOM node IDs are different types of
identity. Purely virtual AX nodes may have no backend DOM node.

`AXNode.value`, not `properties.value`, carries a textbox/slider/combobox value.
Properties carry states such as checked, expanded, disabled, required and
readonly. Native AX can cross shadow boundaries and expose semantics the
action guard deliberately does not support. A readable node is not necessarily
an authorized or actionable target.

Ignored wrappers often own meaningful descendants: recurse through them. Keep
all query-result roots, and do not drop table-cell text simply because a wrapper
or duplicate name is suppressed. The internal snapshot projection handles these
cases; raw queries leave correctness, privacy and bounds to the caller.

For huge pages, scope **the native query**. Snapshot interactive/depth/subtree
options constrain rendered output but currently collect the full frame first.
If a transport drops, reattach and obtain fresh IDs; see
[connection.md](connection.md). Canvas and virtual editors require separately
authorized visual/read-back workflows, not guesses from toolbar AX nodes.

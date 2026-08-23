# example

Placeholder domain demonstrating the learnings registry format. The single
`getOutline` node-tool is intentionally generic (returns H2 headings of
whatever the page is) so you can replace it with a per-site tool: a reverse-
engineered API call extracted from the Network panel, an anti-click-wrap
sibling-selector recipe, a Court/SEC/DTCC site-specific extraction, etc.

Calling from the REPL:

```js
await listLearnings()
await learnings("example")
await learnings("example", "getOutline", { max: 5 })
```

When the agent runs a task repeatedly here, distill the recipe into a tool
rather than re-deriving selectors each call — that is the entire point of the
registry.
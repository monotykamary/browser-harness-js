# Learnings registry

A registry of codified per-site tools the agent can call by name, so it stops
re-deriving recipes (selectors, scraping scripts, API reverse-engineering)
every time. Adapted from ego-browser's `learnings/<domain>/` layout, but
CDP-native: node-tools are plain `.mjs` modules loaded via dynamic `import()`
into the REPL global scope; browser-tools are JS strings evaluated via
`Runtime.evaluate` on the active session.

## Layout

```
learnings/
  README.md
  <domain>/
    manifest.json     # declares nodeTools, browserTools, notes references
    tools/<name>.mjs  # node-tool source (ESM, runs in the REPL Node runtime)
    browser-tools/    # browser-tool source (evaluated in the page)
    notes/*.md         # freeform per-site notes the agent can read
```

## `manifest.json` schema

```jsonc
{
  "id": "x-com",                // URL-fragment-friendly domain key
  "name": "X (Twitter)",        // human label
  "domains": ["x.com", ...],    // optional, for matching request URLs
  "notes": ["notes/overview.md", "notes/timeline.md"],
  "nodeTools": {
    "get_timeline_posts": {
      "description": "Extract posts from the current timeline.",
      "path": "tools/timeline.mjs",   // relative to this dir
      "callable": "getTimelinePosts", // named export to call
      "args": { "maxPosts": {"type":"integer","required":false} },
      "returns": {"type":"array","description":"[] of post objects"}
    }
  },
  "browserTools": {
    "extract_post_from_active_element": {
      "description": "Extract tweet text/author/timestamp from the focused element.",
      "path": "browser-tools/extract-post.js",
      "callable": "extractPostFromActiveElement",
      "args": {},
      "returns": {"type":"object","description":"tweet descriptor"}
    }
  }
}
```

## Calling from the REPL

```js
await listLearnings()                       // -> ["example", "x-com", ...]
await learnings("example")                 // -> {nodeTools, browserTools, notes}
await learnings("example", "getOutline", {max: 5})  // -> call the node-tool
```

A **`nodeTool`** is called as `fn(ctx, args)` where `ctx` carries every REPL
global (so the tool uses `ctx.session`, `ctx.cdp`, `ctx.axView`, ...). It runs
in the same Node process holding the persistent `Session`, so it can compose
multi-step CDP work into one function — write `add snapshot -> act -> verify`
loops here and the model calls one tool instead of re-deriving the recipe.

A **`browserTool`** is the JS source of an ESM-style file (no `export`
questions — the source is concatenated inside an `(async function(args){ ... })()`
wrapper). It runs in the browser page via `Runtime.evaluate`, returns whatever
the named function returns.

When to add a domain: only when you keep re-deriving the same per-site
recipe (court selectors, an API reverse-engineered from a Network panel, an
anti-click-wrap extraction). Interaction-skill recipes that are page-mechanic
rather than site-specific (dropdowns, OOPIFs, waits) belong in
`../interaction-skills/` instead, where they apply to any site.
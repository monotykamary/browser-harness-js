# Agent operating loop — observe, act, verify, return

The per-call CLI shape (`gsearch "x" 3` -> read -> write the next `gsearch follow <url>`)
fits one-shot search/extract. For multi-step browser tasks it is wasteful:
every round trip is a tool call in the model context. Multi-step tasks finish
faster and with fewer tokens when you compose the round **in one heredoc**:
observe, act, verify, return.

The `browser-harness-js <<'EOF' … EOF` heredoc IS the composition primitive.
The shared WebSocket, the persistent `session`, and the per-call `sessionId`
make these heredocs safe to run in parallel — so when the task fits in one
heredoc, compose in one heredoc instead of chaining CLI calls.

**Adapted from ego-browser's "code-base, not CLI-base" framing, but CDP-native:**
helpers are recipes for things CDP structurally lacks (drainable signals,
modal-dialog detection, locator resolution, codified per-site tools), never
wrappers that hide a `session.Domain.method(...)` call. Drop to
`session.Runtime.evaluate(...)` / `cdp(sessionId, ...)` whenever a helper
doesn't cover what you need.

## The loop

For each round (one heredoc):

1. **Observe** the active tab. `axView({ interactive: true })` to lay it out,
   or `Accessibility.queryAXTree` for a single named element (see
   [`accessibility-tree.md`](accessibility-tree.md)). For pages that mutate
   continuously (SPAs, live lists) arm [`attachSignals()`](agent-signals.md)
   BEFORE your action; after the action, `drainSignals()` returns a compact
   digest of dialogs / downloads / navigations / crashes.
2. **Act** on a `[n]` ref (`axClick(n, view)`, `axType(n, view, text)`) or on
   a stable locator from a recent snapshot
   (`axClick('role:button["Submit"]')`). Locators survive refMap rebuilds —
   see [`snapshot.md`](snapshot.md) (the `locators` opt + `parseAxLocators`).
3. **Verify** via `axDiff(prev, next)` against a fresh snapshot — see the
   deltas instead of re-feeding the whole next tree into context.
4. **Return** a compact answer (`return ...`). Bare strings print raw; arrays
   / objects print as compact JSON; undefined / null / "" / {} / [] print nothing.

## Pick a workflow before acting

Three workflows; pick by page type, in this order of preference.

### Semantic: `axView` + refs / locators

Default for ordinary pages — real text, links, buttons, forms, tables, lists.
Start with `axView(nodes, { interactive: true })`; re-snapshot only as the page
changes; prefer `axDiff` for after-action deltas.

### Visual: `Page.captureScreenshot` + coordinates / keyboard

When the page is canvas-like, heavily virtualized, or its accessibility tree is
incomplete. Inspect the screenshot, act with viewport coordinates
(`Input.dispatchMouseEvent`, then `Input.insertText` for typing), verify with
another screenshot or a reliable export/read-back path.

Use for Google Docs / Sheets, Lark/Feishu Docs, Notion, Figma, whiteboards,
maps — see [`rich-editors.md`](rich-editors.md). The rich-editor trap: a
toolbar's accessible name matches the pattern you wanted, but the document
surface itself is in a hidden textarea or canvas. Don't `axType` a probe
without verifying by screenshot where it landed.

### Direct-DOM / CDP: `Runtime.evaluate`, `DOM.*`, `cdp(sessionId, …)`

For browser state, custom DOM traversal, or anything the helpers don't cover.
Keep browser-side logic in ONE explicit IIFE and `return` once — never split a
multi-step traversal across multiple `await Runtime.evaluate(...)` calls
(every extra eval is another CDP round trip and another layer of escaping).

### They combine

A task may take multiple heredoc rounds when the next step depends on fresh
page state or a user handoff (login, captcha). In each round, write a coherent
script that advances the task: observe, act or extract, verify, and report
with `return`. Avoid tiny probe scripts; avoid forcing the whole task into one
oversized script either.

## Anti-patterns

- **CLI chaining for multi-step tasks.** `gsearch "x" 3` followed by `gsearch
  follow <url>` is fine for one navigation. For a five-step workflow on the
  same page, do it in one heredoc — the agent doesn't re-discover context
  each round.
- **Caching `[n]` refs across a page change.** Refs are stable only within one
  `getFullAXTree`. After navigation, mutation, or async updates, re-snapshot
  before acting. Use `locators: true` (`parseAxLocators(view)`) for elements
  you'll act on more than once in a multi-round task — they reuse role + name
  rather than a volatile refMap slot.
- **Drain-before-attach misses early events.** `drainSignals()` auto-attaches
  on first call — but events that fired BEFORE you called `drainSignals()`
  (or `attachSignals()`) are missed. For an action whose events you want to
  capture, `attachSignals()` first.
- **`Runtime.evaluate` hangs on a modal.** A native `alert` / `confirm` blocks
  page JS so `Runtime.evaluate` never returns. `pageInfo({ timeoutMs })` races
  the eval against a timeout and returns `{ dialog: { type, message, ... } }`
  instead of hanging; check `drainSignals()` for the matching `dialog <type>:
  "message"` signal and dismiss via `Page.handleJavaScriptDialog({ accept: <bool> })`
  before anything else works.

## Self-documentation

`help()` lists every helper; `help('axClick')` prints usage for one. Use it
when the model can't recall an option name without re-reading the docs.

## See also

- [`lifecycle-readiness.md`](lifecycle-readiness.md) — the navigate-and-wait
  pattern every skill shares; the one-tab-per-call shape for parallel use.
- [`snapshot.md`](snapshot.md) — `axView` options, `axDiff` for deltas, ref /
  locator lifecycle, when to drop to raw `getFullAXTree`.
- [`accessibility-tree.md`](accessibility-tree.md) — `queryAXTree` for the
  cheap targeted find before you snapshot.
- [`agent-signals.md`](agent-signals.md) — what the draining queue contains.
- [`rich-editors.md`](rich-editors.md) — when the DOM is a lie.
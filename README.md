<img src="https://r2.browser-use.com/github/asbfgihsbfbaosfjla.png" alt="Browser Harness" width="100%" />

# Browser Harness JS ♞

A model-neutral browser SDK with **scoped pages, native accessibility snapshots,
and guarded locators**. Familiar page/locator ergonomics, explicit authority,
trusted input and honest verification—without depending on Playwright.

```js
const page = await browser.open('https://example.com', {
  allowedOrigins: ['https://example.com']
});
const snapshot = await page.snapshot();
const result = await page.getByRole('button', { name: 'Save' }).click({
  verify: next => next.tree.includes('Saved')
});
```

Raw CDP remains an explicit advanced path: one persistent connection, 56 domains,
652 typed wrappers. If Chrome can do it, you can still call the protocol directly.

## Installation

```bash
npx skills add https://github.com/monotykamary/browser-harness-js
```

Each skill's CLI is symlinked onto PATH by its own `scripts/setup` — run `bash <skill-dir>/scripts/setup` (declared in each skill's `setup` frontmatter field).

Or paste this into your agent — it'll install the skill, put the CLI on your PATH, and run a first task:

```text
Run `npx skills add https://github.com/monotykamary/browser-harness-js`, then
symlink `browser-harness-js` into a directory on my PATH, then use the cdp skill to drive
my browser: look at all the tabs I have open, group them by topic, and screenshot the most
interesting one.
```

(The CLI requires [`node`](https://nodejs.org) on PATH — TypeScript type stripping is on by default from Node 23.6. No runtime is auto-installed.)

**Preferred connect path:** load the unpacked extension at `skills/cdp/extension` (`chrome://extensions` → Developer mode → Load unpacked). The worker relays CDP to the daemon over `ws://127.0.0.1:9876/extension` — no `--remote-debugging-port`, no Allow popup. `session.connect()` uses it when present.

**Fallback:** if Chrome asks you to tick a remote-debugging checkbox, do it — that's how the agent attaches without the extension:

<img src="docs/setup-remote-debugging.png" alt="Remote debugging setup" width="520" style="border-radius: 12px;" />

### macOS: Dia's "Allow debugging connection?" prompt

Dia (The Browser Company) is the only Chromium browser that gates the CDP connection behind an `Allow debugging connection?` prompt — **Return** dismisses it. The SDK auto-dismisses it for you (on by default, macOS only, a no-op for every other browser): when the WebSocket open stalls, it fires a Return at the Dia process via `osascript`, so `session.connect()` needs no manual click. Opt out with `autoAllow: false` (or `browser-harness-js --no-auto-allow`).

This needs **macOS Accessibility** for the `node` binary running the SDK. If it's missing, the keystroke is dropped — `osascript` errors `-25211: not allowed assistive access` and `connect()` stalls to `timeoutMs` instead of finishing in ~1s. Grant it once: **System Settings → Privacy & Security → Accessibility → add/toggle `node`**. The grant is per binary path, so version managers that install each version at its own path (mise, nvm, asdf) need a re-grant on version bump; a stable-path install (Homebrew) persists across upgrades.

See [skills/cdp/interaction-skills/](skills/cdp/interaction-skills/) for recipes on the mechanics that are not obvious from the CDP method list alone.

## Guarded pages and locators

The REPL exposes `browser`; library callers import `Browser` from
`skills/cdp/sdk/browser.ts`. Connect, inspect `browser.tabs()`, then explicitly
`browser.attach(targetId,{allowedOrigins})` or `browser.open(url,{allowedOrigins})`.
Every Page pins its attachment and connection generation, never an active-tab
pointer. Exact authorized HTTP(S) origins are required; allowlists are not
inferred from page content.

`page.snapshot()` returns `{tree,diff}` plus identity, URL/title, truncation and
omission metadata. Native AX projection preserves control values, named
contexts, table relations and all roots. Snapshots support subtree and frame
scope, including ownership-checked OOPIFs. Refs and diff history stay with the
page; there are no public backend-ID maps to assemble.

`page.getByRole(role,{name,context})` and `page.locator(cssOrRef)` resolve exactly
one target. Actions run **observe → revalidate → act once → verify**, default to
trusted mouse/keyboard input, and perform guarded scroll-into-view when needed.
Supported methods are `click`, `fill`, `press`, `selectOption` and
`scrollIntoView`. Value replacement/selection gets automatic read-back; other
goals use `verify(snapshot)` or an authoritative external check.

**`executed` means dispatched, not goal achieved.** Inspect `verified` and the
returned evidence. Stale → reobserve; blocked/denied → stop or obtain authority;
outcome_unknown → inspect, never blindly retry. No ambiguous first-match
selection, automatic action replay, or raw-input fallback. Timeouts/cancellation
cannot undo sent input; unresolved calls retain their queue fence.

`page.observe`, `page.act` and `page.waitForChange` expose bounded model-neutral
observations for Jev or other decision makers. Snapshot refs describe evidence;
observation handles authorize only revalidated operations. The underlying
`InteractionController` remains importable and powers the Pi/Fabric provider.

This is not full Playwright compatibility. Frame snapshots are supported, but
frame actions, closed-shadow-root actions, canvas and unsupported widgets fail
closed. Sensitive controls are excluded and protected/password-like snapshot
values are redacted; these are heuristics, not general DLP. Origin policy is not
a network firewall or a sandbox around raw CDP. See the
[usage API](skills/cdp/SKILL.md) and
[operating contract](skills/cdp/interaction-skills/agent-operating-loop.md).

### Breaking migration: 0.17.0

- The AX projection/ref/locator globals and their implementation are removed.
  Use `page.snapshot()`, `page.locator(ref)` and `page.getByRole()`.
- Signal/info helpers become `page.signals()` / `page.info()`.
- The unused learnings registry, controller-factory global and helper help
  registry are removed; the CLI's `--help` remains.
- Raw `session`, `cdp(sessionId,method,params)`, typed protocol wrappers, recording
  and Chrome-extension operations remain available.

After updating, run `browser-harness-js --restart` to load **0.17.0**. This drops
daemon globals and attachments; reconnect and reattach afterward.

## Optional Pi / Fabric connector

The normal Pi extension package in [`pi/`](pi/) owns the `browser-harness`
component and its guarded UI contract. Fabric stays connector-agnostic; it does
not need a browser-specific loader, core registration or Jev/model integration.
With Pi and Fabric available, optionally load it for one invocation or install
it as a local package (commands shown from a sibling checkout):

```bash
pi -e ../browser-harness-js/pi/extension.ts
# Or, persist the normal Pi package registration:
pi install ../browser-harness-js/pi
```

Pi supplies the `typebox` runtime peer and Pi types. `pi-fabric/protocol` is an
optional, **type-only** peer: no Fabric implementation is imported at runtime.
Loading the extension only registers a definition, in either extension load
order. Configuring it loads the adapter but no SDK modules, processes or sockets.
Only explicit `browser.connect` loads Session and connects to the configured
WebSocket (`autoAllow: false`); the interaction module loads on first guarded use.
Provider close releases its controller and session. This does not use the REPL
daemon or discover/approve a personal browser.

Use Fabric's existing component control plane (in `fabric_exec`):

```ts
const definition = await components.describe({ component: "browser-harness" });
const plan = await components.plan({ entries: [{
  id: "browser", component: definition.name,
  config: {
    modulePath: "/trusted/browser-harness-js/skills/cdp/sdk/session.ts",
    interactionModulePath: "/trusted/browser-harness-js/skills/cdp/sdk/interaction.ts",
    wsUrl: "ws://127.0.0.1:9222/devtools/browser/REPLACE_WITH_AUTHORIZED_ENDPOINT",
    allowedOrigins: ["https://example.com"],
    allowedMethods: ["Target.attachToTarget"]
  }
}] });
return plan; // Inspect changes/warnings and obtain approval before applying.
// Later, apply the inspected plan using its original request and revision:
// await components.apply({ ...plan.request, expectedRevision: plan.revision });
```

Paths are explicit trusted SDK modules (absolute, or relative to invocation cwd),
not tied to any sibling layout or bundled inside `pi/`. Required configuration:
`modulePath`, `wsUrl`, `allowedMethods`. Guarded actions also require
`interactionModulePath` plus 1–32 exact `allowedOrigins`; optional
`callTimeoutMs` is 100–60000 (default 10000). `allowedMethods: []` disables raw CDP;
provide an already-authorized session on this connection, or separately grant
`Target.attachToTarget` to attach a known authorized target. Raw grants are exact
method names and **not origin-limited**. No wildcard or implicit origin grants.

Then explicitly call `browser.connect` and use `browser.observe`, `browser.act`
and `browser.waitForChange` with `{scope:{sessionId}}`. `browser.cdp` exists only
with raw grants; page-scoped raw calls also require `sessionId`. Receipts and
cancellation retain the guarded semantics above: unknown outcomes never imply
rollback or permission to retry. Normal Fabric tool/approval policy still applies.

Before the extension is loaded, the definition is unknown to `components.describe`;
configured entries stay `waiting` with `component:browser-harness` missing until
the package is installed **and loaded**. Installing/configuring is not connecting.

Focused offline package tests, from this repository (Node 24+, no SDK suite,
browser, model or credentials):

```bash
cd pi
bun install --ignore-scripts --omit peer  # standalone tests need only dev typebox
node --test tests/*.test.ts
```

## Session recording (rrweb)

Recording is off by default. With explicit consent, the SDK injects [rrweb](https://github.com/rrweb-io/rrweb) into page targets and writes a local event log. Replay is the rrweb Replayer — a fidelity tape of DOM mutations, not a screenshot-compiled explainer.

```bash
recording="$(browser-harness-js 'await session.connect(); await startRecording("demo", "Verify account settings")')"
# Perform and verify the task with browser-harness-js (or let the user browse).
browser-harness-js 'await stopRecording()'
browser-harness-js recordings replay "$recording"
```

The jsonl can contain page content and stays local under `~/.browser-harness-js`; recording therefore requires consent. Form inputs are masked during capture. See [`make-video.md`](skills/cdp/interaction-skills/make-video.md).

## Skills

This repo contains nine skills installable via `npx skills add`:

| Skill | Description |
|-------|------------|
| **cdp** | Drive any Chromium-based browser, including Helium, via CDP — 56 domains, 652 typed methods; Chrome extension relay preferred, remote debugging fallback; consent-based rrweb session recording |
| **gsearch** | Search the web via Google through CDP — structured results in under 1 second; `follow <url>` opens a result link and reads its page text or JSON |
| **gnews** | Search Google News through CDP (`tbm=nws`) — structured results (title, url, source, time, snippet) with the publisher's direct URL, no redirect wrapper |
| **xsearch** | Search X (Twitter) via CDP — structured results (requires an active X login) |
| **rsearch** | Search Reddit posts via CDP — same-origin fetch of reddit's own `/search.json` with the browser's cookies (subreddit/sort/time filters, media URLs), no API key, login optional |
| **findata** | Free, keyless financial data via CDP — SEC EDGAR statements + Yahoo Finance prices |
| **ytdl** | Download YouTube videos browser-natively via CDP — records MediaSource output, no `yt-dlp` binary |
| **ttdl** | Download TikTok videos browser-natively via CDP — records MediaSource output, no watermark, no signer |
| **gmaps** | Google Maps via CDP — keyless local business search (Places API data), real directions in any travel mode (`--route --mode driving\|transit\|walking\|cycling\|flights\|best`), and best-effort fastest visiting order / TSP (`--optimize`), no API key |

## Files

- `pi/` — optional Pi extension package: lazy `browser-harness` Fabric definition, guarded browser provider, provider-owned UI contract and focused fake-session tests
- `skills/cdp/SKILL.md` — day-to-day usage; how to connect, pick a tab, call methods, persist state
- `skills/cdp/sdk/browser-harness-js` — tiny CLI that auto-spawns the server and forwards snippets
- `skills/cdp/sdk/repl.ts` — Node HTTP server holding one persistent `Session`
- `skills/cdp/extension/` — MV3 CDP relay (`chrome.debugger`); preferred `session.connect()` pipe
- `skills/cdp/sdk/session.ts` — the `Session` class: transport, pinned reconnect, generation, target routing, events, call observation
- `skills/cdp/sdk/interaction.ts` — model-neutral `InteractionController`, explicit-scope guarded observation/action/wait
- `skills/cdp/sdk/interaction.test.ts` — injected session/DOM guard fixtures (no live browser)
- `skills/cdp/sdk/extension-hub.ts` / `ws-server.ts` — inbound `/extension` WebSocket and connect() preference
- `skills/cdp/sdk/chrome.ts` — `ext.*` helpers for Chrome tab/window/group commands (extension transport)
- `skills/cdp/sdk/recording.ts` — consent, pinned rrweb fetch/cache, injection, local replay server
- `skills/cdp/sdk/rrweb-replay.html` — player UI for `recordings replay`
- `skills/cdp/sdk/gen.ts` — codegen: reads `browser_protocol.json` + `js_protocol.json` → typed wrappers
- `skills/cdp/sdk/generated.ts` — every CDP method as `session.<Domain>.<method>(params)` (generated)
- `skills/cdp/sdk/browser.ts` / `page.ts` — scoped Browser/Page/Locator ownership, guarded actions and verification
- `skills/cdp/sdk/snapshot.ts` — internal CDP-native projection, managed snapshot types and identity-aware diffs
- `skills/cdp/sdk/page.test.ts` / `page.live.test.ts` / `snapshot.test.ts` — lifecycle, isolated Chrome end-to-end and projection regressions
- `skills/cdp/interaction-skills/agent-operating-loop.md` — observe → act → verify → return across the semantic / visual / direct-DOM workflows
- `skills/cdp/interaction-skills/rich-editors.md` — Docs, Sheets, Notion, Figma: when the DOM is a lie about the editable surface
- `skills/gsearch/SKILL.md` — Google Search skill instructions
- `skills/gsearch/scripts/gsearch` — Google Search CLI
- `skills/gnews/SKILL.md` — Google News skill instructions
- `skills/gnews/scripts/gnews` — Google News CLI (a `browser-harness-js` heredoc, no runtime)
- `skills/xsearch/SKILL.md` — X (Twitter) Search skill instructions
- `skills/xsearch/scripts/xsearch` — X Search CLI
- `skills/rsearch/SKILL.md` — Reddit search skill instructions
- `skills/rsearch/scripts/rsearch` — Reddit search CLI (a `browser-harness-js` heredoc, no runtime; adapted from opencli's reddit adapter)
- `skills/findata/SKILL.md` — financial-data skill instructions
- `skills/findata/scripts/findata` — financial-data CLI (SEC EDGAR + Yahoo Finance, a `browser-harness-js` heredoc)
- `skills/ytdl/SKILL.md` — YouTube download skill instructions
- `skills/ytdl/scripts/ytdl` — YouTube download CLI (a `browser-harness-js` heredoc, no runtime)
- `skills/ttdl/SKILL.md` — TikTok download skill instructions
- `skills/ttdl/scripts/ttdl` — TikTok download CLI (a `browser-harness-js` heredoc, no runtime)
- `skills/gmaps/SKILL.md` — Google Maps skill instructions (search, directions, optimize)
- `skills/gmaps/scripts/gmaps` — Google Maps CLI: search + `--route` directions (`--mode` …) + `--optimize` best-effort TSP (a `browser-harness-js` heredoc, no runtime)

Raw protocol calls remain available alongside the default guarded Page/Locator interface.

## Distribution: cross-agent plugin manifests

Beyond `npx skills add https://github.com/monotykamary/browser-harness-js`, this repo ships manifests so the same skills are discoverable in each agent ecosystem's plugin UI:

- [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) — Claude Code plugin marketplace entry (registers `cdp` + the nine recipe skills as one plugin).
- [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json) — Codex plugin entry with capabilities, default prompts, and brand colors.
- [`skills/cdp/agents/openai.yaml`](skills/cdp/agents/openai.yaml) — OpenAI-agent display metadata.

Each entry lists the same skills as `./skills/<name>`; the per-skill `scripts/setup` still handles PATH symlinking (`browser-harness-js` CLI + each skill's own script).

## Why preserve raw CDP?

A guarded `click` deliberately supports less than `Input.dispatchMouseEvent`,
which has parameters for button, clickCount, modifiers, pointerType, force and
more. Use the guard at unknown UI decision boundaries; use authorized raw CDP
when a deterministic route is known or unsupported mechanics require it.

- Types are the docs. `session.Page.navigate(` triggers autocomplete with the exact params — same JSDoc as the CDP reference.
- No version drift. The SDK is regenerated from the upstream protocol JSON; new Chrome methods appear as soon as you swap the JSON.
- No "helper doesn't handle my case" detours. If CDP can do it, the agent can call it — directly, typed, today.

The low-level surface remains available for explicit advanced work:
- `page.cdp(method, params)` — pinned raw dispatch, invalidating page observations
- `session.Domain.method(...)` and `cdp(sessionId, method, params)` — typed or explicitly routed protocol calls
- `session.waitFor(method, predicate, timeout)` — native event synchronization
- `resolveWsUrl`, `detectBrowsers`, `ext`, recording APIs — connection, Chrome-extension operations and session recording

Raw access is intentional, never permission to evade a guard denial. Reading,
refs, locators and normal interactions use the coherent Page surface instead
of overlapping global helpers.

## Contributing

PRs welcome. The best way to help: **contribute a new interaction skill** under [skills/cdp/interaction-skills/](skills/cdp/interaction-skills/) when you figure out the CDP recipe for something non-obvious (a dropdown framework, a shadow-DOM trap, a network-wait pattern).

- Prefer the Page/Locator interface for supported interactions. Label raw CDP recipes as explicit advanced paths, never guard-denial fallbacks.
- Lead with the shortest method call that works; add the workaround or trap afterwards.
- Small and focused beats comprehensive. One mechanic per file.
- Bug fixes, codegen improvements, and `session.ts` refinements are equally welcome.

---

[Bitter lesson](https://browser-use.com/posts/bitter-lesson-agent-frameworks) · [Skills](https://browser-use.com/posts/web-agents-that-actually-learn)

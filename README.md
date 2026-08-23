<img src="https://r2.browser-use.com/github/asbfgihsbfbaosfjla.png" alt="Browser Harness" width="100%" />

# Browser Harness JS ♞

The thinnest possible bridge from the LLM to Chrome. **No harness, no recipes, no rails** — just every CDP method as a typed JS call.

One persistent WebSocket, 56 domains, 652 typed wrappers, zero wrapping of what Chrome already does.

```
  ● agent: wants to click a button
  │
  ● no click() helper, no upload_file(), no goto()
  │
  ● agent writes the CDP call itself        await session.Input.dispatchMouseEvent({...})
  │                                          await session.DOM.setFileInputFiles({...})
  ✓ done — same pattern for all 652 methods
```

**The protocol is the API.** If Chrome can do it, you can call it.

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

If Chrome asks you to tick a remote-debugging checkbox, do it — that's how the agent attaches:

<img src="docs/setup-remote-debugging.png" alt="Remote debugging setup" width="520" style="border-radius: 12px;" />

### macOS: Dia's "Allow debugging connection?" prompt

Dia (The Browser Company) is the only Chromium browser that gates the CDP connection behind an `Allow debugging connection?` prompt — **Return** dismisses it. The SDK auto-dismisses it for you (on by default, macOS only, a no-op for every other browser): when the WebSocket open stalls, it fires a Return at the Dia process via `osascript`, so `session.connect()` needs no manual click. Opt out with `autoAllow: false` (or `browser-harness-js --no-auto-allow`).

This needs **macOS Accessibility** for the `node` binary running the SDK. If it's missing, the keystroke is dropped — `osascript` errors `-25211: not allowed assistive access` and `connect()` stalls to `timeoutMs` instead of finishing in ~1s. Grant it once: **System Settings → Privacy & Security → Accessibility → add/toggle `node`**. The grant is per binary path, so version managers that install each version at its own path (mise, nvm, asdf) need a re-grant on version bump; a stable-path install (Homebrew) persists across upgrades.

See [skills/cdp/interaction-skills/](skills/cdp/interaction-skills/) for recipes on the mechanics that are not obvious from the CDP method list alone.

## Browser-use-style videos

Recording is off by default. With explicit consent, the SDK can capture local screenshots and privacy-scrubbed action metadata from raw `Page.*` and `Input.*` calls, then compact a long task into a deterministic explanatory video with authentic cursor endpoints, clicks, typing, result frames, captions, and verified outcomes. It is an evidence editor, not a sped-up screen recorder.

```bash
recording="$(browser-harness-js 'await startRecording("demo", "Verify account settings")')"
# Perform and verify the task with browser-harness-js.
browser-harness-js 'await stopRecording()'
browser-harness-js video init "$recording" --require-explicit
# Author edit-brief.json, review every used full-resolution frame, then:
browser-harness-js video review "$recording"
browser-harness-js video export "$recording" --reviewed
```

Raw screenshots and non-password typed text can contain sensitive content and stay local under `~/.browser-harness-js`; recording therefore requires consent. The pipeline hashes source evidence and reviewed artifacts, masks password typing during capture, hides all other typing from compositions unless explicitly reviewed, supports page-coordinate redactions, and verifies the final H.264 MP4 with `ffprobe`/`ffmpeg`. See [`make-video.md`](skills/cdp/interaction-skills/make-video.md).

## Skills

This repo contains nine skills installable via `npx skills add`:

| Skill | Description |
|-------|------------|
| **cdp** | Drive any Chromium-based browser, including Helium, via CDP — 56 domains, 652 typed methods; consent-based action recording and polished explanatory videos |
| **gsearch** | Search the web via Google through CDP — structured results in under 1 second; `follow <url>` opens a result link and reads its page text or JSON |
| **gnews** | Search Google News through CDP (`tbm=nws`) — structured results (title, url, source, time, snippet) with the publisher's direct URL, no redirect wrapper |
| **xsearch** | Search X (Twitter) via CDP — structured results (requires an active X login) |
| **rsearch** | Search Reddit posts via CDP — same-origin fetch of reddit's own `/search.json` with the browser's cookies (subreddit/sort/time filters, media URLs), no API key, login optional |
| **findata** | Free, keyless financial data via CDP — SEC EDGAR statements + Yahoo Finance prices |
| **ytdl** | Download YouTube videos browser-natively via CDP — records MediaSource output, no `yt-dlp` binary |
| **ttdl** | Download TikTok videos browser-natively via CDP — records MediaSource output, no watermark, no signer |
| **gmaps** | Google Maps via CDP — keyless local business search (Places API data), real directions in any travel mode (`--route --mode driving\|transit\|walking\|cycling\|flights\|best`), and best-effort fastest visiting order / TSP (`--optimize`), no API key |

## Files

- `skills/cdp/SKILL.md` — day-to-day usage; how to connect, pick a tab, call methods, persist state
- `skills/cdp/sdk/browser-harness-js` — tiny CLI that auto-spawns the server and forwards snippets
- `skills/cdp/sdk/repl.ts` — Node HTTP server holding one persistent `Session`
- `skills/cdp/sdk/session.ts` — the `Session` class: transport, connect, target routing, events, call observation
- `skills/cdp/sdk/recording.ts` — consent, privacy scrubbing, action traces, and screenshot capture
- `skills/cdp/sdk/video.ts` — edit-brief compiler and content-hashed provenance
- `skills/cdp/sdk/video-render.ts` / `skills/cdp/sdk/video-template.html` — review renderer and verified MP4 export
- `skills/cdp/sdk/gen.ts` — codegen: reads `browser_protocol.json` + `js_protocol.json` → typed wrappers
- `skills/cdp/sdk/generated.ts` — every CDP method as `session.<Domain>.<method>(params)` (generated)
- `skills/cdp/sdk/helpers.ts` — agent helpers for exactly the "things CDP structurally lacks" carve-out below: `drainSignals()` / `attachSignals()` (drainable signal queue), `pageInfo()` (modal-dialog detection), `resolveLocator()` / `parseAxLocators()` (locator resolution via the accessibility tree), `help()` (per-helper self-documentation), and the per-site recipe registry `listLearnings()` / `learnings(domain, tool, args)` over `skills/cdp/learnings/<domain>/manifest.json`
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

No helpers file. No `click()`, no `goto()`, no `upload_file()` — just the protocol, typed.

## Distribution: cross-agent plugin manifests

Beyond `npx skills add https://github.com/monotykamary/browser-harness-js`, this repo ships manifests so the same skills are discoverable in each agent ecosystem's plugin UI:

- [`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json) — Claude Code plugin marketplace entry (registers `cdp` + the nine recipe skills as one plugin).
- [`.codex-plugin/plugin.json`](.codex-plugin/plugin.json) — Codex plugin entry with capabilities, default prompts, and brand colors.
- [`skills/cdp/agents/openai.yaml`](skills/cdp/agents/openai.yaml) — OpenAI-agent display metadata.

Each entry lists the same skills as `./skills/<name>`; the per-skill `scripts/setup` still handles PATH symlinking (`browser-harness-js` CLI + each skill's own script).

## Why no pre-baked helpers?

Every helper is a lie about what CDP already gives you. `click(x, y)` hides `Input.dispatchMouseEvent` — which has 14 parameters the LLM might need (button, clickCount, modifiers, pointerType, force, tangentialPressure, …). A harness that exposes three of them quietly limits what the agent can do.

- Types are the docs. `session.Page.navigate(` triggers autocomplete with the exact params — same JSDoc as the CDP reference.
- No version drift. The SDK is regenerated from the upstream protocol JSON; new Chrome methods appear as soon as you swap the JSON.
- No "helper doesn't handle my case" detours. If CDP can do it, the agent can call it — directly, typed, today.

The only "helpers" you'll find are things CDP itself is missing:
- `listPageTargets()` — filters `chrome://` / `devtools://` out of `Target.getTargets`
- `resolveWsUrl({wsUrl|port|profileDir})` — reads `DevToolsActivePort` for Chrome 144+
- `session.use(targetId)` / `session.waitFor(method, pred, timeout)` — the two routing primitives you genuinely need
- `axView(nodes, opts?)` + `axDiff` / `parseAxRefs` / `axClick` / `axType` — compressed accessibility-tree projection (raw `getFullAXTree` is unusable in context; drops ~96% structural noise and keeps refs you can act on; see `interaction-skills/snapshot.md`)
- `parseAxLocators` / `resolveLocator` / `axClick(locator)` — stable locators (`role` + `accessibleName`) that survive refMap rebuilds where `[n]` refs do not
- `attachSignals()` / `drainSignals()` — drainable digest of dialogs / downloads / navigations / crashes (CDP fires dozens of events; this keeps the handful that change what to do next)
- `pageInfo({ timeoutMs? })` — `url` / `title` / viewport via a timed `Runtime.evaluate`; returns `{ dialog }` when a modal blocks page JS instead of silently hanging
- `help(name?)` — per-helper usage so the model does not need to reload docs to remember an option name
- `listLearnings()` / `learnings(domain, tool?, args?)` — recipe registry over `skills/cdp/learnings/` so per-site selector chains are not re-derived each call (see `skills/cdp/learnings/README.md`)

None wrap or hide a `session.Domain.method(...)` call; the agent can always drop to raw CDP for everything these helpers cover.

## Contributing

PRs welcome. The best way to help: **contribute a new interaction skill** under [skills/cdp/interaction-skills/](skills/cdp/interaction-skills/) when you figure out the CDP recipe for something non-obvious (a dropdown framework, a shadow-DOM trap, a network-wait pattern).

- Keep recipes in **pure CDP** — `session.Domain.method(...)`, not wrapped helpers.
- Lead with the shortest method call that works; add the workaround or trap afterwards.
- Small and focused beats comprehensive. One mechanic per file.
- Bug fixes, codegen improvements, and `session.ts` refinements are equally welcome.

---

[Bitter lesson](https://browser-use.com/posts/bitter-lesson-agent-frameworks) · [Skills](https://browser-use.com/posts/web-agents-that-actually-learn)

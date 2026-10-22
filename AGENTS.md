# AGENTS.md — notes for AI coding agents working in this repo

Read this before touching skills. The single most common mistake is editing the
wrong copy. Don't.

## What this repo is

This is the **source** repo for `browser-harness-js`: the CDP SDK (`skills/cdp/sdk/`)
plus a set of skills that drive a Chromium browser through it. The user's
installed skills are **copies** of what lives here.

- `skills/cdp/` — the `cdp` skill: the SDK itself (`sdk/browser-harness-js` CLI,
  `repl.ts` server, `session.ts`, `generated.ts` typed wrappers) + usage docs +
  `interaction-skills/` recipe notes.
- `skills/<name>/` — every other skill (`gsearch`, `xsearch`, `findata`, `ytdl`,
  `ttdl`, `gmaps`, …). Each is a thin `browser-harness-js` heredoc CLI.

## The install model (this is the part that gets confused)

| Where | What it is | Edit here? |
|-------|-----------|-------------|
| `./skills/<name>/` (this repo) | **source of truth** | **YES — always** |
| `~/.agents/skills/<name>/` | installed copy (via `npx skills add` or manual sync) | NO |
| `~/.local/bin/<name>` | PATH symlink → this repo's `skills/<name>/scripts/<name>` | (auto) |

**Develop skills in `./skills/<name>/` only.** Never write into `~/.agents/skills/`
— those are installed copies, and changes there are throwaway. To make a repo skill runnable on PATH, run its own `scripts/setup`
(which symlinks `~/.local/bin/<name>` at the repo script); do not hand-create
global skill dirs.

The `browser-harness-js` CLI the skills call is this repo's `skills/cdp/sdk/browser-harness-js`
(symlinked onto PATH by `scripts/setup`). It is not a separate "system harness" —
it is this repo's SDK, installed. There is nothing else to conflate it with.

## Bump the SDK version on every change

`skills/cdp/sdk/package.json` `"version"` is the **single source** for the SDK
version, surfaced in two places with intentionally different freshness:

- `browser-harness-js --version` reads it fresh from disk each call (no daemon
  needed).
- `/health` (served by the long-lived daemon) reports the version the daemon
  **booted** with — cached for the process lifetime.

That mismatch is how a running daemon detects it's stale: no `version` in
`/health`, or a lower one than `--version`, means the daemon predates the files
on disk → `browser-harness-js --restart` reloads them. Details in
`skills/cdp/interaction-skills/connection.md` (Stale daemon).

**Bump `"version"` on every change to the `cdp` skill** — SDK code (`repl.ts`,
`session.ts`, `browser.ts`, `page.ts`, `snapshot.ts`, `generated.ts`, the `browser-harness-js` launcher)
*or* its docs (`SKILL.md`, `interaction-skills/*`). Without a bump, an
installed copy has no way to know it's behind. Patch for fixes/docs, minor for
a new capability. Then restart the daemon so the running process serves the
new version (and reloads any code change):

```bash
# edit skills/cdp/…, bump package.json, then:
browser-harness-js --restart
```

## Skill anatomy (match the existing skills exactly)

```
skills/<name>/
  SKILL.md          # frontmatter (below) + LLM-operating docs (lean)
  scripts/
    <name>          # the CLI: bash + one `browser-harness-js` heredoc
    setup           # symlink installer — identical template across skills
    test            # (optional) smoke test, exits 77 if browser unreachable
```

**SKILL.md frontmatter** — `name`, `description`, `setup`, `compatibility` only.
The repo skills do **not** use `disable-model-invocation` (that field only appears
in some installed copies; do not add it here).

```
---
name: <name>
description: >-
  One-paragraph: what it returns + when to use it + the hard requirement
  (browser-harness-js on PATH, Chromium with remote debugging).
setup: bash <skill-dir>/scripts/setup
compatibility: >-
  browser-harness-js on PATH + a Chromium browser with remote debugging
  (chrome://inspect or --remote-debugging-port). Note any extras (ffmpeg,
  a logged-in tab, …).
---
```

The SKILL.md **body** is LLM-operating docs — what the skill returns, when to use it, the CLI commands/flags/examples, result shapes, and traps. Keep human setup (install, symlink onto PATH, one-time OS grants like macOS Accessibility) in the **README**, not the skill body — the `setup`/`compatibility` frontmatter fields and the README's Installation section carry it. The model reads SKILL.md on every skill load, so keep it to what the model needs to *use* the skill, not set it up.

**The CLI** is plain bash that ends in a `browser-harness-js <<'EOF' … EOF`
heredoc returning a string (pretty) or an object/array (JSON via `--json`).
Conventions:

- Auto-fix header: if `browser-harness-js` isn't on PATH, symlink it from
  `../cdp/sdk/browser-harness-js` (relative to the script — resolves to the
  sibling `cdp` skill in both the repo and an install).
- One tab per call: `Target.createTarget({ background: true })` →
  `attachToTarget` → per-call `sessionId` → route calls with the
  `cdp(sessionId, method, params)` global → … → fire-and-forget `closeTab` in
  `finally`. This is what makes calls safe to run in parallel. The
  navigate-and-wait shape (`Page.setLifecycleEventsEnabled` + arm
  `session.waitFor('Page.lifecycleEvent', …'networkIdle')` *before*
  `Page.navigate`) and the one-tab-per-call template are in
  `skills/cdp/interaction-skills/lifecycle-readiness.md` — read it before
  re-deriving. Use a foreground tab (no `background: true`) when the page
  must autoplay or feed `MediaSource` (see `media-capture.md`).
- **No `jq`**, no extra runtime deps. `node` is required (the REPL needs it);
  use it for things like JSON-safe string literals or date math.
- Pass shell args into the heredoc. Keep the heredoc **quoted** (`<<'EOF'`)
  so backticks, `$`, and regex backslashes in the in-page JS need no bash
  escaping, then inject the args by one of:
  - **Placeholder substitution (preferred):** put `__TOKEN__` placeholders in
    the quoted heredoc and rewrite them with a `node -e` that `JSON.stringify`s
    the raw values into safe JS literals, using *function*-replacements
    (`c.replace(/__P__/g, () => JSON.stringify(v))`). Function-replacements
    dodge the `&`/`$`/`\` semantics that bash `${var//pat/$repl}` *and* JS
    `String.replace` both apply to plain replacement strings, so it's safe for
    values containing `&` or `$`. `gmaps` uses this — copy it as the template.
  - **Inline escaping (for a single interpolated value, e.g. one URL):** escape
    the value with `sed` into a JS string literal and interpolate `'${js_val}'`
    inside the heredoc. Copy the exact `sed` line and its comment from
    `gsearch/scripts/gsearch` — it escapes `\`, `$`, `` ` ``, `'` for a JS
    single-quoted string. Trap: the `$` rule must match a literal `\$`, not
    end-of-line; the old `s/\$/\\$/g` form treated `$` as the EOL anchor and
    appended `$` to every line. `gsearch`/`xsearch`/`findata`/`ytdl`/`ttdl` use
    this.
  Do not `export` env vars and read `process.env` — the REPL daemon is
  long-lived and won't see newly exported vars. Do not use bash
  `${var//pat/$repl}` for values containing `&` or `$` (it re-interprets them
  as the match / captures).

**`setup`** is the same template across all skills: ensure `~/.local/bin` is on
PATH, symlink the CLI there, and symlink `browser-harness-js` from
`../cdp/sdk/browser-harness-js` if it isn't already on PATH. Copy it verbatim
and change only the skill name.

## Developing & testing a skill here

```bash
# edit skills/<name>/… then:
bash skills/<name>/scripts/setup        # refresh ~/.local/bin/<name> -> repo script
bash skills/<name>/scripts/test         # smoke test (77 = browser unreachable)
./skills/<name>/scripts/<name> …        # run the repo's own script directly
```

Skills drive the **user's own system browser** via CDP remote debugging — they
do not bundle a browser. Tests are live (they hit real sites through the
browser), like `findata` hits real Yahoo/SEC. A browser must be running with
remote debugging enabled (see the `cdp` skill) or tests skip with exit 77.

## When adding a skill

1. Build it under `./skills/<name>/` following the anatomy above.
2. Add it to the README's **Skills** table and **Files** list.
3. Ship a `scripts/test` smoke test.
4. Run `scripts/setup` to symlink it onto PATH for local testing — leave the
   global `~/.agents/skills/` alone; the user installs
   from this repo (`npx skills add`) on their own schedule.

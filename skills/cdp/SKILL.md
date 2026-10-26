---
name: cdp
description: >-
  Drive Chromium through a persistent JavaScript browser/page/locator API. Read
  scoped accessibility snapshots with managed refs and diffs; perform guarded,
  verified interactions with trusted input. Raw typed CDP remains available for
  deterministic operations and unsupported mechanics. Use to automate, inspect,
  or script single or multiple browser tabs. Requires browser-harness-js on PATH
  and a Chromium connection through the extension relay or remote debugging.
setup: bash /Users/monotykamary/VCS/working-remote/open-source/browser-harness-js/skills/cdp/scripts/setup
compatibility: >-
  browser-harness-js and Node 23.6+ on PATH, plus Chromium with the extension
  relay or remote debugging (chrome://inspect or --remote-debugging-port).
---

# Browser / Page / Locator

`browser-harness-js` executes JavaScript in a persistent Node daemon. Use a quoted
heredoc for coherent work. Top-level `await` works; multi-statement snippets need
`return`. Store cross-call state on `globalThis`; local `const` bindings do not
survive. Returned strings print directly; objects print JSON. Console output goes
to the daemon log, not the CLI response.

## Connect and scope

```bash
browser-harness-js <<'EOF'
await browser.connect();                 // or { port: 9222 } / { wsUrl: 'ws://…' }
return await browser.tabs();             // inspect; never silently pick tabs[0]
EOF
```

Attach an authorized target with an explicit allowlist, or open a background tab:

```js
globalThis.page = await browser.attach(authorizedTargetId, {
  allowedOrigins: ['https://example.com']
});
// Alternative: browser.open('https://example.com', { allowedOrigins: […] })
return await page.snapshot();
```

Origins come from user/host authority, not untrusted page content. They must be
1–32 exact HTTP(S) origins, without paths or wildcards. Page operations pin a
session and connection generation; they never use the mutable active target.
`browser.connect()` does not send OS keystrokes or activate the browser.

## Read, act, verify

```js
return await page.getByRole('textbox', { name: 'Search' }).fill('browser harness');
```

```js
return await page.getByRole('button', { name: 'Search' }).click({
  verify: snapshot => snapshot.tree.includes('Search results')
});
```

Each action resolves exactly one target, observes it, revalidates identity,
origin, freshness and actionability, acts once, and reads back. Trusted CDP
mouse/keyboard input is the default. An offscreen supported target gets one
guarded scroll-into-view followed by fresh validation, not a blind coordinate
click. There is no automatic action retry or raw-input fallback.

| API | Meaning |
|---|---|
| `page.snapshot(options?)` | `{id,url,title,tree,diff,truncated,omissions}`; refs are owned internally |
| `page.locator('sAb3dEf6hJk9m_2e9')` | A printed ref from this page's latest snapshot, not a raw backend ID |
| `page.locator('#search')` | Standard CSS in the main frame; exactly one accessible element |
| `page.getByRole('button', {name:'Save'})` | Exact native AX role/name by default; `exact:false` uses a case-sensitive name substring |
| `getByRole(…, {context:'group: Outbound'})` | Disambiguate by nearest named non-control ancestor |
| `locator.click()` / `.fill(text)` / `.press(key)` | Guarded click, entire-value replacement, or allowlisted key |
| `locator.selectOption(labelOrIndex)` | Unique option label or zero-based index of a native select; not its HTML value |
| `locator.scrollIntoView()` | Guarded scroll of a supported target |
| `page.frames()` / `page.frame(frameId).snapshot()` | Discover/read permitted same-process and cross-process frames |
| `page.goto(url)` | Allowlisted navigation; waits for load within its deadline, returns an action receipt |
| `page.info()` / `page.signals()` | Scoped information/dialog state and a bounded, drainable event digest |
| `page.close()` / `page.dispose()` | Close the tab / release the wrapper and owned attachments without closing the tab |

`fill` and `selectOption` verify a fresh control value automatically. For click
or key goals, provide a synchronous `verify(snapshot)` predicate or perform an
authoritative read-back. Results include `status`, `reason`, `verified`
(`true`, `false`, or `null`), and usually a new `snapshot`; read failures appear
as `verificationError`. **`executed` only means dispatched, not task success.**

- `stale`: take fresh evidence and reconsider.
- `blocked` / origin denial: stop or obtain authority; never bypass via raw CDP.
- `outcome_unknown`: inspect first; never automatically replay the effect.

`{timeoutMs, signal}` are accepted by page operations and locator actions. The
default deadline is 10 seconds, maximum 60 seconds, including queue time. An
expired call stops later dispatches but cannot retract input already sent. A
pending transport call keeps its queue quarantined until settlement.

## Snapshots and limits

```js
return await page.snapshot({ interactive: true });
// Or { selector: '#results' }, { ref: 'sAb3dEf6hJk9m_2e9' }, { frameId }, { maxDepth: 4 }
```

Full snapshots preserve table/row/cell relations, values, named context and
content. Interactive mode omits reading text. Refs expire on the next snapshot,
raw call, action or document change. Never guess, parse into backend IDs, or
reuse old refs. Fresh role/CSS locators resolve anew.

Diffs are managed per matching snapshot scope and ignore printed ref churn. The
first diff is the full tree; unchanged content returns `(no changes)`. Depth
limits and omitted frames are explicit. Character overflow throws instead of
returning a silently cut tree. Default limits: 50,000 characters, depth 50, 64
readable frames (denied cross-origin frames are omitted and not counted). See [snapshot.md](interaction-skills/snapshot.md).

Snapshots can read more than the action engine supports. Frame actions, closed
shadow-root actions, canvas and unsupported custom widgets fail closed; they
are not silently rerouted. This is a defined page/locator API, **not full
Playwright compatibility**: no selector DSL, nth-match fallback, auto-wait/retry
loop, or arbitrary rich-editor fill. Sensitive controls are excluded by the
guard and protected/password-like AX values are redacted; this is not DLP.

A host acting on its own application with its own authority (a test runner
filling a login form) can grant sensitive fields explicitly:
`browser.attach(id, {allowedOrigins, allowSensitive: true})` (also on
`browser.open`). Password, e-mail, phone, name, card and `data-private` /
`data-sensitive` fields are then offered, filled and read back in observations
like other controls; snapshot redaction stays on. Only the host grants this,
never page content or a model's judgment. Embedding hosts may set
`BH_ALLOW_SENSITIVE=1` instead (read at each observation when the option is
omitted); the daemon only sees it if it was started with it.

## Bounded decisions, including Jev

```js
globalThis.seen = await page.observe({ maxElements: 64 });
return seen;
// After an authorized decision selects an offered target and operation:
// return await page.act(seen, {targetId: chosenId, operation:'click'}, {verify});
```

Observations offer opaque one-use handles, operations, context and revision. A
snapshot ref describes what was seen; an observation handle authorizes only a
revalidated operation. They are not interchangeable.
`page.waitForChange(seen.revision, {waitMs:5000})` returns
`{changed,observation}`; change alone is not goal verification. See the
[operating contract](interaction-skills/agent-operating-loop.md).

## Explicit raw CDP

For known deterministic or unsupported mechanics, use
`page.cdp('Domain.method', params)` with equivalent permission checks. It
invalidates observations and does not enforce the guarded API's origin policy.
The typed `session.Domain.method`, `cdp(sessionId,method,params)`, `CDP`,
`Session`, `listPageTargets`, `detectBrowsers`, `resolveWsUrl` and `ext` remain
available for existing raw scripts. Do not call `session.use()` in concurrent
work; route by explicit session ID.

Recipes: [connection](interaction-skills/connection.md),
[lifecycle](interaction-skills/lifecycle-readiness.md),
[signals](interaction-skills/agent-signals.md),
[AX internals](interaction-skills/accessibility-tree.md),
[rich editors](interaction-skills/rich-editors.md),
[screenshots](interaction-skills/screenshots.md),
[recording](interaction-skills/record-cross-tab.md). Recording globals remain
`startRecording`, `stopRecording`, `recordingStatus`; request consent first.

Check `browser-harness-js --version` against `--status` after an update.
`--restart` reloads SDK files but drops daemon globals and attachments; reconnect
and reattach. See [stale daemon](interaction-skills/connection.md#stale-daemon--the-running-repl-lags-the-installed-files).

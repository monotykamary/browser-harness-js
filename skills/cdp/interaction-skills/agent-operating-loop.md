# Agent operating loop — observe, act, verify, return

Use the scoped `browser` / `page` / `locator` interface by default. Locators run
**observe → resolve exactly one target → revalidate → act once → verify**.
Known authorized deterministic APIs remain a valid explicit raw path. Jev is
optional; a model's confidence never supplies permission.

## Normal task loop

```js
globalThis.page = await browser.attach(authorizedTargetId, {
  allowedOrigins: ['https://example.com']
});
return await page.snapshot();
```

At the next decided step:

```js
return await page.getByRole('button', {name:'Save'}).click({
  verify: shot => shot.tree.includes('Saved successfully')
});
```

Read the receipt and fresh snapshot. `fill` and `selectOption` automatically
read back the control value; other goals need a synchronous `verify(snapshot)`
predicate or an authoritative external check. The snapshot includes static
text, unlike an interactive-only observation revision. An unchanged revision
does not prove nothing happened.

## Bounded model-neutral decisions

When a judge needs an explicit candidate set rather than a semantic locator:

```js
globalThis.seen = await page.observe({maxElements:64});
return seen;
```

After choosing an authorized offered operation:

```js
return await page.act(seen, {targetId: chosenId, operation:'click'}, {
  verify: shot => shot.tree.includes('Saved successfully')
});
```

Observation handles are opaque, scope-bound and single-use. Default 64
candidates, maximum 128; scanning and identities are bounded. A fresh
observation expires older handles in its scope. Do not substitute snapshot refs
for candidate IDs. `page.waitForChange(revision, {waitMs:5000})` returns
`{changed,observation}`, sampling no faster than 500 ms plus observation cost.
Neither a judge score nor `changed:true` means the task is done.

The underlying `InteractionController` remains importable from
`sdk/interaction.ts` for custom integrations. It
requires explicit `{scope:{sessionId}}` on every call. The page facade defaults
to trusted input; standalone controllers retain their explicit configuration
and legacy synthetic default. There is no REPL controller-factory global.

## Authority and receipts

| Status | Required response |
|---|---|
| `executed` | Input was dispatched. Inspect `verified` and evidence; do not infer goal success. |
| `stale` | Reobserve and reconsider. No automatic replay. |
| `blocked` / origin denial | Stop or obtain authority. Never evade through raw APIs. |
| `outcome_unknown` | Inspect first. Never blindly retry an uncertain effect. |

`verified:null` means no goal predicate/read-back was established; `false` means
the check did not hold. A read failure is reported as `verificationError`.
Read APIs reject on denial, unavailability or cancellation. Actions return
receipts. A deadline after possible dispatch may report `outcome_unknown`.

The allowlist is 1–32 exact authorized HTTP(S) origins, not URLs learned from
the page. Origins, document/connection, native identity, semantics, value,
enabled state, visibility, geometry and occlusion are rechecked. Navigation
and reconnect expire refs/handles; reattach after reconnect.

## Mechanics and limits

- Trusted click/fill/allowlisted-key input is the default for Page. Native selects
  accept a unique label or index. `fill` replaces the entire value, maximum 4096
  characters; it is not arbitrary rich-editor typing.
- An offscreen supported target may be scrolled once through a guarded
  `scroll_into_view` action, followed by fresh observation and identity checks.
  Ordinary bounded observations also offer page/container scroll operations.
- Open shadow roots and supported native/ARIA controls are included. AX reading
  is broader than guarded actions: frame actions, closed shadow roots, canvas
  and unsupported widgets fail closed. Snapshot frame reading is supported.
- Sensitive controls are excluded by private markers, autocomplete and
  conservative name/id/label checks. Snapshot redaction is separate. Neither
  layer is general secret detection/DLP. A host acting with its own authority
  (a test runner on the application under test) may grant them with
  `allowSensitive: true` (or `BH_ALLOW_SENSITIVE=1` in the host process when
  the option is omitted): password, e-mail, phone and marked fields become
  ordinary candidates whose values appear in observations, so redacting kept
  evidence becomes the host's job. Snapshot redaction is unchanged. The grant
  comes from the host, never from page content or a model. Exact identity hashes require in-page
  SubtleCrypto (normally HTTPS/localhost).
- Page work is serialized; guarded effects also share a transport/scope fence
  across controllers. Independently attached aliases are not a browser-wide
  lock. Queue size, retained scopes, waits and page ownership are bounded.
- `{signal,timeoutMs}` stops later dispatches, not already-sent work. Unresolved
  transport calls retain their queue fence until settlement. GUI input is not
  atomic; page/user races are still possible.
- Origin checks are not a navigation/network firewall or a sandbox around raw
  APIs. Page handlers may navigate after activation. Subsequent reads/effects
  recheck their origin. Host approval must cover every escape hatch too.

## Unsupported mechanics

Use `page.cdp(method,params)` or explicitly routed raw CDP only for authorized
deterministic work or mechanics the guard does not support—not after a denial.
Screenshot → input → screenshot/read-back is appropriate for canvas editors
when independently authorized; see [rich-editors.md](rich-editors.md).

`page.signals()` drains bounded per-page events subscribed at construction.
`page.info()` reports tracked modal state without evaluating blocked page JS.
Raw event recipes are in [agent-signals.md](agent-signals.md); navigation and
readiness recipes are in [lifecycle-readiness.md](lifecycle-readiness.md).

Return compact evidence and remaining uncertainty. `page.dispose()` releases
owned attachments/listeners without closing the user's tab; `page.close()`
closes the tab. `browser.disconnect()` disposes wrappers and the connection,
not user tabs.

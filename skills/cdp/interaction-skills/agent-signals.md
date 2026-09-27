# Scoped page signals

A Page subscribes when it is constructed and owns a bounded digest of relevant
per-session browser events. Browser attachment enables the Page domain before
returning. Read it between decisions:

```js
return { info: await page.info(), signals: page.signals() };
```

`signals()` synchronously returns `{events:[{method,detail}],dropped}` and clears
the buffer. At most 64 events are retained, with 512 characters per detail.
Tracked events are dialogs opening/closing, file choosers, Page downloads,
popups, frame navigation and inspector crashes. Only this page and its owned
child sessions are included; unrelated tabs' events are not mixed in.

`page.info()` returns URL/title/viewport/scroll information, or tracked
`{dialog:{type,message}}` without evaluating page JS while a dialog is open.
It still validates page origin. Calls have the normal page deadline.

Events before attachment are not recoverable. Events can arrive after an action
returns. A digest is awareness, not synchronization or verification. A download
starting is not proof its file was written. Native modal dialogs may require an
independently authorized `Page.handleJavaScriptDialog` call.

## Explicit raw event recipes

For events not in the digest, subscribe to `session.onEvent`, pin the exact
session ID, bound retained data and unsubscribe when finished:

```js
const sid = page.scope.sessionId;
const events = [];
const off = session.onEvent((method, p, eventSid) => {
  if (eventSid !== sid || method !== 'Network.loadingFailed') return;
  if (events.length === 32) events.shift();
  events.push({requestId:p.requestId, error:String(p.errorText).slice(0,256)});
});
try {
  await page.cdp('Network.enable');
  // Perform the authorized task; inspect only task-relevant failures.
} finally { off(); }
```

Browser-level `Target.*` / `Browser.download*` events need explicit target or
download association, not an active-tab lookup. Enable the corresponding CDP
domains/events as needed. For one expected event, arm `session.waitFor` before
the effect and filter the session ID; see
[lifecycle-readiness.md](lifecycle-readiness.md).

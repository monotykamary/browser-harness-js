# mail-google-com

Sending a Gmail message as a send-as alias (a Google Group address, a shared team address) has
no clean API from a CDP session: it is the same signed-in web UI as any other Gmail send, with
one extra, hidden step. This registry exists because that step resists the usual click
techniques and is easy to get subtly wrong (right message, wrong sender).

```js
await learnings("mail-google-com")
await learnings("mail-google-com", "findAccountSlot", { email: "user@example.com" })
await learnings("mail-google-com", "prepareDraftAs", {
  authuser: 0, to: "someone@example.com", subject: "Subject",
  body: "Body text", alias: "alias@example.com",
})
// read back the {to, subject, from} above, get the human's go-ahead, then:
await learnings("mail-google-com", "sendPreparedDraft", { targetId, confirm: true })
await learnings("mail-google-com", "verifySent", { recipient: "someone@example.com" })

await learnings("mail-google-com", "searchRows", { query: "from:someone is:unread", limit: 10 })
await learnings("mail-google-com", "readThread", { query: "subject:\"Invoice #123\"" })
const draft = await learnings("mail-google-com", "composeDraft", {
  to: "someone@example.com", subject: "Subject", body: "Body text",
  attachments: ["/absolute/path/to/file.pdf"],
})
// read back draft.{from, recipients, subject, attachments, body} before any further action
await learnings("mail-google-com", "replaceDraftBody", { targetId: draft.targetId, lines: ["Line one", "Line two"] })
await learnings("mail-google-com", "replaceDraftBody", { targetId: draft.targetId, html: "<div>-- <br>Signature</div>" })

// Draft polish: signature, body above it, attachments, forced save
await learnings("mail-google-com", "pickSignature", { targetId: draft.targetId, name: "Dwarves LLC (EN)" })
// -> { signature: "..." } or { stop: "no-sig-button" | "no-signature-item" }
await learnings("mail-google-com", "setBodyAboveSignature", { targetId: draft.targetId, html: "<div>Hi,<br><br>Body text</div>" })
// -> { length }; the signature block stays untouched
await learnings("mail-google-com", "replaceAttachments", {
  targetId: draft.targetId, files: ["/absolute/path/to/new.pdf"], removeMatch: "\\.(pdf|docx|xlsx)\\b",
})
// -> { attachments: [...] }: READ it, a leftover chip happened once
await learnings("mail-google-com", "saveDraftNow", { targetId: draft.targetId })
// -> { subject }
```

## Limits (learned 2026-09-27)

- **Account picking is by index, not email.** `https://mail.google.com/mail/u/<n>/` selects the
  signed-in account at slot `n`; `document.title` ends with `- <email> - ...`, so
  `findAccountSlot` walks `n=0..3` and matches the title instead of guessing the slot.
- **The compose URL prefills but does not send.** `?view=cm&fs=1&to=...&su=...&body=...` opens a
  full-page compose with To/Subject/Body already filled; Gmail auto-saves it as a draft, so a
  failed or abandoned run leaves a draft behind, not a queued send.
- **The From selector is hidden on this view.** `element.click()` and dispatched `MouseEvent`s on
  the option do nothing. What works is a real `Input.dispatchMouseEvent`
  (`mouseMoved` -> `mousePressed` -> `mouseReleased`) at the element's own bounding-rect centre,
  three times in sequence: click inside the To row to expand the collapsed header (the From line
  then renders as its own leaf), click that From line to open the picker, click the alias option
  (`[role=menuitem]`/`[role=option]`, filtered to non-zero bounding width; the DOM keeps closed
  copies of the same items at width 0). Pressing Enter on the highlighted option did not select
  it.
- **Verify the switch actually happened before trusting it.**
  `[...document.querySelectorAll('input[name=from]')].map(x => x.value)` must include the alias
  address. Do this before Send, not after.
- **Screenshots are 2x device pixel ratio.** A coordinate read off a screenshot is device px, not
  CSS px; divide by the capture scale (2) before using it in `Input.dispatchMouseEvent`. Guessing
  from a screenshot picked the wrong alias once. Element bounding rects are already in CSS px and
  don't need this conversion, so prefer them over screenshot coordinates entirely.
- **Send verification is a Sent-folder search, not a toast.** Real-click the visible
  `[role=button]` whose `innerText` is exactly `Send`, then confirm by navigating to
  `#search/in%3Asent+to%3A<recipient>+newer_than%3A1d` and counting `tr.zA` rows.
- **The thread Reply button was unreliable from a background tab.** In a conversation view it did
  not open a real editor, only an `Ask Gemini` contenteditable was present. Composing a fresh
  `Re: <subject>` through the compose URL (`prepareDraftAs`) was the working fallback for
  replying to an existing thread.
- **Sending is outward and irreversible.** `prepareDraftAs` stops at the alias switch and returns
  `{to, subject, from}` for a read-back. `sendPreparedDraft` refuses unless `confirm: true`, and
  that confirmation should come from the human having reviewed From, To, and Subject in that one
  read, not from the agent's own judgment.

## Limits (learned 2026-09-28)

- **Background-tab rows need textContent, not innerText.** A search or thread list opened in a
  background target (`Target.createTarget({ background: true })`) returns empty `innerText` for
  every row after the first, because Chrome skips layout work for background tabs. `textContent`
  does not depend on layout, so `searchRows` and `readThread` read rows and messages with it.
- **Trusted Types blocks innerHTML, so use DOM nodes or `DOM.setOuterHTML`.** Gmail's compose body
  enforces a Trusted Types policy; a page-script `element.innerHTML = ...` assignment throws.
  Plain text goes in as real nodes (`replaceChildren` with text nodes and `<br>` elements). An
  HTML fragment needs the CDP escape hatch: swap a placeholder div in first, then
  `DOM.setOuterHTML` it -- that write goes through the DOM domain, not a page-script property
  assignment, so Trusted Types never sees it.
- **Attachments go through `DOM.setFileInputFiles` on `input[type=file][name=Filedata]`.** Never
  click the attach button or a file input -- that opens the OS picker, which CDP cannot dismiss.
  Locate the input with `DOM.getDocument({ depth: -1, pierce: true })` + `DOM.querySelector`, then
  set the absolute host paths directly.
- **The prefilled compose URL takes cc and bcc too**, not just to/su/body:
  `?view=cm&fs=1&to=&cc=&bcc=&su=&body=`, built with `URLSearchParams` then `+` swapped for `%20`
  (Gmail's own query parser is picky about literal `+` in a body).
- **A compose left open auto-saves as a draft.** Nothing here ever sends; an aborted or failed
  call at any point leaves recoverable state in Drafts, not a stray outbound message.
- **The REPL only prints a single expression.** A snippet with statements separated by `;` or
  newlines runs but prints nothing back to the caller -- wrap any multi-step read/compose work in
  one node-tool call (as above) instead of a multi-statement inline snippet.

## Limits (learned 2026-10-07)

- **Signature menu items have zero-size twins.** The "Insert signature" menu is a `[role=menu]`
  whose `innerText` reads like `Manage signatures | No signature | Dwarves LLC (EN) | Dwarves
  Vietnam (VI)`. The DOM holds more than one leaf with the same text and the first is often a
  zero-size copy, so `pickSignature` real-clicks the LAST visible leaf whose trimmed
  `textContent` equals the name. It also skips the button click when the menu is already open,
  because a second click closes it.
- **Keep Gmail's signature block, replace only what is above it.** `setBodyAboveSignature` finds
  the top-level body ancestor of `[data-smartmail=gmail_signature]`, removes every body child
  before it, drops in a placeholder div and swaps that via `DOM.setOuterHTML` (innerHTML is
  blocked by Trusted Types, see the 2026-09-28 limit). No signature in the body: it falls back
  to `replaceDraftBody` html mode.
- **A leftover attachment chip happened once.** `replaceAttachments` real-clicks each visible
  `Remove...` control (aria-label or data-tooltip) whose chip text matches `removeMatch` until
  none remain, then sets the files on `input[type=file][name=Filedata]`. Always read the
  returned `attachments` list and compare it to what you expect; do not assume it is clean.
  `removeMatch` is a regex source string (default every `.pdf`, `.docx`, `.xlsx` chip).
- **A DOM-only body edit is not autosaved.** Gmail saves on real input, not on DOM mutation or a
  synthetic `input` event. `saveDraftNow` focuses `input[name=subjectbox]`, puts the caret at the
  end, `Input.insertText` a space, sends a Backspace keyDown/keyUp, then waits 6s. Run it after
  `replaceDraftBody`, `setBodyAboveSignature` or `replaceAttachments` before trusting the draft
  is stored.
- **`readThread` returned no messages twice: a row click in a background tab does not open the
  thread.** It now reads `data-legacy-thread-id` from the first `tr.zA` row's descendant and
  navigates the same target to `#search/<encoded query>/<threadId>`, then reads as before. The
  result also carries `recipients`: the unique `[email]` attribute values with their `name`
  attribute, as `[{ email, name }]`. A first row with no thread id returns
  `{ stop: "no-thread-id" }`.
- **Not run live yet.** These five changes were written offline and checked with `node --check`
  and an export listing only; the first real use is their proof.

## Limits (learned 2026-10-09)

- **A prefilled `body=` drops the signature.** A compose opened with `body=` in the URL gets no signature, even after the From switch. Opened with to and su only, the alias switch swaps in that alias's default signature. `prepareDraftAs` now omits `body=` and writes the body through `setBodyAboveSignature`. It returns `signature` in the readback: an empty string means the draft has none, so check it before Send.
- **`from=` in the compose URL is ignored.** The compose always opens on the account's primary address.
- **Never infer "this alias has no signature" from a draft.** Read Settings > General > Signature defaults instead.
- **The header did not expand on a send-as alias.** The real click on the To row left the From line at width 0, so `prepareDraftAs` stopped at `from-line-not-found`. A synthetic `mousedown`/`mouseup`/`click` on the hidden `[role=option]` switched From three times out of three that day. It is now the fallback, and the `input[name=from]` check still guards it.
- **Proven live end to end** for the first time: `han@console.so` alias, signature "Console Labs" present, body escaped above it. No send.

## Concurrency

The harness REPL server is one long-lived process shared by every Claude session on the machine, and its active-session pointer is global. A tool that moved that pointer to its tab and then made plain `session.X(...)` calls raced other sessions: one session's `Page.navigate` landed in another session's draft tab, and `setBodyAboveSignature`, `replaceAttachments` and `replyInThread` hung or acted on the wrong tab.

- **Fix:** every tool attaches to its own target with `Target.attachToTarget({ targetId, flatten: true })` and sends each Page/DOM/Input/Runtime call to that explicit `sessionId` through `ctx.cdp(sessionId, method, params)`. The file never moves the active-session pointer. `Target.*` calls are browser-level and never read it.
- **Rule:** a caller passes its own `targetId` and never relies on the active tab. The tools that take a `targetId` (`replaceDraftBody`, `pickSignature`, `setBodyAboveSignature`, `replaceAttachments`, `saveDraftNow`, `sendPreparedDraft`) attach to that exact tab; the tools that open their own tab keep the id they created.
- **Focus:** only `replyInThread` and `forwardMessage` call `Target.activateTarget`, because `Input.insertText` into a background tab lands late. The read-only verbs stay in background tabs.
- **Gotcha:** a draft edit made from a stale tab can overwrite the operator's own edit in that draft. Reload the draft (`Page.reload`) before editing a draft the operator may have touched.

## Provenance

2026-09-27, live session sending as a Google Group send-as alias. Driven by hand through
`browser-harness-js` with an explicit `wsUrl`, then distilled here.

Tool status: `findAccountSlot` ran live (hit on slot 1, clean `not-found` on a miss).
`prepareDraftAs`, `sendPreparedDraft` and `verifySent` encode the recipe proven by hand
but have not yet run end to end as tools; the first real use is their proof.

2026-09-28, a session that hand-rolled search/read/compose/body-replace against Gmail roughly
fourteen times distilled `searchRows`, `readThread`, `composeDraft`, and `replaceDraftBody` here
from that session's working recipe. Not yet run end to end as tools; the first real use is their
proof.

2026-10-07, a session that drove Gmail compose by hand about eight times without these verbs
distilled `pickSignature`, `setBodyAboveSignature`, `replaceAttachments`, `saveDraftNow` and the
`readThread` fix. Offline code change, no browser touched.

## Reply and forward in a thread (`replyInThread`, `forwardMessage`)

```js
await learnings("mail-google-com", "replyInThread", {
  query: "from:someone subject:\"Invoice #123\"", cc: "a@example.com, b@example.com",
  bodyLines: ["Hi,", "", "Attached is the signed copy."], bold: ["signed copy"],
  attachments: ["/absolute/path/to/file.pdf"], stripSignature: false,
})
await learnings("mail-google-com", "forwardMessage", {
  query: "from:someone subject:\"Invoice #123\"", to: "finance@example.com", cc: "",
  noteLines: ["FYI, please file this."], stripSignature: true,
})
// -> { targetId, recipients, body (first 300 chars), attachments, signaturePresent, boldMissed }
// Neither verb sends. Read the readback, then send by hand or with sendPreparedDraft-style review.
```

- **One flow, two verbs.** Open `#search/<q>` in a background tab, read `data-legacy-thread-id`, navigate to `#search/<q>/<threadId>` (a row click does nothing there), then `Target.activateTarget`: `Input.insertText` into a background tab lands late.
- **Real clicks only.** Reply is `span.ams.bkH`, Forward is `span.ams.bkG`. Take the last visible match, `scrollIntoView`, then `Input.dispatchMouseEvent`. The bottom-of-thread button acts on the last message.
- **Cc is a keyboard shortcut.** Cmd+Shift+C (`modifiers: 12`, key `C`, code `KeyC`) opens and focuses Cc; type the addresses followed by `, ` so Gmail turns them into chips. Forward focuses To on its own: type `to` plus `, ` first.
- **Body goes at the top of the editor.** Lines are `<div>` nodes built with `createElement` and `createTextNode` (Trusted Types blocks innerHTML) and inserted before the editor's first child, so they sit above the signature and the quote. Bold is a `Range` over the first occurrence plus `document.execCommand("bold")`; substrings not found come back in `boldMissed`.
- **`stripSignature` stays inside the compose editor and skips `.gmail_quote`.** Otherwise a forward would lose the original sender's signature, which lives in the quote.
- **Attachments use the LAST file input.** `DOM.querySelectorAll('input[type=file][name=Filedata]')` on a pierced document, then `DOM.setFileInputFiles` on the last node: older nodes belong to other composes. Forwarded attachments carry over by themselves and show up in the readback.
- **Autosave needs a real keystroke.** Space then Backspace in the editor with the caret at the end, then wait 6s (an inline reply has no subject box, unlike `saveDraftNow`).
- **Not run live yet.** Written offline from a recipe proven by hand and checked statically only; the first real use is their proof. The recipients/attachments readback scopes to the compose container by climbing from the editor to the nearest ancestor holding a form or the `to`/`cc`/`subjectbox` fields; if that scope is wrong live, fix the climb in `readComposeBack` first.

## Forwarding and filters

```js
// Add a forwarding address (never answers the follow-on challenge itself):
await learnings("mail-google-com", "addForwardingAddress", { authuser: 0, address: "someone@example.com" })
// -> {status: "challenge", popupTargetId} (a Verify-it's-you accounts.google.com popup) or
//    {status: "sent"} (Google emailed a confirmation link instead). Answer the challenge/email
//    yourself, then:
await learnings("mail-google-com", "confirmForwarding", { verifyUrl: "https://mail-settings.google.com/mail/vf-..." })

// Forward matching mail via a filter, dry-run first:
await learnings("mail-google-com", "createForwardFilter", {
  authuser: 0, query: "from:(alerts@bank.com) subject:(Statement)",
  forwardTo: "finance@example.com", dryRun: true,
})
// once the asserted state looks right, re-run with dryRun: false (or omitted) to actually create it.
```

## Forwarding + filter limits (learned 2026-09-28)

- **The forwarding settings page (`#settings/fwdandpop`) can take 20-40s to render in a background
  tab.** Poll for `input[name=sx_em]` (the two forwarding radios: `value="0"` Disable, `value="1"`
  Forward a copy) instead of a fixed sleep.
- **Never type into the inline "Forward a copy of incoming mail to" textbox.** It looks like a
  plain field next to the radios, but confirmed live: focusing it and typing an address
  auto-checks the `value="1"` radio as a side effect (forwarding ALL mail, not just filtered mail),
  and saving an unverified address entered there fails with "Invalid forwarding address". Always
  go through the real "Add a forwarding address" button/dialog instead, and leave "Disable
  forwarding" selected on this page.
- **Adding a forwarding address ends in one of two places**, and `addForwardingAddress` returns
  before either resolves: a separate `accounts.google.com` "Verify it's you" popup target
  (`{status:"challenge", popupTargetId}`), or Google emailing a `mail-settings.google.com/mail/vf-...`
  confirmation link directly (`{status:"sent"}`). `confirmForwarding` opens that vf- link and
  clicks Confirm; neither verb answers the challenge itself.
- **Checkboxes in the Create-filter dialog are rendered off-screen.** Confirmed live: the "Forward
  it to:" checkbox's own bounding rect has `x` around -9675 (same off-screen-render trick as
  elsewhere in Gmail's UI). Real-click the associated `<label>` text instead; native `label[for]`
  click semantics toggle the input.
- **The forward-to listbox's own DOM node keeps its last-selected option as a same-width
  placeholder; the real options that appear on open are separate, wider (>200px CSS px) elements
  elsewhere in the DOM.** Filter `[role=option]` by width before matching text, same trick as the
  alias picker in `prepareDraftAs`.
- **Assert before touching Create filter.** Confirmed live: after ticking "Forward it to:" and
  picking an address, exactly one `input[type=checkbox]` in the dialog is checked and the listbox
  text equals the chosen address; `createForwardFilter` asserts this and refuses to proceed (even
  past `dryRun`) if it doesn't hold.
- **Create filter and its Continue confirmation need real `Input.dispatchMouseEvent` clicks, not
  `element.click()`.** A DOM click carries no user gesture, and Gmail's "verify it's you"
  confirmation for a forwarding filter is silently blocked without one.
- **`dryRun: true` stops right before the Create filter click** and returns the same asserted
  `{checkedOnes, listboxText}` state a real run would have proceeded past, so a caller can read it
  back before ever mutating anything.

### Provenance (forwarding verbs)

2026-09-28, live session on Han's running Helium (`ws://127.0.0.1:9222`, explicit `wsUrl`) adding
forwarding + filter verbs. `createForwardFilter` ran live end to end with `dryRun: true` against
authuser 0, query `from:(mailalert@acb.com.vn) subject:(e-Statement)`, `forwardTo:
finance@fromwu.com` (an address already verified on the account) and returned the asserted state
with exactly the "Forward it to:" checkbox ticked and the listbox reading `finance@fromwu.com `.
`addForwardingAddress` and `confirmForwarding` encode the recipe (the inline-textbox landmine and
the off-screen forwarding checkbox were both confirmed live by hand during discovery) but have not
yet run end to end as tools -- the first real use is their proof.

## Signature body from HTML (`setSignatureHtml`)

- **Paste, don't inject.** Gmail enforces Trusted Types, so `innerHTML` and `execCommand('insertHTML')` throw in the signature editor. Put the HTML on the macOS clipboard (`osascript` with `«class HTML»` hex data), focus `[contenteditable=true][aria-label=Signature]`, then send `Input.dispatchKeyEvent` with `modifiers:4` and `commands:['selectAll']`, then `['paste']`.
- **Warm the settings page.** Load the inbox first, then `#settings/general`; a cold load of the settings hash often renders nothing. Poll for the editor up to 15 s.
- **Select the signature by its list text:** the visible leaf whose text equals the name, outside any `<select>` or contenteditable. Then click `Save Changes` and wait about 5 s.
- **Verify by reload.** The tool reloads and returns the editor text, `<img>` count, loaded-image count (`naturalWidth>0`) and link count. It never returns clipboard contents.

# mail-proton-me

Read-only access to Proton Mail web through a CDP session: find the account slot, search, read a whole conversation. No send, delete, move, label or mark tool exists here on purpose.

```js
await learnings("mail-proton-me", "findAccountSlot", { email: "user@example.com" })   // -> { slot }
await learnings("mail-proton-me", "searchRows", { slot: 1, term: "keyword", limit: 10 })
await learnings("mail-proton-me", "readConversation", { slot: 1, term: "keyword", index: 0 })
// later, skip the search with the url from a previous result:
await learnings("mail-proton-me", "readConversation", { url: "https://mail.proton.me/u/1/almost-all-mail/<conversationId>/<messageId>#keyword=keyword" })
```

Each call opens its own background tab, drives it by explicit sessionId (`ctx.cdp`), and closes it in `finally`. It never calls `session.use`, so other sessions sharing the REPL keep their tab.

## What works (verified live)

- **Search is a URL.** `https://mail.proton.me/u/<slot>/almost-all-mail#keyword=<term>`. Rows (`[data-shortcut-target=item-container]`) arrive in a burst; the tools poll until the count is stable instead of sleeping a fixed time. Read rows with `textContent`.
- **Account slots.** `/u/<n>/` where n is not a signed-in slot redirects to one that is, so the loop index lies. Read the slot from the final URL and match the email in `document.title` (`Inbox | <email> | Proton Mail`).
- **Reading a whole conversation.** All message bodies came back: a 13-message conversation read 13 of 13 in about 10 seconds.

## The mechanics that matter

- **Row click needs focus emulation.** In a hidden background tab a click does not open the message and its iframes stay empty. `Emulation.setFocusEmulationEnabled({enabled:true})` makes the page report visible and focused without bringToFront. After that a real `Input.dispatchMouseEvent` click (scrollIntoView, then rect centre) opens any row, not just the first.
- **`data-element-id` is the conversation id, and a bare conversation URL fails.** Navigating to `/<label>/<conversationId>` shows one collapsed message, then an error banner (`conversation-view:error-banner-button`, "Try again"). The URL that works after a row click is `/<label>/<conversationId>/<messageId>`. The message id is not on the row, so the tools click the row; `readConversation({url})` accepts the full URL for a replay.
- **Only the open message has a body iframe.** The rest render as `message-header-collapsed:<n>` with no iframe. There is no "expand all" control. Clicking each collapsed header with `element.click()` works (a real click is not needed), then the bodies load as `iframe[data-testid=content-iframe]` inside `[data-testid=message-view-<n>]`. Their `contentDocument.body.innerText` is same-origin readable. Wait for the iframe text length instead of sleeping.
- **Messages are in `message-view-<n>` order**, oldest first.

## Limits

- **Opening a message can mark it read.** Proton does that by default for an unread message you open. The tools cannot avoid it; do not run them on a mailbox where unread state matters.
- **Search result rows can be several messages of one conversation.** Different `index` values can resolve to the same conversation.
- **Bare-id navigation is not offered.** Use `term` plus `index`, or a full `url`.
- **Output is mailbox content.** Print counts and lengths when logging, not text.
- **Edit then restart.** The REPL caches imported modules; run `browser-harness-js --restart` after editing the tool, then reconnect.

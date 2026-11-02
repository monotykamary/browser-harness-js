# discord.com (Han's own client, read-only DM reader)

Tools are in `tools/discord-com.mjs`: `listDms` and `readDm`. Each opens its own background target and closes it. Restart the daemon after editing (`browser-harness-js --restart`).

## Scope rules

- Read-only by design. Never send a message through the web client: Discord forbids self-bot automation. Reading what Han can see in his own logged-in client is the whole scope.
- Do not use or extract the user token (no `localStorage`, no webpack module scraping, no API calls with it). DOM reading only. Bot-token work lives in `discord-com-developers`.
- No clicks, no typing. The tools navigate and set `scrollTop`; that is all.

## DOM facts (proven live)

| Thing | Selector | Notes |
|---|---|---|
| DM and group links | `a[href*="/channels/@me/"]` | `aria-label` reads `vincent (direct message), Do Not Disturb` or `PAMsheep, Thinh (group message), 3 Members`; the text before `(direct message)` or `(group message)` is the name |
| Message rows | `li[id^=chat-messages-]` | count 0 means not rendered yet |
| Timestamp | `time[datetime]` | ISO string |
| Author | `[id^=message-username-]` | empty on continuation messages: carry the last non-empty author forward (the tool does) |
| Text | `[id^=message-content-]` | use `innerText` |
| Scroller | `ol[data-list-id=chat-messages]` then `.closest('[class*=scroller]')` | set `scrollTop = 0` to load older history |
| Start marker | page text "beginning of your direct message history" | stop scrolling here |

## Gotchas

- Rendering is slow in a hidden tab. A navigation took about 15s to show messages; a fixed 7s wait returned 0 rows. Always poll, never sleep once.
- Scrolling for older history in a hidden/background tab may not load more. If `reachedStart` is false and `scrolls` ended early, the count stopped growing. The documented escape hatch is `Target.activateTarget` once on the tab (see `targetId` in a `stop` result, or open the channel yourself). Warning: that takes over Han's screen, so ask first and do it once.
- The first rows after a partial scroll can have an empty-author continuation with nothing earlier to carry from, so their `author` is blank until `reachedStart` is true.
- browser-harness-js prints nothing for a page expression that throws or returns undefined. Wrap page expressions in `String(...)` or `JSON.stringify(...)` and check `exceptionDetails` (the tool's `evaluate` throws on it).
- Reaction counts, replies, embeds and attachments beyond an `<img>` count are not read.

## Status of the tools

Written from DOM facts proven by hand in a live session; the tools were checked statically only (`node --check`, manifest parse, SDK tests), not run end to end.

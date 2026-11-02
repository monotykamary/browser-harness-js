# facebook.com (Page composer)

Recipes for driving a logged-in Facebook session that manages a Page.

## Posting (`createPagePost` node-tool)

The whole flow: open the Page URL in a foreground tab -> DOM-click the
"What's on your mind?" button -> focus the textbox inside the `Create post`
dialog -> `Input.insertText` for the full body -> `DOM.setFileInputFiles` on
the dialog's `input[type=file]` -> DOM-click the `aria-label="Post"` button ->
reload the Page and confirm the text is in the feed.

Learned by hand-driving a real post on a managed Page:

- **Synthesized mouse events do not open the composer.** A
  `Input.dispatchMouseEvent` pair on the button's rect left the page as it was.
  `element.click()` through `Runtime.evaluate` opens the dialog. The same holds
  for the Post button. Use mouse events only for focusing the textbox before
  `insertText`.
- **Two `Create post` dialogs exist while composing.** Both carry the same
  `aria-label`; only one contains the `[role=textbox]`. Select by that child.
- **Four `input[type=file]` elements are on the page**; the one inside
  `[role=dialog]` is the composer's and it accepts images, gif, and video. Set
  files on it directly; it works while hidden.
- **A gif is accepted as media.** Preview shows within ~8s for a small file.
- **The feed is virtualized.** After the reload, `document.body.textContent`
  holds the post text, but `[role=article]` around it can be empty and the
  permalink is often absent. `createPagePost` returns `{posted: true, url: null}`
  in that case; the post is live, open the Page's Posts list to find it.
- **Session re-bind after navigation.** After `Page.navigate` or
  `location.reload()` the harness session can answer for a different target.
  Call `session.use(targetId)` again before evaluating.
- **Log-in check:** a logged-out session renders `input[name=email]` in place
  of the composer. The tool refuses with `{posted: false, reason: "logged out"}`.
- **Personal profile:** unverified. The same dialog shape appears on a profile
  URL, so the tool should work with `pageUrl` set to the profile; confirm by
  hand once before relying on it.

## Listing a Page's reels (`listPageReels` node-tool)

Open `https://www.facebook.com/<page-id>/reels/` and collect unique ids from
`a[href*="/reel/"]` (`/reel/(\d+)`). The grid lazy-loads, so the tool scrolls
until the count is unchanged for ~10 rounds (or a max-rounds bound).

- **Hidden-tab lazy-load trap.** A background tab (`Target.createTarget`
  with `background: true`, the right choice so the user's window never moves)
  is "hidden" to the page: Facebook's lazy loader never fires. Plain
  `window.scrollTo` stalled at 11 ids. Fix, all three needed: call
  `Emulation.setFocusEmulationEnabled({enabled: true})` and
  `Page.setWebLifecycleState({state: 'active'})` after `session.use(targetId)`,
  then scroll with real wheel events (`Input.dispatchMouseEvent`,
  `type: 'mouseWheel'`, `deltaY: 3000`) as well as `scrollBy`. That reached
  ~150 ids on a real Page. Never `Page.bringToFront`.
- **Scroll the last reel link into view each round**, then wheel, then wait
  ~2s; the next batch is keyed off the last anchor reaching the viewport.
- **Logged out:** `input[name=email]` is present; the tool returns
  `{ids: [], reason: "logged out"}`. Zero reels returns `{ids: [], reason}` too.
- **Close the tab** in `finally` so the user's tab count is unchanged.

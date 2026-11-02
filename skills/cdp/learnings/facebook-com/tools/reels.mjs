// learnings/facebook-com/tools/reels.mjs
// List every reel id on a Facebook Page's reels tab. Opens the URL in a BACKGROUND tab (never
// brought to front), forces the hidden tab to behave as visible (focus emulation + lifecycle
// state "active", otherwise the lazy loader never fires), then scrolls with real wheel events
// until the unique-id count stops growing. Closes the tab at the end.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(exceptionDetails.text || ex.description || "Runtime.evaluate failed");
  }
  return result ? result.value : undefined;
}

// Unique reel ids from every anchor that points at /reel/<digits>.
const COLLECT_IDS = `JSON.stringify([...new Set([...document.querySelectorAll('a[href*="/reel/"]')]
  .map((a) => (a.href.match(/\\/reel\\/(\\d+)/) || [])[1]).filter(Boolean))])`;

const SCROLL_LAST = `(() => {
  const links = document.querySelectorAll('a[href*="/reel/"]');
  if (links.length) links[links.length - 1].scrollIntoView({ block: "end" });
  window.scrollBy(0, 4000);
})()`;

export async function listPageReels(ctx, args) {
  const { pageUrl, maxRounds = 120, stallRounds = 10, settleMs = 2000 } = args || {};
  if (!pageUrl) throw new Error("listPageReels: pageUrl is required");

  const { targetId } = await ctx.session.Target.createTarget({ url: pageUrl, background: true });
  try {
    await ctx.session.use(targetId);
    // A background tab is "hidden": Facebook's lazy loader never runs. Make it look visible.
    await ctx.session.Emulation.setFocusEmulationEnabled({ enabled: true });
    await ctx.session.Page.enable();
    await ctx.session.Page.setWebLifecycleState({ state: "active" }).catch(() => {});
    await wait(7000);

    const state = JSON.parse((await evaluate(ctx, `JSON.stringify({
      url: location.href,
      loggedOut: !!document.querySelector('input[name=email]'),
    })`)) || "{}");
    if (state.loggedOut) return { ids: [], reason: "logged out", url: state.url };

    let ids = [];
    let unchanged = 0;
    let rounds = 0;
    while (rounds < maxRounds && unchanged < stallRounds) {
      rounds += 1;
      await evaluate(ctx, SCROLL_LAST);
      await ctx.session.Input.dispatchMouseEvent({ type: "mouseWheel", x: 400, y: 400, deltaX: 0, deltaY: 3000 });
      await wait(settleMs);
      const now = JSON.parse((await evaluate(ctx, COLLECT_IDS)) || "[]");
      unchanged = now.length === ids.length ? unchanged + 1 : 0;
      ids = now;
    }

    if (!ids.length) return { ids: [], reason: "no reels found (empty page or no access)", url: state.url };
    return {
      ids,
      urls: ids.map((id) => `https://www.facebook.com/reel/${id}/`),
      count: ids.length,
      rounds,
      stalled: unchanged >= stallRounds,
    };
  } finally {
    ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  }
}

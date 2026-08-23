// learnings/example/tools/get-outline.mjs
// Demonstrates a learnings node-tool: returns the H2 section headings of the
// currently-loaded page. Called as `getOutline(ctx, args)` where `ctx` carries
// every REPL global (`ctx.session`, `ctx.cdp`, `ctx.axView`, ...). Edit/clone
// this — replace per-site scraping recipes with one named tool here so the
// agent stops re-deriving the selector chain each call.
export async function getOutline(ctx, args) {
  const limit = (args && typeof args.max === "number" && args.max >= 0) ? args.max : 100;
  const { result, exceptionDetails } = await ctx.session.domains.Runtime.evaluate({
    expression: 'JSON.stringify([...document.querySelectorAll("h2")].slice(0,' + limit + ').map(h => h.textContent.trim()).filter(Boolean))',
    returnByValue: true,
  });
  if (exceptionDetails) {
    const ex = exceptionDetails.exception || {};
    throw new Error(exceptionDetails.text || ex.description || "Runtime.evaluate failed");
  }
  if (!result || !result.value) return [];
  return JSON.parse(result.value);
}
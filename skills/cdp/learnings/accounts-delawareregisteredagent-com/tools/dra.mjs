// learnings/accounts-delawareregisteredagent-com/tools/dra.mjs
// Client portal of A Registered Agent, Inc. (an SPA). The page serves a JSON API under
// /api/v3/client/ that works with fetch(path, {credentials:"include"}) from a page on the portal
// origin: the browser's own login cookies are enough, no token is read from storage.
// All tools here are read-only GETs.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const HOST = "accounts.delawareregisteredagent.com";
const HOME = `https://${HOST}/`;
const API = "/api/v3/client/";

async function evaluate(ctx, expression) {
  const { result, exceptionDetails } = await ctx.session.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text || (exceptionDetails.exception || {}).description || "Runtime.evaluate failed");
  return result ? result.value : undefined;
}

// GET one API path from inside the page; resolves {status, json} (json null if the body is not JSON).
const getExpr = (path) => `(async()=>{const r=await fetch(${JSON.stringify(path)},{credentials:"include"});
  const t=await r.text();let j=null;try{j=JSON.parse(t)}catch(e){}return {status:r.status,json:j}})()`;

// Pin the session to a portal tab. Prefer one already open (a fresh tab can land on an auth
// redirect, #state=..., that takes a few seconds to finish). Otherwise open a background tab and
// poll until the API answers. Returns {targetId, created}.
async function pin(ctx) {
  const { targetInfos } = await ctx.session.Target.getTargets();
  const open = targetInfos.find((t) => t.type === "page" && new URL(t.url || "about:blank").host === HOST);
  if (open) {
    await ctx.session.use(open.targetId);
    return { targetId: open.targetId, created: false };
  }
  const { targetId } = await ctx.session.Target.createTarget({ url: HOME, background: true });
  await ctx.session.use(targetId);
  for (let i = 0; i < 20; i++) {
    await wait(1500);
    try {
      const res = await evaluate(ctx, `location.host===${JSON.stringify(HOST)} ? ${getExpr(API + "companies?limit=1&offset=0")} : null`);
      if (res && res.status === 200) return { targetId, created: true };
    } catch (e) { /* execution context destroyed mid-redirect: keep polling */ }
  }
  ctx.session.Target.closeTarget({ targetId }).catch(() => {});
  throw new Error("portal tab never became ready: logged out, or the auth redirect did not finish");
}

async function withPortal(ctx, fn) {
  const tab = await pin(ctx);
  try {
    return await fn();
  } finally {
    if (tab.created) ctx.session.Target.closeTarget({ targetId: tab.targetId }).catch(() => {});
  }
}

async function apiGet(ctx, path) {
  const res = await evaluate(ctx, getExpr(API + path));
  if (res.status === 401 || res.status === 403) throw new Error(`portal API ${res.status}: not signed in`);
  if (res.status !== 200 || !res.json) throw new Error(`portal API ${res.status} for ${path.split("?")[0]}`);
  return res.json.result;
}

async function fetchAllDocuments(ctx) {
  return apiGet(ctx, "client_documents?limit=200&offset=0");
}

export async function listDocuments(ctx) {
  return withPortal(ctx, async () => {
    const docs = await fetchAllDocuments(ctx);
    return docs.map((d) => ({
      id: d.id,
      title: d.title,
      type: d.type,
      company_name: d.company_name,
      pageCount: Array.isArray(d.pages) ? d.pages.length : 0,
    }));
  });
}

export async function listCompanies(ctx) {
  return withPortal(ctx, () => apiGet(ctx, "companies?limit=500&offset=0"));
}

// Presigned page-image URLs for one document (docId) or all of them. The loop runs inside the page
// and stores its result on window.__draPages; a long awaited Runtime.evaluate can make the CLI print
// nothing, so this starts it and polls with short evaluates. URLs are short-lived: download at once.
export async function pageUrls(ctx, { docId, timeoutMs = 300000 } = {}) {
  return withPortal(ctx, async () => {
    let docs = await fetchAllDocuments(ctx);
    if (docId) docs = docs.filter((d) => String(d.id) === String(docId));
    if (docId && !docs.length) return { stop: "doc-not-found" };
    const jobs = [];
    for (const d of docs) (d.pages || []).forEach((p, i) => jobs.push({ docId: d.id, title: d.title, i, pageId: p }));

    await evaluate(ctx, `(()=>{
      const jobs=${JSON.stringify(jobs)};
      window.__draPages={done:false,out:[],err:0};
      let next=0;
      const worker=async()=>{while(next<jobs.length){const j=jobs[next++];
        try{const r=await fetch(${JSON.stringify(API)}+"client_documents/"+j.docId+"/page/"+j.pageId,{credentials:"include"});
          const body=await r.json();const url=body&&body.result&&body.result.url;
          if(url)window.__draPages.out.push({docId:j.docId,title:j.title,i:j.i,url});else window.__draPages.err++;
        }catch(e){window.__draPages.err++}}};
      Promise.all([worker(),worker(),worker(),worker()]).then(()=>{window.__draPages.done=true});
      return true})()`);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await wait(1500);
      if (await evaluate(ctx, "window.__draPages.done")) break;
    }
    const state = await evaluate(ctx, "window.__draPages");
    if (!state.done) return { stop: "timeout", partial: state.out.length, expected: jobs.length };
    state.out.sort((a, b) => String(a.docId).localeCompare(String(b.docId)) || a.i - b.i);
    return state.out;
  });
}

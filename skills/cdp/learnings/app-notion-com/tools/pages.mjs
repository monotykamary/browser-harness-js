// learnings/app-notion-com/tools/pages.mjs
// Page and database tools on Notion's internal /api/v3, for workspaces no API token reaches.
// Every tool re-pins the session to an app.notion.com tab, then runs ONE Runtime.evaluate that
// does all the fetches in-page and returns plain JSON (the REPL prints nothing fetch-derived).
// No workspace id, user id or name is baked in: pass them as arguments.
import { pin, ev } from "./workspace.mjs";

// In-page helper, prepended to every expression. Navigation wipes window globals, so nothing is cached.
const LIB = `
const post = async (path, body) => {
  const r = await fetch("/api/v3/" + path, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(body)});
  const t = await r.text();
  try { return JSON.parse(t); } catch (e) { return {isNotionError: true, debugMessage: path + " HTTP " + r.status + " " + t.slice(0, 200)}; }
};
const err = (r) => r && r.isNotionError ? (r.debugMessage || r.message || "unknown Notion error") : null;
const unwrap = (rec) => { const v = rec && rec.value; return v && v.value && typeof v.value === "object" && "role" in v ? v.value : (v || null); };
const uuid = () => crypto.randomUUID();
const txt = (a) => (a || []).map((x) => x[0]).join("");
const spaces = async () => {
  const r = await post("getSpaces", {});
  if (r && r.name === "UnauthorizedError") throw new Error("not signed in to app.notion.com");
  const e = err(r); if (e) throw new Error("getSpaces failed: " + e);
  return r;
};
const getRecs = async (table, ids, spaceId) => {
  const r = await post("syncRecordValuesSpace", {requests: ids.map((id) => ({pointer: {table, id, spaceId}, version: -1}))});
  const e = err(r); if (e) throw new Error("syncRecordValuesSpace failed: " + e);
  const bucket = (r.recordMap && r.recordMap[table]) || {};
  return Object.fromEntries(ids.map((id) => [id, unwrap(bucket[id])]));
};
// Find the workspace that holds a block when the caller gave no spaceId.
const findSpace = async (blockId) => {
  const all = await spaces();
  const ids = new Set();
  for (const u of Object.values(all)) for (const rec of Object.values((u && u.space) || {})) { const s = unwrap(rec); if (s && s.id) ids.add(s.id); }
  for (const sid of ids) { try { const b = (await getRecs("block", [blockId], sid))[blockId]; if (b && b.alive !== false) return sid; } catch (e) { /* wrong workspace: Notion errors instead of returning null */ } }
  throw new Error("block " + blockId + " not found in any workspace of the signed-in user");
};
const userFor = async (spaceId) => {
  const all = await spaces();
  for (const [uid, u] of Object.entries(all)) for (const rec of Object.values((u && u.space) || {})) { const s = unwrap(rec); if (s && s.id === spaceId) return uid; }
  return Object.keys(all)[0];
};
const collectionOf = async (pageId, spaceId) => {
  const b = (await getRecs("block", [pageId], spaceId))[pageId];
  if (!b) throw new Error("block " + pageId + " not found in space " + spaceId);
  const cid = b.collection_id || (b.format && b.format.collection_pointer && b.format.collection_pointer.id);
  const vid = (b.view_ids || [])[0];
  if (!cid || !vid) throw new Error("block " + pageId + " is not a database page (no collection or view)");
  const coll = (await getRecs("collection", [cid], spaceId))[cid];
  if (!coll) throw new Error("collection " + cid + " not readable");
  return {cid, vid, schema: coll.schema || {}};
};
const rowIds = async (cid, vid, spaceId, limit) => {
  const r = await post("queryCollection", {
    collection: {id: cid, spaceId}, collectionView: {id: vid, spaceId},
    loader: {type: "reducer", reducers: {collection_group_results: {type: "results", limit}}, searchQuery: "", userTimeZone: "UTC"},
  });
  const e = err(r); if (e) throw new Error("queryCollection failed: " + e);
  return r.result.reducerResults.collection_group_results.blockIds;
};
`;

async function run(ctx, body) {
  await pin(ctx);
  const out = await ev(ctx, `(async()=>{try{${LIB}${body}}catch(e){return {thrown:String(e&&e.message||e)}}})()`);
  if (out && out.thrown) throw new Error(out.thrown);
  return out;
}

// Rows as name -> plain value. Dates give start (and "start -> end"), people "@<userId>", relations "rel:<pageId>".
// Each row also carries _id (its block id), which recreateRows needs.
export async function readCollection(ctx, { pageId, spaceId, limit = 300 } = {}) {
  if (!pageId) throw new Error("readCollection: pageId is required");
  return run(ctx, `
const spaceId = ${JSON.stringify(spaceId || null)} || await findSpace(${JSON.stringify(pageId)});
const {cid, vid, schema} = await collectionOf(${JSON.stringify(pageId)}, spaceId);
const ids = await rowIds(cid, vid, spaceId, ${Number(limit)});
const recs = await getRecs("block", ids, spaceId);
const name = Object.fromEntries(Object.entries(schema).map(([k, s]) => [k, s.name]));
const one = (x) => {
  const a = (x[1] || []).find((n) => ["d", "u", "p"].includes(n[0]));
  if (!a) return x[0];
  if (a[0] === "d") return a[1].start_date + (a[1].end_date ? " -> " + a[1].end_date : "");
  if (a[0] === "u") return "@" + a[1];
  return "rel:" + a[1];
};
return {
  spaceId, collectionId: cid, viewId: vid,
  schema: Object.values(schema).map((s) => ({name: s.name, type: s.type})),
  rows: ids.filter((i) => recs[i]).map((i) => {
    const o = {_id: i};
    for (const [k, v] of Object.entries(recs[i].properties || {})) o[name[k] || k] = (v || []).map(one).join("");
    return o;
  }),
};`);
}

// Create a TOP-LEVEL page with blocks in one transaction.
// blocks: [[type, richText]] where richText is [["text"]] (or a plain string), or ["table", [[cell, ...], ...]].
// editors (non-empty user ids) become user_permission editor rows on the page: without them the
// page is a role-none orphan nobody can edit again, the creator included. parentAfter is the id of
// the top-level page to sit after; omit it to append.
export async function createPage(ctx, { spaceId, parentAfter, title, blocks = [], editors } = {}) {
  if (!spaceId || !title) throw new Error("createPage: spaceId and title are required");
  if (!Array.isArray(editors) || !editors.length) throw new Error("createPage: editors (non-empty user id array) is required; a top-level page without permissions becomes an uneditable orphan");
  return run(ctx, `
const spaceId = ${JSON.stringify(spaceId)}, after = ${JSON.stringify(parentAfter || null)};
const title = ${JSON.stringify(title)}, BLOCKS = ${JSON.stringify(blocks)}, EDITORS = ${JSON.stringify(editors)};
const me = await userFor(spaceId);
const stamp = () => ({created_time: Date.now(), last_edited_time: Date.now(), created_by_table: "notion_user", created_by_id: me, last_edited_by_table: "notion_user", last_edited_by_id: me});
const op = (id, path, command, args, table) => ({pointer: {table: table || "block", id, spaceId}, path, command, args});
const rich = (d) => typeof d === "string" ? [[d]] : d;
const pageId = uuid(), ops = [];
ops.push(op(pageId, [], "set", {type: "page", id: pageId, version: 1, alive: true, parent_id: spaceId, parent_table: "space", space_id: spaceId,
  properties: {title: [[title]]}, permissions: EDITORS.map((u) => ({type: "user_permission", role: "editor", user_id: u})), ...stamp()}));
ops.push(op(spaceId, ["pages"], "listAfter", after ? {after, id: pageId} : {id: pageId}, "space"));
const child = (parent, type, extra) => {
  const b = uuid();
  ops.push(op(b, [], "set", {type, id: b, version: 1, alive: true, parent_id: parent, parent_table: "block", space_id: spaceId, ...extra, ...stamp()}));
  ops.push(op(parent, ["content"], "listAfter", {id: b}));
  return b;
};
for (const [type, data] of BLOCKS) {
  if (type !== "table") { child(pageId, type, {properties: {title: rich(data)}}); continue; }
  const cols = data[0].map(() => uuid().slice(0, 4));
  const t = child(pageId, "table", {format: {table_block_column_order: cols, table_block_column_header: true}});
  for (const row of data) { const props = {}; row.forEach((cell, i) => { props[cols[i]] = [[cell]]; }); child(t, "table_row", {properties: props}); }
}
const r = await post("saveTransactionsFanout", {requestId: uuid(), transactions: [{id: uuid(), spaceId, debug: {userAction: "browser-harness-js createPage"}, operations: ops}]});
const e = err(r);
return {ok: !e, error: e, pageId, ops: ops.length};`);
}

// Update row properties by replacing rows. Raw property updates are rejected ("Block property value
// updates must use high-level property operations"), so each changed row is recreated with merged
// properties and the old row is set alive:false.
// changes: [{rowId, set: {PropertyName: value}}]; value is a plain string or a raw rich-text array
// (e.g. people [["‣",[["u",id]]]], date [["‣",[["d",{type:"date",start_date:"2026-01-31"}]]]]).
// The title property is addressed by its schema name. dryRun:true builds and counts the ops, sends nothing.
// Child content under a row is not moved: it stays under the dead row.
export async function recreateRows(ctx, { pageId, spaceId, changes, dryRun = false } = {}) {
  if (!pageId || !Array.isArray(changes) || !changes.length) throw new Error("recreateRows: pageId and a non-empty changes array are required");
  for (const c of changes) if (!c || !c.rowId || !c.set || typeof c.set !== "object") throw new Error("recreateRows: every change needs rowId and set{}");
  return run(ctx, `
const spaceId = ${JSON.stringify(spaceId || null)} || await findSpace(${JSON.stringify(pageId)});
const CHANGES = ${JSON.stringify(changes)}, dryRun = ${dryRun ? "true" : "false"};
const {cid, schema} = await collectionOf(${JSON.stringify(pageId)}, spaceId);
const key = Object.fromEntries(Object.entries(schema).map(([k, s]) => [s.name, k]));
const me = await userFor(spaceId);
const recs = await getRecs("block", CHANGES.map((c) => c.rowId), spaceId);
const ops = [], newIds = {};
for (const c of CHANGES) {
  const row = recs[c.rowId];
  if (!row || row.alive === false) throw new Error("row " + c.rowId + " not found or already dead");
  if (row.parent_table !== "collection" || row.parent_id !== cid) throw new Error("row " + c.rowId + " does not belong to this database");
  const merged = {...(row.properties || {})};
  for (const [n, v] of Object.entries(c.set)) {
    if (!(n in key)) throw new Error("unknown property: " + n);
    merged[key[n]] = typeof v === "string" ? [[v]] : v;
  }
  const nid = uuid(); newIds[c.rowId] = nid;
  const now = Date.now();
  ops.push({pointer: {table: "block", id: nid, spaceId}, path: [], command: "set", args: {type: "page", id: nid, version: 1, alive: true,
    parent_id: cid, parent_table: "collection", space_id: spaceId, properties: merged,
    created_time: now, last_edited_time: now, created_by_table: "notion_user", created_by_id: me, last_edited_by_table: "notion_user", last_edited_by_id: me}});
  ops.push({pointer: {table: "block", id: c.rowId, spaceId}, path: [], command: "update", args: {alive: false, last_edited_time: now}});
}
if (dryRun) return {ok: true, dryRun: true, error: null, ops: ops.length, newIds};
const r = await post("saveTransactionsFanout", {requestId: uuid(), transactions: [{id: uuid(), spaceId, debug: {userAction: "browser-harness-js recreateRows"}, operations: ops}]});
const e = err(r);
return {ok: !e, error: e, ops: ops.length, newIds};`);
}

const dashUuid = (id) => {
  const h = String(id || "").replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(h)) throw new Error("pagePropertyHistory: pageId must be a 32-hex uuid, dashed or not");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const rec = (r) => (r && r.value && r.value.value) || (r && r.value) || null;

// Rich text -> plain string. Dates give start ("start -> end"), people the user name or "@<id>", relations "rel:<pageId>".
function plain(value, names) {
  return (value || []).map((seg) => {
    const a = (seg[1] || []).find((n) => ["d", "u", "p"].includes(n[0]));
    if (!a) return seg[0];
    if (a[0] === "d") return a[1].start_date + (a[1].end_date ? " -> " + a[1].end_date : "");
    if (a[0] === "u") return names[a[1]] || "@" + a[1];
    return "rel:" + a[1];
  }).join("");
}

// Pure: raw getActivityLog recordMap slices -> [{time, type, authors, changes:[{prop, before, after}]}], newest first.
// users: recordMap.notion_user; schema: {shortKey: propertyName} (optional, an unknown key is reported as is).
// An author absent from users (a bot: integration or automation) stays as its raw id.
export function summarizeHistory({ activity = {}, users = {}, schema = {} } = {}) {
  const names = {};
  for (const [id, r] of Object.entries(users)) { const u = rec(r); if (u && u.name) names[id] = u.name; }
  const out = [];
  for (const r of Object.values(activity)) {
    const a = rec(r);
    if (!a) continue;
    const authors = [], changes = [];
    for (const e of a.edits || []) {
      for (const au of e.authors || []) {
        const who = names[au.id] || au.id;
        if (!authors.includes(who)) authors.push(who);
      }
      const bv = (side) => (e.block_data && e.block_data[side] && e.block_data[side].block_value && e.block_data[side].block_value.properties) || {};
      const before = bv("before"), after = bv("after");
      for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
        changes.push({ prop: schema[k] || k, before: k in before ? plain(before[k], names) : null, after: k in after ? plain(after[k], names) : null });
      }
    }
    const start = Number(a.start_time || a.end_time) || 0; // Notion sends ms as a string
    out.push({ start, time: new Date(start).toISOString(), type: a.type, authors, changes });
  }
  return out.sort((x, y) => y.start - x.start).map(({ start, ...row }) => row);
}

// Who changed which property of a page or database row, and when. The public API's last_edited_by is
// overwritten by automations, the activity log is not. Read-only.
// Property keys are resolved to names through the parent collection schema when the row has one.
export async function pagePropertyHistory(ctx, { pageId, limit = 50 } = {}) {
  const id = dashUuid(pageId);
  const raw = await run(ctx, `
const id = ${JSON.stringify(id)};
const b = await post("syncRecordValues", {requests: [{pointer: {table: "block", id}, version: -1}]});
const be = err(b); if (be) throw new Error("syncRecordValues failed: " + be);
const br = b.recordMap && b.recordMap.block && b.recordMap.block[id];
const blk = (br && br.value && br.value.value) || (br && br.value) || null;
if (!blk || !blk.space_id) throw new Error("block " + id + " not found or not readable");
const spaceId = blk.space_id;
const log = await post("getActivityLog", {spaceId, navigableBlockId: id, limit: ${Number(limit)}});
const le = err(log); if (le) throw new Error("getActivityLog failed: " + le);
const map = log.recordMap || {};
let schema = {};
if (blk.parent_table === "collection") {
  try { const c = (await getRecs("collection", [blk.parent_id], spaceId))[blk.parent_id]; schema = Object.fromEntries(Object.entries((c && c.schema) || {}).map(([k, s]) => [k, s.name])); } catch (e) { /* names are a bonus */ }
}
return {activity: map.activity || {}, users: map.notion_user || {}, schema};`);
  return summarizeHistory(raw);
}

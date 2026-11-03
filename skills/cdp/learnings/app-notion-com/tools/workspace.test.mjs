// learnings/app-notion-com/tools/workspace.test.mjs
// Fake ctx, no browser: checks the top-level-page permission guard, the unwrap helpers and the page property history parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { saveTransaction, listSpaces, getRecords, unwrap } from "./workspace.mjs";
import { summarizeHistory, pagePropertyHistory } from "./pages.mjs";

// Fake ctx: one app.notion.com tab; Runtime.evaluate records the expression and returns `reply`.
function fakeCtx(reply = {}) {
  const sent = [];
  const ctx = {
    sent,
    session: {
      Target: { getTargets: async () => ({ targetInfos: [{ type: "page", targetId: "T1", url: "https://app.notion.com/x" }] }) },
      use: async () => {},
      Runtime: { evaluate: async ({ expression }) => { sent.push(expression); return { result: { value: reply } }; } },
    },
  };
  return ctx;
}

const topLevel = (extra = {}) => ({
  pointer: { table: "block", id: "b1" }, path: [], command: "set",
  args: { id: "b1", type: "page", parent_id: "s1", parent_table: "space", alive: true, ...extra },
});

test("refuses a top-level set with no permissions, never touches the browser", async () => {
  const ctx = fakeCtx();
  const r = await saveTransaction(ctx, { spaceId: "s1", operations: [topLevel()], label: "t" });
  assert.equal(r.ok, false);
  assert.match(r.error, /permissions/);
  assert.equal(ctx.sent.length, 0);
});

test("refuses an empty permissions array", async () => {
  const ctx = fakeCtx();
  const r = await saveTransaction(ctx, { spaceId: "s1", operations: [topLevel({ permissions: [] })] });
  assert.equal(r.ok, false);
  assert.equal(ctx.sent.length, 0);
});

test("sends a top-level set that carries permissions", async () => {
  const ctx = fakeCtx({});
  const perms = [{ type: "user_permission", role: "editor", user_id: "u1" }];
  const r = await saveTransaction(ctx, { spaceId: "s1", operations: [topLevel({ permissions: perms })], label: "t" });
  assert.deepEqual(r, { ok: true, error: null });
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.sent[0], /saveTransactionsFanout/);
  assert.match(ctx.sent[0], /user_permission/);
});

test("a nested page set (parent_table block) needs no permissions", async () => {
  const ctx = fakeCtx({});
  const op = { pointer: { table: "block", id: "b2" }, path: [], command: "set", args: { id: "b2", type: "page", parent_id: "b1", parent_table: "block" } };
  const r = await saveTransaction(ctx, { spaceId: "s1", operations: [op] });
  assert.equal(r.ok, true);
});

test("a Notion error body becomes {ok:false, error}", async () => {
  const ctx = fakeCtx({ isNotionError: true, debugMessage: "Collection schema updates must use high-level schema operations" });
  const op = { pointer: { table: "block", id: "b2" }, path: ["properties"], command: "update", args: {} };
  const r = await saveTransaction(ctx, { spaceId: "s1", operations: [op] });
  assert.equal(r.ok, false);
  assert.match(r.error, /schema/);
});

test("unwrap handles the double value and the old single value", () => {
  assert.deepEqual(unwrap({ value: { value: { id: "a" }, role: "editor" } }), { id: "a" });
  assert.deepEqual(unwrap({ value: { id: "b" }, role: "editor" }), { id: "b" });
  assert.equal(unwrap(undefined), null);
});

test("listSpaces dedupes spaces across users", async () => {
  const space = { s1: { value: { value: { id: "s1", name: "Dwarves", plan_type: "team" }, role: "editor" } } };
  const ctx = fakeCtx({ u1: { space }, u2: { space } });
  assert.deepEqual(await listSpaces(ctx), [{ id: "s1", name: "Dwarves", plan_type: "team" }]);
});

test("getRecords maps id to the unwrapped value, null when missing", async () => {
  const ctx = fakeCtx({ recordMap: { block: { a: { value: { value: { id: "a" }, role: "editor" } } } } });
  assert.deepEqual(await getRecords(ctx, { table: "block", ids: ["a", "z"], spaceId: "s1" }), { a: { id: "a" }, z: null });
});

const U1 = "11111111-1111-1111-1111-111111111111";
const BOT = "39c64b29-b84c-8183-0000-000000000000";
const PAGE = "40b64b29-b84c-8183-8782-fde586c4f4a6";
const activityFixture = () => ({
  activity: {
    a1: { value: { value: { type: "block-edited", start_time: 1000, edits: [
      { authors: [{ id: U1 }], block_data: { before: { block_value: { properties: { LnUY: [["Draft"]] } } }, after: { block_value: { properties: { LnUY: [["Pending Approval"]] } } } } },
    ] } } },
    a2: { value: { type: "block-edited", start_time: "2000", edits: [
      { authors: [{ id: BOT }], block_data: { before: { block_value: { properties: { LnUY: [["Pending Approval"]], title: [["Same"]] } } }, after: { block_value: { properties: { LnUY: [["Approved"]], title: [["Same"]], dUe8: [["‣", [["d", { start_date: "2026-11-03" }]]]] } } } } },
    ] } },
  },
  users: { [U1]: { value: { value: { id: U1, name: "Han" } } } },
  schema: { LnUY: "Status" },
});

test("summarizeHistory: newest first, names for users, raw id for bots, only changed keys", () => {
  const rows = summarizeHistory(activityFixture());
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { time: "1970-01-01T00:00:02.000Z", type: "block-edited", authors: [BOT],
    changes: [{ prop: "Status", before: "Pending Approval", after: "Approved" }, { prop: "dUe8", before: null, after: "2026-11-03" }] });
  assert.deepEqual(rows[1].authors, ["Han"]);
  assert.deepEqual(rows[1].changes, [{ prop: "Status", before: "Draft", after: "Pending Approval" }]);
});

test("summarizeHistory: empty input gives an empty list", () => {
  assert.deepEqual(summarizeHistory({}), []);
  assert.deepEqual(summarizeHistory(), []);
});

test("pagePropertyHistory pins to the dashed id, calls getActivityLog, summarizes the reply", async () => {
  const ctx = fakeCtx(activityFixture());
  const rows = await pagePropertyHistory(ctx, { pageId: PAGE.replace(/-/g, "") });
  assert.equal(ctx.sent.length, 1);
  assert.match(ctx.sent[0], /getActivityLog/);
  assert.ok(ctx.sent[0].includes(JSON.stringify(PAGE)));
  assert.equal(rows[0].authors[0], BOT);
});

test("pagePropertyHistory rejects a malformed id before touching the browser", async () => {
  const ctx = fakeCtx();
  await assert.rejects(() => pagePropertyHistory(ctx, { pageId: "not-a-uuid" }), /32-hex/);
  assert.equal(ctx.sent.length, 0);
});

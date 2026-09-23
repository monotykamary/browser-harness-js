import assert from "node:assert/strict";
import { test } from "node:test";
import { getEventListeners } from "node:events";
import { runAbortable } from "../abortable.ts";
import { validationMessage } from "../validation.ts";

test("abortable prevents pre-aborted dispatch and cleans up success/failure listeners", async () => {
  let dispatched = false;
  await assert.rejects(runAbortable(AbortSignal.abort("stop"), () => { dispatched = true; }), /stop/);
  assert.equal(dispatched, false);
  for (const failing of [false, true]) {
    const abort = new AbortController();
    const result = runAbortable(abort.signal, () => { if (failing) throw new Error("failed"); return 42; });
    if (failing) await assert.rejects(result, /failed/); else assert.equal(await result, 42);
    assert.deepEqual(getEventListeners(abort.signal, "abort"), []);
  }
});

test("abortable observes late rejection even when the operation synchronously aborts", async () => {
  const abort = new AbortController(); const late = Promise.withResolvers<void>();
  const result = runAbortable(abort.signal, () => { abort.abort("cancelled"); return late.promise; });
  await assert.rejects(result, /cancelled/);
  late.reject(new Error("late")); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(getEventListeners(abort.signal, "abort"), []);
});

test("validation preserves host errors, unexpected-key hints, bounds and fail-closed behavior", () => {
  const schema = { type: "object", properties: { count: { type: "integer", minimum: 1 } }, required: ["count"], additionalProperties: false };
  assert.equal(validationMessage(schema, { count: 1 }), undefined);
  // Host TypeBox versions may use instancePath rather than path; match the source wrapper semantics.
  assert.match(validationMessage(schema, { count: 0, extra: true })!, /must be >= 1/);
  assert.match(validationMessage(schema, { count: 1, extra: true })!, /\/extra: must not have additional properties/);
  assert.ok(validationMessage(schema, { ["x".repeat(3000)]: true })!.length <= 2001);
  const broken = { get count(): number { throw new Error("private"); } };
  assert.equal(validationMessage(schema, broken), "Schema validator failed");
});

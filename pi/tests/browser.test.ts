import path from "node:path";
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import type { FabricInvocationContext } from "pi-fabric/protocol";
import { BrowserHarnessProvider, type BrowserHarnessConfig } from "../browser.ts";
import { browserHarnessComponent } from "../extension.ts";
import { interactionDescriptors, validateInteractionResult, type HarnessInteraction } from "../contract.ts";
import { validationMessage } from "../validation.ts";

const config: BrowserHarnessConfig = {
  modulePath: path.resolve("fixture-session.ts"), wsUrl: "ws://127.0.0.1:9222/devtools/browser/fixture",
  interactionModulePath: path.resolve("fixture-interaction.ts"), allowedOrigins: ["https://fixture.example"],
  allowedMethods: ["Target.attachToTarget", "Runtime.evaluate"],
};
const scope = { sessionId: "authorized-page" };
const observation = () => ({ scope, observationId: "snapshot-1", revision: "state-1", candidates: [{ id: "target-1", label: "Save draft", role: "button", operations: ["click"] }], truncated: false });
const action = () => ({ scope, observationId: "snapshot-1", action: { targetId: "target-1", operation: "click" } });
const context = (signal?: AbortSignal) => ({ cwd: process.cwd(), signal } as FabricInvocationContext);
function setup(overrides: Partial<HarnessInteraction> = {}, options: Partial<BrowserHarnessConfig> = {}) {
  let connected = false;
  const session = {
    connect: mock.fn(async () => { connected = true; }), isConnected: () => connected,
    _call: mock.fn(async (..._args: unknown[]) => ({})), close: mock.fn(() => { connected = false; }),
  };
  const controller = {
    observe: mock.fn(overrides.observe ?? (async () => observation())),
    act: mock.fn(overrides.act ?? (async () => ({ status: "executed" }))),
    waitForChange: mock.fn(overrides.waitForChange ?? (async () => ({ changed: false, observation: observation() }))),
    invalidate: mock.fn(overrides.invalidate ?? (() => {})), close: mock.fn(overrides.close ?? (() => {})),
  };
  const load = mock.fn(async (..._args: unknown[]) => controller);
  const sessionLoader = mock.fn(async (..._args: unknown[]) => session);
  return { session, controller, load, sessionLoader, provider: new BrowserHarnessProvider({ ...config, ...options }, sessionLoader, load) };
}

test("discovery and construction load no SDK modules", async () => {
  const { provider, load, sessionLoader } = setup();
  assert.deepEqual((await provider.list()).map(d => d.name), ["connect", "cdp", "observe", "act", "waitForChange"]);
  await assert.rejects(provider.invoke("observe", { scope }, context()), /connect/);
  assert.equal(load.mock.callCount(), 0); assert.equal(sessionLoader.mock.callCount(), 0);
  const descriptors = await provider.list(); descriptors[0].name = "mutated";
  assert.ok(await provider.describe("connect"));
  await provider.close();
});

test("interaction loading is lazy, origin grants pinned, raw grants separate, close idempotent", async () => {
  const { provider, load, controller, session } = setup();
  try {
    await provider.invoke("connect", {}, context()); assert.equal(load.mock.callCount(), 0);
    assert.deepEqual(session.connect.mock.calls[0].arguments, [{ wsUrl: config.wsUrl, autoAllow: false, timeoutMs: 10000 }]);
    assert.deepEqual(await provider.invoke("observe", { scope }, context()), observation());
    await provider.invoke("act", action(), context());
    await provider.invoke("waitForChange", { scope, revision: "state-1", timeoutMs: 0 }, context());
    assert.equal(load.mock.callCount(), 1);
    assert.deepEqual(load.mock.calls[0].arguments, [config.interactionModulePath, session, { allowedOrigins: config.allowedOrigins }]);
    assert.deepEqual(controller.act.mock.calls[0].arguments[0], action());
    assert.ok(controller.act.mock.calls[0].arguments[1]?.signal instanceof AbortSignal);
    assert.match((await provider.describe("observe"))!.description, /https:\/\/fixture.example/);
    await provider.invoke("cdp", { method: "Runtime.evaluate", sessionId: scope.sessionId }, context());
    assert.equal(controller.invalidate.mock.callCount(), 2);
    assert.ok(Object.isFrozen(provider.config.allowedOrigins));
  } finally { await provider.close(); await provider.close(); }
  assert.equal(controller.close.mock.callCount(), 1); assert.equal(session.close.mock.callCount(), 1);
  await assert.rejects(provider.invoke("connect", {}, context()), /closed/);
});

test("raw CDP can be disabled without disabling guarded actions", async () => {
  const { provider } = setup({}, { allowedMethods: [] });
  assert.equal(await provider.describe("cdp"), undefined); assert.ok(await provider.describe("act"));
  await assert.rejects(provider.invoke("cdp", { method: "Runtime.evaluate" }, context()), /Unknown/);
  await provider.close();
});

test("validates config and inputs without connecting", async () => {
  const validate = (value: Record<string, unknown>) => validationMessage(browserHarnessComponent.configSchema!, value);
  assert.equal(validate({ ...config }), undefined);
  for (const value of [
    { ...config, allowedOrigins: ["*"] }, { ...config, allowedOrigins: [] },
    { ...config, interactionModulePath: undefined }, { ...config, allowedOrigins: undefined },
    { ...config, allowedOrigins: ["https://fixture.example/path"] },
    { ...config, wsUrl: "ws://user:password@localhost:9222" },
    { ...config, allowedMethods: ["Runtime.*"] }, { ...config, callTimeoutMs: 99 },
    { ...config, interactionInput: "fast" },
    { ...config, interactionModulePath: undefined, allowedOrigins: undefined, interactionInput: "trusted" },
  ]) {
    assert.ok(validate(value)); assert.throws(() => new BrowserHarnessProvider(value as BrowserHarnessConfig));
  }
  const { provider, sessionLoader } = setup();
  for (const args of [{ scope: {} }, { scope, maxElements: 129 }, { scope, unknown: true }]) {
    await assert.rejects(provider.invoke("observe", args, context()), /Invalid/);
  }
  await assert.rejects(provider.invoke("act", { ...action(), action: { ...action().action, script: "anything" } }, context()), /Invalid/);
  assert.equal(sessionLoader.mock.callCount(), 0); await provider.close();
});

test("raw-only compatibility still requires exact grants and explicit page session", async () => {
  const { provider, session } = setup({}, { interactionModulePath: undefined, allowedOrigins: undefined });
  try {
    assert.deepEqual((await provider.list()).map(d => d.name), ["connect", "cdp"]);
    await provider.invoke("connect", {}, context());
    await assert.rejects(provider.invoke("cdp", { method: "Runtime.evaluate" }, context()), /explicit sessionId/);
    await assert.rejects(provider.invoke("cdp", { method: "Browser.close" }, context()), /Invalid/);
    await provider.invoke("cdp", { method: "Target.attachToTarget", params: { targetId: "authorized" } }, context());
    assert.equal(session._call.mock.callCount(), 1);
  } finally { await provider.close(); }
});

test("never interleaves raw calls or observations with an in-flight effect", async () => {
  const started = Promise.withResolvers<void>(); const finish = Promise.withResolvers<unknown>();
  const { provider, session } = setup({ act: async () => { started.resolve(); return finish.promise; } });
  try {
    await provider.invoke("connect", {}, context());
    const acting = provider.invoke("act", action(), context()); await started.promise;
    await assert.rejects(provider.invoke("observe", { scope }, context()), /in flight/);
    await assert.rejects(provider.invoke("cdp", { method: "Runtime.evaluate", sessionId: scope.sessionId }, context()), /in flight/);
    assert.equal(session._call.mock.callCount(), 0);
    finish.resolve({ status: "executed" }); assert.deepEqual(await acting, { status: "executed" });
  } finally { finish.resolve({ status: "executed" }); await provider.close(); }
});

test("cancellation reports uncertain effects, closes connection and never retries", async () => {
  const abort = new AbortController(); const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<unknown>(); const closed = Promise.withResolvers<void>();
  const { provider, controller, session } = setup({ act: async () => { started.resolve(); return finish.promise; }, close: () => closed.resolve() });
  await provider.invoke("connect", {}, context());
  const acting = provider.invoke("act", action(), context(abort.signal)); await started.promise;
  abort.abort();
  assert.equal((await acting as { status: string }).status, "outcome_unknown");
  assert.equal(session.isConnected(), false);
  finish.resolve({ status: "executed" }); await closed.promise;
  assert.equal(controller.act.mock.callCount(), 1); assert.equal(controller.close.mock.callCount(), 1);
  await provider.close();
});

test("pre-aborted actions never dispatch; close cancels in-flight effects", async () => {
  const started = Promise.withResolvers<void>(); const finish = Promise.withResolvers<unknown>();
  const { provider, controller } = setup({ act: async () => { started.resolve(); return finish.promise; } });
  await provider.invoke("connect", {}, context());
  await assert.rejects(provider.invoke("act", action(), context(AbortSignal.abort())), /abort/i);
  assert.equal(controller.act.mock.callCount(), 0);
  const acting = provider.invoke("act", action(), context()); await started.promise;
  await provider.close(); assert.equal((await acting as { status: string }).status, "outcome_unknown");
  finish.resolve({ status: "executed" });
  assert.equal(controller.close.mock.callCount(), 1);
});

test("malformed replies cannot expose private payloads or claim effect success", async () => {
  const { provider } = setup({ observe: async () => ({ private: "not an observation" }), act: async () => ({ success: true }) });
  try {
    await provider.invoke("connect", {}, context());
    await assert.rejects(provider.invoke("observe", { scope }, context()), /observation failed/);
    assert.equal((await provider.invoke("act", action(), context()) as { status: string }).status, "outcome_unknown");
  } finally { await provider.close(); }
});

test("rejects observations for a different scope", async () => {
  const { provider } = setup({ observe: async () => ({ ...observation(), scope: { sessionId: "another-page" } }) });
  try {
    await provider.invoke("connect", {}, context());
    await assert.rejects(provider.invoke("observe", { scope }, context()), /observation failed/);
  } finally { await provider.close(); }
});

test("fences late raw dispatch when a guarded operation acquired the scope", async () => {
  const { provider, session } = setup();
  try {
    await provider.invoke("connect", {}, context());
    const results = await Promise.allSettled([
      provider.invoke("cdp", { method: "Runtime.evaluate", sessionId: scope.sessionId }, context()),
      provider.invoke("observe", { scope }, context()),
    ]);
    assert.ok(results.some(result => result.status === "rejected"));
    if (results[1].status === "fulfilled") assert.equal(session._call.mock.callCount(), 0);
  } finally { await provider.close(); }
});

test("deterministic observe/act/verify needs no model or Fabric implementation", async () => {
  let saved = false;
  const { provider } = setup({
    observe: async () => ({ ...observation(), revision: saved ? "saved" : "unsaved", saved }),
    act: async () => { saved = true; return { status: "executed" }; },
  });
  try {
    await provider.invoke("connect", {}, context());
    const before = await provider.invoke("observe", { scope }, context()) as ReturnType<typeof observation>;
    const targets = before.candidates.filter(c => c.label === "Save draft"); assert.equal(targets.length, 1);
    const receipt = await provider.invoke("act", { scope, observationId: before.observationId, action: { targetId: targets[0].id, operation: "click" } }, context()) as { status: string };
    assert.equal(receipt.status, "executed");
    const after = await provider.invoke("observe", { scope }, context()) as { saved: boolean };
    assert.equal(after.saved, true);
  } finally { await provider.close(); }
});

test("contract rejects oversized, malformed, unencodable and duplicate results", () => {
  assert.throws(() => validateInteractionResult("observe", { ...observation(), candidates: [...observation().candidates, ...observation().candidates] }), /Duplicate/);
  assert.throws(() => validateInteractionResult("observe", { ...observation(), extra: "x".repeat(131073) }), /size/);
  assert.throws(() => validateInteractionResult("observe", { ...observation(), extra: 1n }), /encoding/);
  for (const value of [null, [], { status: "success" }]) assert.throws(() => validateInteractionResult("act", value), /contract/);
  for (const status of ["executed", "stale", "blocked", "outcome_unknown"]) assert.deepEqual(validateInteractionResult("act", { status }), { status });
});

test("contract allows read-only context, orders handle-changing reads, separates dispatch from success", () => {
  const value = { ...observation(), candidates: [{ id: "window", role: "AXWindow", label: "Document", operations: [] }] };
  assert.equal(validateInteractionResult("observe", value), value);
  const descriptors = interactionDescriptors("fixture", { type: "object" });
  assert.ok(descriptors.every(d => d.effect?.ordering === "ordered"));
  assert.match(descriptors.find(d => d.name === "act")!.description, /not goal success/);
});

test("interactionInput reaches the controller, and act accepts only bounded select/press payloads", async () => {
  const validate = (value: Record<string, unknown>) => validationMessage(browserHarnessComponent.configSchema!, value);
  assert.equal(validate({ ...config, interactionInput: "trusted" }), undefined);
  const { provider, load } = setup({}, { interactionInput: "trusted" });
  await provider.invoke("connect", {}, context());
  await provider.invoke("observe", { scope }, context());
  assert.deepEqual(load.mock.calls[0]!.arguments[2], { allowedOrigins: ["https://fixture.example"], input: "trusted" });
  const act = (extra: Record<string, unknown>) =>
    provider.invoke("act", { ...action(), action: { ...action().action, ...extra } }, context());
  await act({ operation: "select", option: 2 });
  await act({ operation: "press", key: "ArrowDown" });
  for (const extra of [{ option: 64 }, { option: -1 }, { key: "F12" }, { key: "Enter; rm -rf" }]) {
    await assert.rejects(act(extra), /Invalid/, JSON.stringify(extra));
  }
  const descriptor = (await provider.list()).find(d => d.name === "observe")!;
  const candidate = { id: "t", role: "combobox", label: "Cabin", operations: ["select"], options: ["Economy"], expanded: false, selected: true };
  assert.equal(validationMessage(descriptor.outputSchema as any, { ...observation(), candidates: [candidate] }), undefined);
  await provider.close();
});

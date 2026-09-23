import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, copyFile, rm, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FabricComponentContext, FabricComponentDefinition, FabricComponentDiscovery, FabricComponentRegistration, FabricInvocationContext, FabricProvider } from "pi-fabric/protocol";
import extension, { browserHarnessComponent } from "../extension.ts";
import { state } from "./fixtures/state.ts";

const REGISTER = "pi-fabric:component:register:v1";
const DISCOVER = "pi-fabric:component:discover:v1";
function bus() {
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const events = {
    on(name: string, handler: (value: unknown) => void) {
      const handlers = listeners.get(name) ?? []; handlers.push(handler); listeners.set(name, handlers);
      return () => { const at = handlers.indexOf(handler); if (at >= 0) handlers.splice(at, 1); };
    },
    emit(name: string, payload: unknown) { emitted.push({ name, payload }); for (const handler of listeners.get(name) ?? []) handler(payload); },
  };
  return { events, emitted, api: { events } as ExtensionAPI };
}

test("manifest declares an ordinary optional extension package", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.pi.extensions, ["./extension.ts"]);
  assert.equal(manifest.type, "module"); assert.deepEqual(manifest.keywords, ["pi-package"]);
  for (const name of ["typebox", "@earendil-works/pi-coding-agent", "pi-fabric"]) assert.ok(manifest.peerDependencies[name]);
  assert.equal(manifest.peerDependenciesMeta["pi-fabric"].optional, true);
});

test("cold registration works outside sibling layout with no provider, SDK or runtime peer imports", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "browser-harness-extension-"));
  const target = path.join(dir, "extension.ts");
  await copyFile(new URL("../extension.ts", import.meta.url), target);
  const coldURL = pathToFileURL(await realpath(target)).href;
  const loaded: string[] = [];
  const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === coldURL) {
      loaded.push(specifier);
      assert.equal(specifier, "node:path", "registration must not import provider, SDK, resource modules or runtime peers");
    }
    return nextResolve(specifier, context);
  } });
  try {
    const cold = await import(coldURL);
    const host = bus();
    assert.equal(cold.default(host.api), undefined, "factory is synchronous");
    assert.deepEqual(loaded, ["node:path"]);
    assert.equal(host.emitted.length, 1); assert.equal(host.emitted[0].name, REGISTER);
    assert.equal((host.emitted[0].payload as { version: number }).version, 1);
    assert.equal(cold.browserHarnessComponent.name, "browser-harness");
    assert.deepEqual(cold.browserHarnessComponent.provides, ["browser"]);
  } finally { hooks.deregister(); await rm(dir, { recursive: true, force: true }); }
});

// Model the public catalog's collision rule, including identical definition objects.
function catalog() {
  const definitions = new Map<string, { component: FabricComponentDefinition; revision: number }>();
  const register = (component: FabricComponentDefinition, options: { overwrite?: boolean } = {}) => {
    const previous = definitions.get(component.name);
    if (previous && !options.overwrite) throw new Error(`Component already registered: ${component.name}`);
    definitions.set(component.name, { component, revision: (previous?.revision ?? 0) + 1 });
  };
  const discovery: FabricComponentDiscovery = { version: 1, register };
  return { definitions, register, discovery };
}

test("Fabric-first eager registration and repeated discovery share a collision-aware catalog", () => {
  const host = bus(); const runtime = catalog();
  host.events.on(REGISTER, payload => {
    const registration = payload as FabricComponentRegistration;
    assert.equal(registration.version, 1); assert.equal(registration.overwrite, true);
    // Fabric captures the eager definition and seeds the runtime before DISCOVER.
    runtime.register(registration.component, { overwrite: registration.overwrite });
  });
  assert.equal(extension(host.api), undefined);
  assert.equal(runtime.definitions.get("browser-harness")?.revision, 1);
  assert.throws(() => runtime.register(browserHarnessComponent), /already registered/);
  host.events.emit(DISCOVER, runtime.discovery);
  host.events.emit(DISCOVER, runtime.discovery);
  assert.deepEqual(runtime.definitions.get("browser-harness"), { component: browserHarnessComponent, revision: 3 });
});

test("extension-first discovery overwrites on rediscovery and ignores malformed payloads", () => {
  const host = bus(); extension(host.api); const runtime = catalog();
  for (const payload of [null, [], {}, { version: 2, register() { assert.fail("wrong version"); } }, { version: 1, register: true }]) host.events.emit(DISCOVER, payload);
  assert.equal(runtime.definitions.size, 0);
  host.events.emit(DISCOVER, runtime.discovery);
  assert.throws(() => runtime.register(browserHarnessComponent), /already registered/);
  host.events.emit(DISCOVER, runtime.discovery);
  assert.deepEqual(runtime.definitions.get("browser-harness"), { component: browserHarnessComponent, revision: 2 });
});

const invocation = { cwd: fileURLToPath(new URL("fixtures/", import.meta.url)), signal: undefined } as FabricInvocationContext;
const config = {
  modulePath: "session.ts", interactionModulePath: "interaction.ts", wsUrl: "ws://fixture.invalid/debugging",
  allowedOrigins: ["https://fixture.example"], allowedMethods: [],
};

test("discovered definition activates lazily, resolves explicit config, connects only on request, and closes", async () => {
  const host = bus(); extension(host.api);
  let definition: typeof browserHarnessComponent | undefined;
  host.events.emit(DISCOVER, { version: 1, register(value: typeof browserHarnessComponent) { definition = value; } });
  assert.ok(definition); assert.deepEqual(definition.configSchema?.required, ["modulePath", "wsUrl", "allowedMethods"]);
  let provider: FabricProvider | undefined;
  const context = { invocation, provide(value: FabricProvider) { provider = value; } } as unknown as FabricComponentContext;
  await definition.activate(context, config); assert.ok(provider);
  assert.deepEqual(state, { sessionImports: 0, interactionImports: 0, connects: 0, sessionCloses: 0, interactionCloses: 0, options: undefined, origins: undefined });
  assert.deepEqual((await provider.list({}, invocation)).map(d => d.name), ["connect", "observe", "act", "waitForChange"]);
  assert.ok(await provider.describe("observe", invocation)); assert.equal(state.sessionImports, 0);
  await assert.rejects(provider.invoke("observe", { scope: { sessionId: "page" } }, invocation), /connect/);
  try {
    assert.deepEqual(await provider.invoke("connect", {}, invocation), { connected: true });
    assert.equal(state.sessionImports, 1); assert.equal(state.interactionImports, 0); assert.equal(state.connects, 1);
    assert.deepEqual(state.options, { wsUrl: config.wsUrl, autoAllow: false, timeoutMs: 10000 });
    const observed = await provider.invoke("observe", { scope: { sessionId: "page" } }, invocation) as { scope: unknown };
    assert.deepEqual(observed.scope, { sessionId: "page" });
    assert.equal(state.interactionImports, 1); assert.deepEqual(state.origins, config.allowedOrigins);
  } finally { await provider.close?.(); await provider.close?.(); }
  assert.equal(state.sessionCloses, 1); assert.equal(state.interactionCloses, 1);
});

test("activation without connect closes cleanly and failed provision closes the orphan", async () => {
  for (const fail of [false, true]) {
    let provider: FabricProvider | undefined;
    const before = { ...state };
    const context = { invocation, provide(value: FabricProvider) { provider = value; if (fail) throw new Error("rejected lease"); } } as unknown as FabricComponentContext;
    const activating = browserHarnessComponent.activate(context, config);
    if (fail) await assert.rejects(Promise.resolve(activating), /rejected lease/); else { await activating; await provider!.close?.(); }
    assert.ok(provider); await assert.rejects(provider.invoke("connect", {}, invocation), /closed/);
    assert.deepEqual(state, before);
  }
});

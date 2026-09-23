import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FabricComponentDefinition, FabricComponentDiscovery, FabricComponentRegistration } from "pi-fabric/protocol";
import type { BrowserHarnessConfig } from "./browser.ts";

// Protocol strings are intentional: Fabric is an optional type-only peer.
const REGISTER = "pi-fabric:component:register:v1";
const DISCOVER = "pi-fabric:component:discover:v1";

export const browserHarnessComponent: FabricComponentDefinition<BrowserHarnessConfig> = {
  name: "browser-harness",
  description: "Model-neutral Browser Harness connector; explicit endpoint, optional guarded origins and separate raw CDP grants",
  configSchema: {
    type: "object",
    properties: {
      modulePath: { type: "string", minLength: 1, description: "Trusted host module exporting Session; relative to invocation cwd." },
      wsUrl: { type: "string", pattern: "^wss?://[^/?#@\\s]+(?:[/?#][^\\s]*)?$", description: "Explicit debugging URL without credentials; no discovery or prompt approval." },
      allowedMethods: { type: "array", minItems: 0, maxItems: 128, items: { type: "string", pattern: "^[A-Z][A-Za-z0-9]+\\.[a-z][A-Za-z0-9]+$" }, description: "Raw CDP grants, not origin restrictions. [] disables the raw action when guarded interactions are configured." },
      interactionModulePath: { type: "string", minLength: 1, description: "Trusted host module exporting InteractionController; relative to invocation cwd. Optional, requires allowedOrigins." },
      allowedOrigins: { type: "array", minItems: 1, maxItems: 32, items: { type: "string", minLength: 1, maxLength: 2048, pattern: "^https?://[^/?#@\\s]+$" }, description: "Exact http/https origins for guarded interactions only. No wildcards." },
      callTimeoutMs: { type: "integer", minimum: 100, maximum: 60000, description: "Overall per-call bound, including waitForChange; default 10000ms. Cancellation does not roll back effects." },
    },
    required: ["modulePath", "wsUrl", "allowedMethods"],
    anyOf: [
      { type: "object", required: ["interactionModulePath", "allowedOrigins"], properties: { interactionModulePath: { type: "string" }, allowedOrigins: { type: "array" } } },
      { type: "object", properties: { allowedMethods: { type: "array", minItems: 1 }, interactionModulePath: false, allowedOrigins: false } },
    ],
    additionalProperties: false,
  },
  provides: ["browser"], guarantee: "managed",
  async activate(context, config) {
    const { BrowserHarnessProvider } = await import("./browser.ts");
    const provider = new BrowserHarnessProvider({ ...config, modulePath: path.resolve(context.invocation.cwd, config.modulePath), ...(config.interactionModulePath ? { interactionModulePath: path.resolve(context.invocation.cwd, config.interactionModulePath) } : {}) });
    try { context.provide(provider); } catch (error) { void provider.close(); throw error; }
  },
};

/** Definition-only registration. No SDK, process, connection or permission acquisition. */
export default function browserHarnessExtension(pi: ExtensionAPI): void {
  // Subscribe first: covers Fabric loading after this extension, including rediscovery.
  pi.events.on(DISCOVER, (payload: unknown) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
    const discovery = payload as Partial<FabricComponentDiscovery>;
    if (discovery.version === 1 && typeof discovery.register === "function") {
      discovery.register(browserHarnessComponent, { overwrite: true });
    }
  });
  // Fabric seeds eager registrations before discovery; even identical definitions
  // require overwrite, as does the ordinary extension reload/HMR boundary.
  const registration: FabricComponentRegistration = { version: 1, component: browserHarnessComponent, overwrite: true };
  pi.events.emit(REGISTER, registration);
}

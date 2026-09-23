import path from "node:path";
import { pathToFileURL } from "node:url";
import { runAbortable } from "./abortable.ts";
import { validationMessage } from "./validation.ts";
import type { FabricActionDescriptor, FabricInvocationContext, FabricProvider } from "pi-fabric/protocol";
import { interactionDescriptors, validateInteractionResult, type HarnessInteraction } from "./contract.ts";

export interface BrowserHarnessConfig {
  /** Trusted Browser Harness SDK session.ts module. */
  modulePath: string;
  /** Explicit endpoint; never discover or approve a personal browser. */
  wsUrl: string;
  /** Raw escape-hatch grants; [] exposes only the guarded interface. */
  allowedMethods: string[];
  /** Trusted SDK interaction.ts module; requires exact allowedOrigins. */
  interactionModulePath?: string;
  allowedOrigins?: string[];
  callTimeoutMs?: number;
}
export interface BrowserHarnessSession {
  connect(options: { wsUrl: string; autoAllow: false; timeoutMs: number }): Promise<void>;
  isConnected(): boolean;
  _call(method: string, params: unknown, options?: { sessionId?: string; expectedGeneration?: number }): Promise<unknown>;
  getConnectionGeneration?(): number;
  close(): void;
}
export type BrowserHarnessSessionLoader = (modulePath: string) => Promise<BrowserHarnessSession>;
export type BrowserHarnessInteractionLoader = (modulePath: string, session: BrowserHarnessSession, options: { allowedOrigins: string[] }) => Promise<HarnessInteraction>;
const loadSession: BrowserHarnessSessionLoader = async modulePath => {
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.Session !== "function") throw new Error("Browser Harness module must export Session");
  return new module.Session() as BrowserHarnessSession;
};
const loadInteraction: BrowserHarnessInteractionLoader = async (modulePath, session, options) => {
  if (typeof session.getConnectionGeneration !== "function") throw new Error("Guarded interactions require a generation-fenced Browser Harness SDK; upgrade the Session module");
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.InteractionController !== "function") throw new Error("Browser Harness module must export InteractionController");
  const controller = new module.InteractionController(session, options) as HarnessInteraction;
  if (![controller.observe, controller.act, controller.waitForChange, controller.invalidate, controller.close].every(method => typeof method === "function")) {
    await controller.close?.();
    throw new Error("Incompatible Browser Harness interaction module");
  }
  return controller;
};

export class BrowserHarnessProvider implements FabricProvider {
  readonly name = "browser";
  readonly description = "Model-neutral Browser Harness: guarded UI interactions and explicitly granted raw CDP";
  readonly config: BrowserHarnessConfig;
  readonly #descriptors: FabricActionDescriptor[];
  readonly #timeoutMs: number;
  readonly #shutdown = new AbortController();
  #session: Promise<BrowserHarnessSession> | undefined;
  #interaction: Promise<HarnessInteraction> | undefined;
  #closed = false;
  #interactionBusy = false;
  #pending = new Set<Promise<unknown>>();

  private readonly loader: BrowserHarnessSessionLoader;
  private readonly interactionLoader: BrowserHarnessInteractionLoader;

  constructor(config: BrowserHarnessConfig, loader: BrowserHarnessSessionLoader = loadSession, interactionLoader: BrowserHarnessInteractionLoader = loadInteraction) {
    this.loader = loader;
    this.interactionLoader = interactionLoader;
    if (!config || typeof config.modulePath !== "string" || !path.isAbsolute(config.modulePath)) throw new Error("Browser Harness modulePath must be an absolute trusted path");
    const url = new URL(config.wsUrl);
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser Harness needs an explicit ws/wss debugging URL without credentials");
    if (!Array.isArray(config.allowedMethods) || config.allowedMethods.length > 128 ||
        !config.allowedMethods.every(m => typeof m === "string" && /^[A-Z][A-Za-z0-9]+\.[a-z][A-Za-z0-9]+$/.test(m))) throw new Error("Browser Harness needs up to 128 exact allowedMethods");
    if (config.interactionModulePath !== undefined) {
      if (!path.isAbsolute(config.interactionModulePath)) throw new Error("Browser Harness interactionModulePath must be absolute");
      if (!Array.isArray(config.allowedOrigins) || !config.allowedOrigins.length || config.allowedOrigins.length > 32 || !config.allowedOrigins.every(origin => {
        try { const value = new URL(origin); return origin.length <= 2048 && ["http:", "https:"].includes(value.protocol) && value.origin === origin && !value.username && !value.password; } catch { return false; }
      })) throw new Error("Guarded Browser Harness requires 1–32 exact http/https allowedOrigins");
    } else if (config.allowedOrigins !== undefined || config.allowedMethods.length === 0) {
      throw new Error("Guarded Browser Harness needs interactionModulePath and allowedOrigins together");
    }
    if (config.callTimeoutMs !== undefined && (!Number.isInteger(config.callTimeoutMs) || config.callTimeoutMs < 100 || config.callTimeoutMs > 60000)) throw new Error("Invalid Browser Harness callTimeoutMs");
    this.config = Object.freeze({ ...config, allowedMethods: Object.freeze([...config.allowedMethods]) as unknown as string[], ...(config.allowedOrigins ? { allowedOrigins: Object.freeze([...config.allowedOrigins]) as unknown as string[] } : {}) });
    this.#timeoutMs = config.callTimeoutMs ?? 10000;
    this.#descriptors = [
      { name: "connect", description: "Connect to the configured debugging endpoint. No browser discovery or prompt approval. Does not attach a target or verify task success.", inputSchema: { type: "object", properties: {}, additionalProperties: false }, risk: "execute" },
      ...(config.allowedMethods.length ? [{
        name: "cdp", description: "Call one explicitly granted raw CDP method. Always execute risk, including Runtime.evaluate. Explicit sessionId for page calls. Invalidates guarded observations; not an approval bypass. Cannot undo a sent command.", risk: "execute" as const,
        inputSchema: { type: "object", properties: { method: { type: "string", enum: [...new Set(config.allowedMethods)] }, params: { type: "object" }, sessionId: { type: "string", minLength: 1, maxLength: 256 } }, required: ["method"], additionalProperties: false },
      }] : []),
      ...(config.interactionModulePath ? interactionDescriptors("browser", {
        type: "object", properties: { sessionId: { type: "string", minLength: 1, maxLength: 256 } }, required: ["sessionId"], additionalProperties: false,
      }, `Guarded origin grant: ${JSON.stringify(config.allowedOrigins)}. Raw CDP grants are separate and not origin-limited.`) : []),
    ];
  }
  async list() { return structuredClone(this.#descriptors); }
  async describe(name: string) { return structuredClone(this.#descriptors.find(descriptor => descriptor.name === name)); }
  #track<T>(task: Promise<T>): Promise<T> {
    this.#pending.add(task);
    void task.then(() => this.#pending.delete(task), () => this.#pending.delete(task));
    return task;
  }
  async #retireInteraction(): Promise<void> {
    const old = this.#interaction;
    this.#interaction = undefined;
    const controller = await old?.catch(() => undefined);
    await controller?.close();
  }
  async invoke(name: string, args: Record<string, unknown>, context: FabricInvocationContext): Promise<unknown> {
    if (this.#closed) throw new Error("Browser Harness provider closed");
    const descriptor = await this.describe(name);
    if (!descriptor) throw new Error("Unknown Browser Harness action");
    const invalid = validationMessage(descriptor.inputSchema, args);
    if (invalid) throw new Error(`Invalid browser.${name} arguments: ${invalid}`);
    context.signal?.throwIfAborted();
    if (this.#pending.size >= 16) throw new Error("Browser Harness outstanding call limit reached");
    const signal = AbortSignal.any([this.#shutdown.signal, ...(context.signal ? [context.signal] : []), AbortSignal.timeout(this.#timeoutMs)]);
    if (name === "connect") {
      if (this.#interactionBusy || this.#pending.size) throw new Error("Browser Harness busy; wait for pending calls before reconnecting");
      this.#session ??= this.loader(this.config.modulePath).then(session => {
        if (this.#closed) { session.close(); throw new Error("Browser Harness provider closed"); }
        return session;
      }).catch(error => { this.#session = undefined; throw error; });
      const session = await runAbortable(signal, () => this.#session!);
      if (!session.isConnected()) await this.#retireInteraction();
      const connecting = session.connect({ wsUrl: this.config.wsUrl, autoAllow: false, timeoutMs: this.#timeoutMs }).then(() => {
        if (this.#closed || signal.aborted) session.close();
      });
      await runAbortable(signal, () => this.#track(connecting));
      if (this.#closed || signal.aborted) { session.close(); signal.throwIfAborted(); throw new Error("Browser Harness provider closed"); }
      return { connected: session.isConnected() };
    }
    if (!this.#session) throw new Error("Call browser.connect before browser actions");
    if (this.#interactionBusy) throw new Error("Browser Harness interaction in flight; do not interleave raw or guarded operations");
    if (name !== "cdp") {
      if (this.#pending.size) throw new Error("Browser Harness raw calls in flight; wait before observing or acting");
      this.#interactionBusy = true;
    }
    try {
      const session = await runAbortable(signal, () => this.#session!);
      if (this.#closed || !session.isConnected()) throw new Error("Browser Harness disconnected; explicitly reconnect and re-observe");
      if (name === "cdp") {
        const method = args.method as string;
        if (!/^(Browser|Target|Chrome)\./.test(method) && typeof args.sessionId !== "string") throw new Error("Page-scoped CDP calls require an explicit sessionId");
        const controller = await this.#interaction;
        controller?.invalidate?.();
        if (this.#interactionBusy) throw new Error("Browser Harness interaction in flight; wait before raw CDP");
        signal.throwIfAborted();
        try {
          return await runAbortable(signal, () => this.#track(session._call(method, args.params ?? {}, typeof args.sessionId === "string" ? { sessionId: args.sessionId } : undefined)));
        } finally { controller?.invalidate?.(); }
      }
      this.#interaction ??= this.interactionLoader(this.config.interactionModulePath!, session, { allowedOrigins: [...this.config.allowedOrigins!] }).then(async controller => {
        if (this.#closed) { await controller.close(); throw new Error("Browser Harness provider closed"); }
        return controller;
      }).catch(error => { this.#interaction = undefined; throw error; });
      const controller = await runAbortable(signal, () => this.#interaction!);
      signal.throwIfAborted();
      const action = name as "observe" | "act" | "waitForChange";
      try {
        const result = await runAbortable(signal, () => this.#track(controller[action](args, { signal })));
        const validated = validateInteractionResult(name, result);
        const observation = name === "observe" ? validated : name === "waitForChange" ? (validated as { observation: unknown }).observation : undefined;
        if (observation && (observation as { scope?: { sessionId?: unknown } }).scope?.sessionId !== (args.scope as { sessionId: string }).sessionId) throw new Error("Browser Harness scope mismatch");
        return validated;
      } catch {
        // A failed action response can follow an already-issued effect. Never replay it.
        controller.invalidate?.();
        if (signal.aborted) {
          session.close();
          void this.#retireInteraction().catch(() => undefined);
        }
        if (name === "act") return { status: "outcome_unknown", reason: "Action response unavailable or invalid. Inspect fresh state before any further effect; cancellation is not rollback." };
        throw new Error("Browser Harness observation failed or was cancelled; reconnect if disconnected and re-observe");
      }
    } finally {
      if (name !== "cdp") this.#interactionBusy = false;
    }
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#shutdown.abort();
    const session = await this.#session?.catch(() => undefined);
    session?.close();
    await this.#retireInteraction();
  }
}

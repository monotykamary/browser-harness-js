import { state } from "./state.ts";
state.interactionImports++;
export class InteractionController {
  constructor(_session: unknown, options: { allowedOrigins: string[] }) { state.origins = options.allowedOrigins; }
  async observe(args: { scope: unknown }) { return { scope: args.scope, observationId: "seen", revision: "revision", candidates: [] }; }
  async act() { return { status: "blocked" }; }
  async waitForChange(args: { scope: unknown }) { return { changed: false, observation: await this.observe(args) }; }
  invalidate() {}
  close() { state.interactionCloses++; }
}

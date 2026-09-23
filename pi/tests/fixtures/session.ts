import { state } from "./state.ts";
state.sessionImports++;
export class Session {
  connected = false;
  async connect(options: unknown) { state.connects++; state.options = options; this.connected = true; }
  isConnected() { return this.connected; }
  getConnectionGeneration() { return 1; }
  async _call() { return {}; }
  close() { state.sessionCloses++; this.connected = false; }
}

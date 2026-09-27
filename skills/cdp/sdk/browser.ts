import { Session, listPageTargets, type ConnectOptions } from './session.ts';
import { Page, type PageOptions } from './page.ts';
export { Page, Locator } from './page.ts';
export type { PageOptions, CallOptions, ActionOptions, ActionResult, RoleOptions, PageSnapshot, SnapshotOptions } from './page.ts';
export type BrowserPageOptions = Omit<PageOptions, 'sessionId' | 'targetId' | 'ownsAttachment'>;

/** Browser ownership and tab lifecycle; page work always uses a pinned attachment. */
export class Browser {
  readonly session: Session;
  private readonly pages = new Set<Page>();
  private pending = 0;
  constructor(session = new Session()) { this.session = session; }
  async connect(options: ConnectOptions = {}): Promise<void> {
    await this.session.connect({ ...options, autoAllow: options.autoAllow ?? false });
  }
  tabs() { return listPageTargets(this.session); }
  private reserve(options: BrowserPageOptions): void {
    if (!this.session.isConnected()) throw new Error('Connect the browser first');
    // Validate policy before acquiring a browser attachment or creating a tab.
    const probe = new Page(this.session, { ...options, sessionId: 'validation-only', ownsAttachment: false });
    probe.dispose();
    for (const page of this.pages) if (page.disposed) this.pages.delete(page);
    if (this.pages.size + this.pending >= 32) throw new Error('Browser page capacity exceeded; dispose unused pages');
    this.pending++;
  }
  private async attached(targetId: string, options: BrowserPageOptions, generation: number): Promise<Page> {
    const { sessionId } = await this.session._call('Target.attachToTarget', { targetId, flatten: true }, { expectedGeneration: generation }) as { sessionId: string };
    let page: Page | undefined;
    try {
      if (!this.session.isConnected() || this.session.getConnectionGeneration() !== generation) throw new Error('Browser disconnected; attach again');
      page = new Page(this.session, { ...options, sessionId, targetId, ownsAttachment: true });
      await page.cdp('Page.enable', {});
      this.pages.add(page);
      return page;
    } catch (error) {
      if (page) page.dispose();
      else await this.session._call('Target.detachFromTarget', { sessionId }, { expectedGeneration: generation }).catch(() => {});
      throw error;
    }
  }
  async attach(targetId: string, options: BrowserPageOptions): Promise<Page> {
    options = { ...options, allowedOrigins: [...options.allowedOrigins] };
    if (!targetId || targetId.length > 256) throw new Error('An explicit targetId is required');
    this.reserve(options);
    try { return await this.attached(targetId, options, this.session.getConnectionGeneration()); }
    finally { this.pending--; }
  }
  async open(url: string, options: BrowserPageOptions): Promise<Page> {
    options = { ...options, allowedOrigins: [...options.allowedOrigins] };
    const destination = new URL(url);
    if (!options.allowedOrigins.includes(destination.origin) || !['http:', 'https:'].includes(destination.protocol)) throw new Error('origin_denied');
    this.reserve(options);
    const generation = this.session.getConnectionGeneration();
    let targetId: string | undefined, page: Page | undefined;
    try {
      ({ targetId } = await this.session._call('Target.createTarget', { url: 'about:blank', background: true }, { expectedGeneration: generation }) as { targetId: string });
      page = await this.attached(targetId, options, generation);
      const result = await page.goto(url);
      if (result.status !== 'executed' || result.verificationError?.includes('origin_denied')) {
        throw new Error(`Navigation ${result.status}: ${result.verificationError ?? result.reason}`);
      }
      return page;
    } catch (error) {
      page?.dispose();
      if (targetId) await this.session._call('Target.closeTarget', { targetId }, { expectedGeneration: generation }).catch(() => {});
      throw error;
    } finally { this.pending--; }
  }
  /** Dispose owned page wrappers and disconnect; does not close user tabs. */
  disconnect(): void {
    for (const page of this.pages) page.dispose();
    this.pages.clear(); this.session.close();
  }
}

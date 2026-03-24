import { chromium, Browser, BrowserContext, Page } from 'playwright';
import type { BrowserConfig, SiteMap } from './types';

/**
 * Manages a single Chromium browser instance and issues isolated contexts
 * (separate cookie jars / localStorage) per agent.
 *
 * Network sandboxing: blocks all external hostnames so agents only interact
 * with the target site. Allowed origins are derived from the SiteMap.
 */
export class BrowserPool {
  private browser: Browser | null = null;
  private config: BrowserConfig;
  private allowedHosts: string[] = ['localhost', '127.0.0.1'];
  private allowedOrigins: Set<string> | null = null;

  constructor(config: BrowserConfig) {
    this.config = config;
  }

  async init(siteMap?: SiteMap): Promise<void> {
    if (siteMap) {
      this.allowedOrigins = new Set<string>();
      for (const origin of siteMap.allowedOrigins) {
        try {
          const u = new URL(origin);
          this.allowedOrigins.add(u.origin);
          if (!this.allowedHosts.includes(u.hostname)) {
            this.allowedHosts.push(u.hostname);
          }
        } catch {
          // ignore unparseable origins
        }
      }
    }

    // Build host-resolver rules to sandbox network access.
    // Rules are evaluated in order — explicitly map allowed hostnames to 127.0.0.1
    // first, then block everything else. IPs don't go through DNS so we skip them.
    const hostnameRules = this.allowedHosts
      .filter(h => !/^\d+\.\d+\.\d+\.\d+$/.test(h))
      .map(h => `MAP ${h} 127.0.0.1`)
      .join('; ');
    const hostResolverRules = hostnameRules
      ? `${hostnameRules}; MAP * ~NOTFOUND`
      : 'MAP * ~NOTFOUND';

    const defaultArgs = [`--host-resolver-rules=${hostResolverRules}`];
    const extraArgs = this.config.extraArgs ?? [];

    this.browser = await chromium.launch({
      headless: this.config.headless,
      args: [...defaultArgs, ...extraArgs],
    });
  }

  /**
   * Create an isolated browser context + page for one agent.
   * Each agent gets its own cookies and session storage.
   *
   * When a siteMap was provided to init(), a route interceptor blocks all
   * network requests (fetch, XHR, WebSocket, navigation) to origins not in
   * the allowed list — agents cannot reach other localhost ports or the internet.
   */
  async acquirePage(): Promise<{ page: Page; context: BrowserContext }> {
    if (!this.browser) {
      throw new Error('BrowserPool not initialized — call init() first');
    }

    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    context.setDefaultTimeout(this.config.timeoutMs);
    context.setDefaultNavigationTimeout(this.config.timeoutMs);

    // Enforce origin allowlist at the network level.
    // This catches fetch/XHR/WebSocket in addition to navigations, so even
    // XSS payloads or sneaky agent prompts can't phone home or probe other ports.
    if (this.allowedOrigins) {
      const allowed = this.allowedOrigins;
      await context.route('**/*', (route) => {
        const url = route.request().url();
        try {
          const { origin, protocol } = new URL(url);
          // Always allow non-HTTP schemes (data:, blob:, chrome-extension:, etc.)
          if (!protocol.startsWith('http')) {
            route.continue();
            return;
          }
          if (allowed.has(origin)) {
            route.continue();
          } else {
            route.abort('blockedbyclient');
          }
        } catch {
          route.continue();
        }
      });
    }

    const page = await context.newPage();
    return { page, context };
  }

  /** Close a context and its page(s) when an agent is done. */
  async releasePage(context: BrowserContext): Promise<void> {
    await context.close().catch(() => {});
  }

  async close(): Promise<void> {
    await this.browser?.close().catch(() => {});
    this.browser = null;
  }
}

import type { BrowserContext, Page } from 'playwright';
import type { OllamaClient } from '../core/llm';
import type { TeamChannel, SystemChannel } from '../core/channel';
import type { Reporter } from '../core/reporter';
import type { RepoReader } from '../core/repo-reader';
import type {
  Finding,
  SiteMap,
  SystemMessage,
  Team,
  AgentStatus,
} from '../core/types';
import { SystemEvent } from '../core/types';

export interface AgentDeps {
  id: string;
  team: Team;
  llm: OllamaClient;
  teamChannel: TeamChannel;
  systemChannel: SystemChannel;
  reporter: Reporter;
  repoReader: RepoReader;
  siteMap: SiteMap;
  page: Page;
  context: BrowserContext;
}

/**
 * Abstract base class shared by all agents (QA workers, Red Team workers, coordinators, DevOps).
 *
 * Provides:
 *  - Browser navigation + page reading (DOM text + accessibility snapshot)
 *  - Screenshot capture + vision LLM analysis
 *  - Text LLM prompting
 *  - Team channel messaging
 *  - Report filing
 *  - Read-only repo access
 *  - Pause/resume in response to system (watchdog) events
 */
export abstract class BaseAgent {
  readonly id: string;
  readonly team: Team;

  protected llm: OllamaClient;
  protected teamChannel: TeamChannel;
  protected systemChannel: SystemChannel;
  protected reporter: Reporter;
  protected repoReader: RepoReader;
  protected siteMap: SiteMap;
  protected page: Page;
  protected context: BrowserContext;

  protected status: AgentStatus = 'idle' as AgentStatus;
  private pausePromise: Promise<void> | null = null;
  private pauseResolve: (() => void) | null = null;
  private unsubscribeSystem: (() => void) | null = null;

  constructor(deps: AgentDeps) {
    this.id = deps.id;
    this.team = deps.team;
    this.llm = deps.llm;
    this.teamChannel = deps.teamChannel;
    this.systemChannel = deps.systemChannel;
    this.reporter = deps.reporter;
    this.repoReader = deps.repoReader;
    this.siteMap = deps.siteMap;
    this.page = deps.page;
    this.context = deps.context;
  }

  /** Subclasses implement their core behavior loop here. */
  abstract run(): Promise<void>;

  // ─── Browser ────────────────────────────────────────────────────────────────

  protected async navigate(url: string): Promise<boolean> {
    if (!this.isAllowedUrl(url)) {
      this.log(`Blocked navigation to disallowed URL: ${url}`);
      return false;
    }
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded' });
      return true;
    } catch (err) {
      this.log(`Navigation failed to ${url}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Returns visible text + basic accessibility info from the current page. */
  protected async readPage(): Promise<string> {
    try {
      const text = await this.page.evaluate(() => {
        // Remove script/style noise
        const clone = document.cloneNode(true) as Document;
        clone.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
        return (clone.body?.innerText ?? '') || (clone.body?.textContent ?? '');
      });

      const title = await this.page.title().catch(() => '');
      const url = this.page.url();
      return `URL: ${url}\nTitle: ${title}\n\n${text.trim().slice(0, 8000)}`;
    } catch (err) {
      return `Failed to read page: ${(err as Error).message}`;
    }
  }

  /** Captures a full-page screenshot and returns it as a base64 PNG string. */
  protected async screenshot(): Promise<string> {
    const buf = await this.page.screenshot({ fullPage: true, type: 'png' });
    return buf.toString('base64');
  }

  /** Take a screenshot and describe it using the vision LLM. */
  protected async analyzePageVisually(prompt: string): Promise<string> {
    const img = await this.screenshot();
    return this.llm.vision(img, prompt);
  }

  /** Get all visible links on the current page that stay within allowed origins. */
  protected async getPageLinks(): Promise<string[]> {
    const hrefs = await this.page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(
        (a) => (a as HTMLAnchorElement).href
      )
    );
    return hrefs.filter((h) => this.isAllowedUrl(h));
  }

  // ─── LLM ────────────────────────────────────────────────────────────────────

  protected async askLLM(prompt: string, system?: string): Promise<string> {
    return this.llm.complete(prompt, { system });
  }

  protected async askVision(imageBase64: string, prompt: string): Promise<string> {
    return this.llm.vision(imageBase64, prompt);
  }

  // ─── Team Communication ──────────────────────────────────────────────────────

  protected sendToTeam(content: string, tags?: string[]): void {
    this.teamChannel.post(this.id, content, tags);
  }

  protected getTeamHistory(limit = 20): string {
    const msgs = this.teamChannel.getHistory(limit);
    if (msgs.length === 0) return '(no messages yet)';
    return msgs.map((m) => `[${m.from}] ${m.content}`).join('\n');
  }

  // ─── Reporting ───────────────────────────────────────────────────────────────

  protected report(finding: Finding): string {
    const filePath = this.reporter.write(finding);
    this.log(`Filed report: ${filePath}`);
    this.sendToTeam(`Filed report: ${finding.type} — ${finding.title} (${finding.severity})`, ['report']);
    return filePath;
  }

  // ─── Pause / Resume (watchdog integration) ──────────────────────────────────

  /** Call this at the top of agent work loops to block when the site is down. */
  protected async checkPaused(): Promise<void> {
    if (this.pausePromise) {
      this.log('Site is down — waiting for recovery...');
      await this.pausePromise;
      this.log('Site recovered — resuming.');
    }
  }

  startListeningToSystem(): void {
    this.unsubscribeSystem = this.systemChannel.subscribe((msg: SystemMessage) => {
      if (msg.event === SystemEvent.SiteDown) {
        this.pause();
      } else if (msg.event === SystemEvent.SiteUp) {
        this.resume(msg.detail);
      }
    });
  }

  stopListeningToSystem(): void {
    this.unsubscribeSystem?.();
    this.unsubscribeSystem = null;
  }

  private pause(): void {
    if (!this.pausePromise) {
      this.pausePromise = new Promise((resolve) => {
        this.pauseResolve = resolve;
      });
    }
    this.status = 'paused' as AgentStatus;
  }

  private resume(detail?: string): void {
    this.pauseResolve?.();
    this.pausePromise = null;
    this.pauseResolve = null;
    this.status = 'running' as AgentStatus;
    if (detail) {
      this.sendToTeam(`[SYSTEM] ${detail}`, ['system']);
    }
  }

  stop(): void {
    this.status = 'stopped' as AgentStatus;
    this.resume(); // unblock if paused
    this.stopListeningToSystem();
  }

  isStopped(): boolean {
    return this.status === ('stopped' as AgentStatus);
  }

  // ─── Utilities ───────────────────────────────────────────────────────────────

  protected isAllowedUrl(url: string): boolean {
    try {
      const { origin, protocol } = new URL(url);
      if (protocol === 'about:' || protocol === 'data:' || protocol === 'blob:') return false;
      return this.siteMap.allowedOrigins.some((allowed) => {
        try {
          return new URL(allowed).origin === origin;
        } catch {
          return false;
        }
      });
    } catch {
      // relative URLs are fine
      return !url.startsWith('http');
    }
  }

  protected log(message: string): void {
    const prefix = `[${new Date().toISOString().slice(11, 19)}][${this.team}/${this.id}]`;
    console.log(`${prefix} ${message}`);
  }
}

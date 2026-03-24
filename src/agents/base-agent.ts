import type { BrowserContext, Page } from 'playwright';
import { randomUUID } from 'crypto';
import type { OllamaClient, RetryUpdate } from '../core/llm';
import type { TeamChannel, SystemChannel } from '../core/channel';
import type { Reporter } from '../core/reporter';
import type { RepoReader } from '../core/repo-reader';
import type {
  ChannelMessage,
  Finding,
  FindingReviewStatus,
  SiteMap,
  SystemMessage,
  Team,
  AgentStatus,
} from '../core/types';
import { SystemEvent } from '../core/types';
import { WebBridge } from '../web/web-bridge';

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
  private privateNotes = new Map<string, string>();
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
    const resolvedUrl = this.resolveUrl(url);
    if (!resolvedUrl || !this.isAllowedUrl(resolvedUrl)) {
      this.log(`Blocked navigation to disallowed URL: ${url}`);
      return false;
    }
    try {
      await this.page.goto(resolvedUrl, { waitUntil: 'domcontentloaded' });
      return true;
    } catch (err) {
      this.log(`Navigation failed to ${resolvedUrl}: ${(err as Error).message}`);
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
    const onRetryUpdate = this.createRetryHandler();
    return this.llm.complete(prompt, {
      system,
      onRetryUpdate,
    });
  }

  protected async askVision(imageBase64: string, prompt: string): Promise<string> {
    const onRetryUpdate = this.createRetryHandler();
    return this.llm.vision(imageBase64, prompt, {
      onRetryUpdate,
    });
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

  protected savePrivateNote(key: string, value: string): void {
    const normalizedKey = key.trim().slice(0, 80);
    const normalizedValue = value.trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!normalizedKey || !normalizedValue) return;
    this.privateNotes.set(normalizedKey, normalizedValue);
    this.log(`Saved private note: ${normalizedKey}`);
  }

  protected getPrivateNotesSummary(): string {
    if (this.privateNotes.size === 0) return '(none)';
    return [...this.privateNotes.entries()]
      .slice(-10)
      .map(([key, value]) => `- ${key}: ${value}`)
      .join('\n');
  }

  // ─── Reporting ───────────────────────────────────────────────────────────────

  protected report(finding: Finding, options?: { announce?: boolean }): string {
    const filePath = this.reporter.write(finding);
    this.log(`Filed report: ${filePath}`);
    if (options?.announce !== false) {
      this.sendToTeam(`Filed report: ${finding.type} — ${finding.title} (${finding.severity})`, ['report']);
    }
    return filePath;
  }

  protected submitFindingDraft(
    finding: Finding,
    options?: { threadId?: string; replyTo?: string; note?: string; tags?: string[] }
  ): ChannelMessage {
    const findingId = options?.threadId ?? randomUUID();
    const content = options?.note
      ?? `Requesting reviewer feedback for ${finding.type} "${finding.title}" (${finding.severity}).`;

    return this.teamChannel.post(
      this.id,
      content,
      options?.tags ?? ['review-request'],
      undefined,
      {
        threadId: findingId,
        replyTo: options?.replyTo,
        finding,
        review: {
          findingId,
          status: 'draft',
        },
      }
    );
  }

  protected postReviewReply(
    threadId: string,
    replyTo: string,
    status: FindingReviewStatus,
    message: string,
    feedback?: string,
  ): ChannelMessage {
    return this.teamChannel.post(
      this.id,
      message,
      [status === 'approved' ? 'review-approved' : status === 'filed' ? 'report' : 'review-feedback'],
      undefined,
      {
        threadId,
        replyTo,
        review: {
          findingId: threadId,
          status,
          reviewerId: this.id,
          feedback,
        },
      }
    );
  }

  protected getThreadMessages(threadId: string): ChannelMessage[] {
    return this.teamChannel
      .getHistory()
      .filter((msg) => msg.threadId === threadId)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  protected async waitForReviewDecision(
    threadId: string,
    afterTimestamp: number,
    timeoutMs = 20_000,
  ): Promise<ChannelMessage | null> {
    const startedAt = Date.now();

    while (!this.isStopped() && Date.now() - startedAt < timeoutMs) {
      await this.checkPaused();
      const decision = this.teamChannel
        .getHistory()
        .find((msg) =>
          msg.threadId === threadId
          && msg.timestamp > afterTimestamp
          && !!msg.review
          && ['approved', 'needs_revision', 'filed'].includes(msg.review.status)
        );

      if (decision) return decision;
      await sleep(1_000);
    }

    return null;
  }

  protected async submitFindingForReview(
    finding: Finding,
    revisePrompt: (currentFinding: Finding, feedback: string) => Promise<Finding>,
  ): Promise<void> {
    const threadId = randomUUID();
    let currentFinding = finding;
    let replyTo: string | undefined;

    for (let attempt = 0; attempt < 3 && !this.isStopped(); attempt++) {
      const draftMessage = this.submitFindingDraft(currentFinding, {
        threadId,
        replyTo,
        note: attempt === 0
          ? `Requesting reviewer feedback for ${finding.type} "${currentFinding.title}" (${currentFinding.severity}).`
          : `Updated draft for reviewer feedback: ${finding.type} "${currentFinding.title}" (${currentFinding.severity}).`,
        tags: attempt === 0 ? ['review-request'] : ['review-request', 'revision'],
      });

      const decision = await this.waitForReviewDecision(threadId, draftMessage.timestamp);
      if (!decision?.review) {
        this.log(`No review decision received for draft ${threadId}; leaving as pending.`);
        return;
      }

      if (decision.review.status === 'approved' || decision.review.status === 'filed') {
        this.log(`Draft ${threadId} approved by ${decision.review.reviewerId ?? 'reviewer'}.`);
        return;
      }

      if (decision.review.status !== 'needs_revision') return;

      const feedback = decision.review.feedback?.trim() || decision.content.trim();
      this.log(`Draft ${threadId} needs revision: ${feedback}`);
      currentFinding = await revisePrompt(currentFinding, feedback);
      replyTo = decision.id;
    }
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

  protected resolveUrl(url: string): string | null {
    const trimmed = url.trim();
    if (!trimmed) return null;

    try {
      return new URL(trimmed, this.siteMap.entryUrl).toString();
    } catch {
      return null;
    }
  }

  protected sendImageToTeam(imageBase64: string, caption: string, tags?: string[]): void {
    this.teamChannel.post(this.id, caption, tags, imageBase64);
  }

  protected log(message: string): void {
    const prefix = `[${new Date().toISOString().slice(11, 19)}][${this.team}/${this.id}]`;
    console.log(`${prefix} ${message}`);
    WebBridge.getInstanceIfExists()?.agentLog(this.id, message);
  }

  private createRetryHandler(): (event: RetryUpdate) => void {
    const retryLogId = `${this.id}:llm-retry:${randomUUID()}`;
    const history: string[] = [];

    return (event: RetryUpdate) => {
      const bridge = WebBridge.getInstanceIfExists();
      if (!bridge) return;

      if (event.state === 'retrying' || event.state === 'failed') {
        const failedAttempt = event.state === 'failed' ? event.attempt : event.attempt - 1;
        history.push(`Attempt ${failedAttempt}/${event.total} failed\n${event.details}`);
      } else {
        history.push(`Succeeded on attempt ${event.attempt}/${event.total}`);
      }

      const statusLine = event.state === 'retrying'
        ? `Retrying ${event.operation}`
        : event.state === 'succeeded'
          ? `${event.operation} recovered`
          : `${event.operation} failed`;

      bridge.agentLog(this.id, statusLine, {
        id: retryLogId,
        retryCurrent: event.attempt,
        retryTotal: event.total,
        retryState: event.state,
        fullText: history.join('\n\n'),
        summarizing: false,
      });
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

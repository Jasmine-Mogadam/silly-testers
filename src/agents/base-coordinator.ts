import { randomUUID } from 'crypto';
import { BaseAgent, type AgentDeps } from './base-agent';
import type { Task, TaskResult } from '../core/types';

export interface WorkerFactory<T extends BaseAgent> {
  (deps: AgentDeps, taskContext?: Record<string, unknown>): T;
}

/**
 * Abstract coordinator — extends BaseAgent and adds task queue management,
 * worker spawning, and result aggregation.
 *
 * Subclasses (QACoordinator, RedCoordinator) implement:
 *  - buildInitialTasks(): generate the first set of tasks
 *  - planNextTasks(results): adapt tasks based on findings
 *  - run(): the main coordination loop
 */
export abstract class BaseCoordinator extends BaseAgent {
  protected workers: BaseAgent[] = [];
  protected taskQueue: Task[] = [];
  protected completedTasks: TaskResult[] = [];
  private lastDirectiveFingerprint = '';
  private lastDirectiveAt = 0;
  private lastDirectiveInputTimestamp = 0;

  constructor(deps: AgentDeps) {
    super(deps);
  }

  /** Subclasses must generate the initial task list. */
  protected abstract buildInitialTasks(): Promise<Task[]>;

  /**
   * Called after each round of task results — return new/updated tasks
   * to adapt the strategy, or empty array if done.
   */
  protected abstract planNextTasks(results: TaskResult[]): Promise<Task[]>;

  // ─── Task Helpers ────────────────────────────────────────────────────────────

  protected createTask(type: string, description: string, context?: Record<string, unknown>): Task {
    return { id: randomUUID(), type, description, context };
  }

  protected enqueue(...tasks: Task[]): void {
    this.taskQueue.push(...tasks);
  }

  protected dequeue(): Task | undefined {
    return this.taskQueue.shift();
  }

  // ─── Worker Management ────────────────────────────────────────────────────────

  protected registerWorker(worker: BaseAgent): void {
    this.workers.push(worker);
    worker.startListeningToSystem();
  }

  protected async stopAllWorkers(): Promise<void> {
    for (const worker of this.workers) {
      worker.stop();
    }
    this.workers = [];
  }

  // ─── Channel Helpers ─────────────────────────────────────────────────────────

  /** Broadcast a directive to all team members. */
  protected broadcastDirective(message: string): void {
    const normalized = this.normalizeDirective(message);
    if (!normalized) return;

    const now = Date.now();
    const recentlySent = this.lastDirectiveFingerprint === normalized && now - this.lastDirectiveAt < 60_000;
    if (recentlySent) {
      this.log(`Skipping duplicate directive: ${message}`);
      return;
    }

    this.lastDirectiveFingerprint = normalized;
    this.lastDirectiveAt = now;
    this.sendToTeam(`[COORDINATOR] ${message.trim()}`, ['directive']);
  }

  /** Read recent team messages and extract any tagged as 'report'. */
  protected getNewReports(sinceTimestamp: number): string[] {
    return this.teamChannel
      .getRecent(sinceTimestamp)
      .filter((m) => m.tags?.includes('report'))
      .map((m) => m.content);
  }

  /**
   * Returns new worker messages since the last directive review.
   * Coordinator/system chatter is excluded so we only react to fresh team input.
   */
  protected getNewWorkerMessages() {
    return this.teamChannel
      .getRecent(this.lastDirectiveInputTimestamp)
      .filter((m) => m.from !== this.id)
      .filter((m) => !m.tags?.includes('directive'))
      .filter((m) => !m.tags?.includes('system'));
  }

  /**
   * Mark messages as seen before the LLM call so we don't keep hammering Ollama
   * with the same backlog if the coordinator loop wakes up again.
   */
  protected markDirectiveInputsSeen(messages: Array<{ timestamp: number }>): void {
    const newestTimestamp = messages.reduce(
      (max, message) => Math.max(max, message.timestamp),
      this.lastDirectiveInputTimestamp,
    );
    this.lastDirectiveInputTimestamp = newestTimestamp;
  }

  /**
   * Only interrupt the team when there is a clear reason:
   * - a worker explicitly asks for help/input, or
   * - multiple workers are converging on something worth coordinating.
   */
  protected shouldIssueDirective(messages: Array<{ from: string; content: string; tags?: string[] }>): boolean {
    if (messages.length === 0) return false;

    const hasQuestion = messages.some((message) => /\?/.test(message.content));
    const hasCoordinationCue = messages.some((message) =>
      /\b(blocked|stuck|need help|need input|which one|what next|can someone|should we|re-test|duplicate|same issue|overlap)\b/i
        .test(message.content)
    );

    if (hasQuestion || hasCoordinationCue) return true;

    const meaningfulMessages = messages.filter((message) =>
      message.tags?.some((tag) => ['report', 'review-request', 'review-feedback', 'recon', 'exploit', 'observation'].includes(tag))
    );
    const distinctSenders = new Set(meaningfulMessages.map((message) => message.from));

    return distinctSenders.size >= 2 && meaningfulMessages.length >= 2;
  }

  protected formatMessagesForPrompt(messages: Array<{ from: string; content: string }>): string {
    return messages.map((message) => `[${message.from}] ${message.content}`).join('\n');
  }

  private normalizeDirective(message: string): string {
    return message
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/[^\w\s]/g, '')
      .trim();
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────

  protected buildSummaryPrompt(taskResults: TaskResult[]): string {
    const summaries = taskResults.map((r) => `- Task: ${r.taskId} | Success: ${r.success} | ${r.summary}`).join('\n');
    return `Here are the results from our workers:\n${summaries}\n\nBased on these findings, what should we focus on next?`;
  }
}

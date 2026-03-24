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
    this.sendToTeam(`[COORDINATOR] ${message}`, ['directive']);
  }

  /** Read recent team messages and extract any tagged as 'report'. */
  protected getNewReports(sinceTimestamp: number): string[] {
    return this.teamChannel
      .getRecent(sinceTimestamp)
      .filter((m) => m.tags?.includes('report'))
      .map((m) => m.content);
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────

  protected buildSummaryPrompt(taskResults: TaskResult[]): string {
    const summaries = taskResults.map((r) => `- Task: ${r.taskId} | Success: ${r.success} | ${r.summary}`).join('\n');
    return `Here are the results from our workers:\n${summaries}\n\nBased on these findings, what should we focus on next?`;
  }
}

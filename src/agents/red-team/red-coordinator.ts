import { BaseCoordinator } from '../base-coordinator';
import { ReconAgent } from './recon-agent';
import { ExploitAgent } from './exploit-agent';
import type { AgentDeps } from '../base-agent';
import type { Task, TaskResult } from '../../core/types';
import { Team } from '../../core/types';
import type { BrowserPool } from '../../core/browser';

export interface RedCoordinatorDeps extends AgentDeps {
  reconCount: number;
  exploitCount: number;
  browserPool: BrowserPool;
}

/**
 * Commands the Red Team.
 *
 * Responsibilities:
 * - Spawn ReconAgents to map the attack surface
 * - Spawn ExploitAgents once recon starts producing findings
 * - Monitor Red Team channel and adapt attack strategy
 * - Avoid duplicate exploit attempts across agents
 */
export class RedCoordinator extends BaseCoordinator {
  private reconCount: number;
  private exploitCount: number;
  private browserPool: BrowserPool;
  private workerCounter = 0;

  constructor(deps: RedCoordinatorDeps) {
    super(deps);
    this.reconCount = deps.reconCount;
    this.exploitCount = deps.exploitCount;
    this.browserPool = deps.browserPool;
  }

  async run(): Promise<void> {
    this.status = 'running' as typeof this.status;
    this.startListeningToSystem();

    this.log('Red Team Coordinator starting...');

    // Spawn recon agents first
    for (let i = 0; i < this.reconCount; i++) {
      await this.spawnReconAgent();
    }

    // Wait briefly for initial recon before spawning exploit agents
    await sleep(15_000);

    for (let i = 0; i < this.exploitCount; i++) {
      await this.spawnExploitAgent();
    }

    this.broadcastDirective(
      `Red Team active. Recon in progress — exploit agents standing by. Post findings tagged [recon] for exploit agents to pick up.`
    );

    // Coordination loop
    while (!this.isStopped()) {
      await this.checkPaused();
      if (this.isStopped()) break;

      await sleep(45_000);

      if (!this.isStopped()) {
        await this.reviewAndDirectAttack();
      }
    }

    await this.stopAllWorkers();
    this.log('Red Team Coordinator stopped.');
  }

  protected async buildInitialTasks(): Promise<Task[]> {
    return [this.createTask('recon', 'Map the application attack surface')];
  }

  protected async planNextTasks(_results: TaskResult[]): Promise<Task[]> {
    return [];
  }

  private async reviewAndDirectAttack(): Promise<void> {
    const recentMessages = this.getTeamHistory(30);
    if (!recentMessages) return;

    const prompt = `You are the Red Team coordinator reviewing team findings.

Recent messages:
${recentMessages}

Based on these findings, write ONE strategic directive for the team.
Focus on: prioritizing high-value targets, avoiding redundant attempts, coordinating attacks.
Keep it to one sentence.`;

    const directive = await this.askLLM(prompt);
    this.broadcastDirective(directive);
  }

  private async spawnReconAgent(): Promise<void> {
    const workerId = `red-recon-${++this.workerCounter}`;
    const { page, context } = await this.browserPool.acquirePage();

    const agent = new ReconAgent({
      id: workerId,
      team: Team.RED,
      llm: this.llm,
      teamChannel: this.teamChannel,
      systemChannel: this.systemChannel,
      reporter: this.reporter,
      repoReader: this.repoReader,
      siteMap: this.siteMap,
      page,
      context,
    });

    this.registerWorker(agent);
    agent.run().catch((err) => this.log(`ReconAgent ${workerId} error: ${err.message}`));
  }

  private async spawnExploitAgent(): Promise<void> {
    const workerId = `red-exploit-${++this.workerCounter}`;
    const { page, context } = await this.browserPool.acquirePage();

    const agent = new ExploitAgent({
      id: workerId,
      team: Team.RED,
      llm: this.llm,
      teamChannel: this.teamChannel,
      systemChannel: this.systemChannel,
      reporter: this.reporter,
      repoReader: this.repoReader,
      siteMap: this.siteMap,
      page,
      context,
    });

    this.registerWorker(agent);
    agent.run().catch((err) => this.log(`ExploitAgent ${workerId} error: ${err.message}`));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

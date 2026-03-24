import * as fs from 'fs';
import { BaseCoordinator } from '../base-coordinator';
import { FeatureTester } from './feature-tester';
import { PlayTester } from './play-tester';
import type { AgentDeps } from '../base-agent';
import type { Task, TaskResult } from '../../core/types';
import { Team } from '../../core/types';
import type { BrowserPool } from '../../core/browser';

export interface QACoordinatorDeps extends AgentDeps {
  featureListPath: string;
  featureTesterCount: number;
  playTesterCount: number;
  goalIntervalMs: number;
  browserPool: BrowserPool;
}

/**
 * Commands the QA team.
 *
 * Responsibilities:
 * - Parse feature list and spawn FeatureTester workers (one per feature)
 * - Spawn PlayTester workers for free-form exploration
 * - Monitor team channel for findings and adjust strategy
 * - Generate summary report on shutdown
 */
export class QACoordinator extends BaseCoordinator {
  private features: string[] = [];
  private featureListPath: string;
  private featureTesterCount: number;
  private playTesterCount: number;
  private goalIntervalMs: number;
  private browserPool: BrowserPool;
  private workerCounter = 0;

  constructor(deps: QACoordinatorDeps) {
    super(deps);
    this.featureListPath = deps.featureListPath;
    this.featureTesterCount = deps.featureTesterCount;
    this.playTesterCount = deps.playTesterCount;
    this.goalIntervalMs = deps.goalIntervalMs;
    this.browserPool = deps.browserPool;
  }

  async run(): Promise<void> {
    this.status = 'running' as typeof this.status;
    this.startListeningToSystem();

    this.log('QA Coordinator starting...');
    this.features = this.parseFeatureList();
    this.log(`Loaded ${this.features.length} features to test`);

    // Spawn FeatureTesters — distribute features across available slots
    const featureBatches = this.distributeFeatures();
    for (let i = 0; i < this.featureTesterCount; i++) {
      if (featureBatches[i]?.length > 0) {
        await this.spawnFeatureTester(featureBatches[i]);
      }
    }

    // Spawn PlayTesters
    for (let i = 0; i < this.playTesterCount; i++) {
      await this.spawnPlayTester();
    }

    this.broadcastDirective(
      `QA team active. Testing ${this.features.length} features with ${this.featureTesterCount} testers + ${this.playTesterCount} play testers. Report anything unusual.`
    );

    // Coordination loop — monitor findings and post strategic updates
    while (!this.isStopped()) {
      await this.checkPaused();
      if (this.isStopped()) break;

      await sleep(30_000);

      if (!this.isStopped()) {
        await this.reviewAndAdapt();
      }
    }

    await this.stopAllWorkers();
    this.log('QA Coordinator stopped.');
  }

  protected async buildInitialTasks(): Promise<Task[]> {
    return this.features.map((f) => this.createTask('feature-test', f));
  }

  protected async planNextTasks(_results: TaskResult[]): Promise<Task[]> {
    return [];
  }

  private async reviewAndAdapt(): Promise<void> {
    const recentMessages = this.getTeamHistory(20);
    if (!recentMessages.includes('report')) return;

    const prompt = `You are the QA coordinator. Here are recent messages from your team:

${recentMessages}

Based on these findings, write ONE directive for the team (what to focus on, what to watch for, or what to re-test). Keep it concise — one sentence.`;

    const directive = await this.askLLM(prompt);
    this.broadcastDirective(directive);
  }

  private async spawnFeatureTester(features: string[]): Promise<void> {
    const workerId = `qa-ft-${++this.workerCounter}`;
    const { page, context } = await this.browserPool.acquirePage();

    const tester = new FeatureTester({
      id: workerId,
      team: Team.QA,
      llm: this.llm,
      teamChannel: this.teamChannel,
      systemChannel: this.systemChannel,
      reporter: this.reporter,
      repoReader: this.repoReader,
      siteMap: this.siteMap,
      page,
      context,
      feature: features.join('\n'),
    });

    this.registerWorker(tester);
    tester.run().catch((err) => this.log(`FeatureTester ${workerId} error: ${err.message}`));
  }

  private async spawnPlayTester(): Promise<void> {
    const workerId = `qa-pt-${++this.workerCounter}`;
    const { page, context } = await this.browserPool.acquirePage();

    const tester = new PlayTester({
      id: workerId,
      team: Team.QA,
      llm: this.llm,
      teamChannel: this.teamChannel,
      systemChannel: this.systemChannel,
      reporter: this.reporter,
      repoReader: this.repoReader,
      siteMap: this.siteMap,
      page,
      context,
      goalIntervalMs: this.goalIntervalMs,
    });

    this.registerWorker(tester);
    tester.run().catch((err) => this.log(`PlayTester ${workerId} error: ${err.message}`));
  }

  private parseFeatureList(): string[] {
    const raw = fs.readFileSync(this.featureListPath, 'utf8');
    return raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'))
      .filter((l) => l.replace(/^[-*]\s*/, '').length > 0)
      .map((l) => l.replace(/^[-*\d.]+\s*/, ''));
  }

  private distributeFeatures(): string[][] {
    const batches: string[][] = Array.from({ length: this.featureTesterCount }, () => []);
    this.features.forEach((f, i) => batches[i % this.featureTesterCount].push(f));
    return batches;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

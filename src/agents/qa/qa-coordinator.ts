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
  private reviewedMessages = new Set<string>();
  private filedFindingIds = new Set<string>();

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

      await this.reviewPendingDrafts();
      await sleep(10_000);

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

  private async reviewPendingDrafts(): Promise<void> {
    const drafts = this.teamChannel.getHistory()
      .filter((msg) => msg.review?.status === 'draft' && msg.finding && msg.tags?.includes('review-request'))
      .filter((msg) => !this.reviewedMessages.has(msg.id));

    for (const draft of drafts) {
      this.reviewedMessages.add(draft.id);
      const finding = draft.finding!;
      const thread = this.getThreadMessages(draft.threadId ?? draft.review!.findingId);
      const prompt = `You are the QA report reviewer.

Review this draft bug/UX report for correctness and focus.
Approve only if:
- the report stays tightly scoped to the observed issue
- the summary matches the evidence
- the steps are clear and relevant
- the report does not drift into unrelated feature notes or speculation

Draft report:
Title: ${finding.title}
Type: ${finding.type}
Severity: ${finding.severity}
URL: ${finding.url}
Summary: ${finding.summary}
Steps:
${finding.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}
Evidence:
${finding.evidence ?? '(none)'}

Thread so far:
${thread.map((msg) => `[${msg.from}] ${msg.content}`).join('\n')}

Respond in exactly this format:
DECISION: APPROVE | REVISE
FEEDBACK: <one concise sentence>`;

      const response = await this.askLLM(prompt);
      const approved = /DECISION:\s*APPROVE/i.test(response);
      const feedbackMatch = response.match(/FEEDBACK:\s*(.+)/i);
      const feedback = feedbackMatch?.[1]?.trim() || (approved
        ? 'Report is ready to go.'
        : 'Tighten the report so it only describes the confirmed issue and supporting evidence.');

      if (!approved) {
        this.postReviewReply(
          draft.threadId ?? draft.review!.findingId,
          draft.id,
          'needs_revision',
          `Reviewer feedback requested by QA: ${feedback}`,
          feedback,
        );
        continue;
      }

      this.postReviewReply(
        draft.threadId ?? draft.review!.findingId,
        draft.id,
        'approved',
        `QA reviewer marked this report ready: ${finding.type} "${finding.title}".`,
        feedback,
      );

      if (this.filedFindingIds.has(draft.review!.findingId)) continue;
      this.filedFindingIds.add(draft.review!.findingId);
      const filePath = this.report(finding, { announce: false });
      this.postReviewReply(
        draft.threadId ?? draft.review!.findingId,
        draft.id,
        'filed',
        `Approved report filed to disk: ${filePath.split('/').pop() ?? filePath}.`,
        'Filed after QA reviewer approval.',
      );
    }
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

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
  private reviewedMessages = new Set<string>();
  private filedFindingIds = new Set<string>();

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

      try {
        await this.reviewPendingDrafts();
        if (!this.isStopped()) {
          await this.reviewAndDirectAttack();
        }
      } catch (err) {
        this.log(`Coordinator review cycle failed: ${(err as Error).message}`);
      }

      await sleep(5_000);
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
    const newMessages = this.getNewWorkerMessages();
    if (!this.shouldIssueDirective(newMessages)) return;

    this.markDirectiveInputsSeen(newMessages);
    const recentMessages = this.formatMessagesForPrompt(newMessages);

    const prompt = `You are the Red Team coordinator reviewing team findings.

Recent messages:
${recentMessages}

Your job is coordination only.
- You are not writing exploit steps for humans unless it changes team priority.
- You are not offering general security advice.
- You only steer red-team workers toward priority targets, de-duplication, confirmation, and unblockers.

Only interrupt the team if coordination is actually needed right now.
Good reasons to speak:
- an agent explicitly asks a question or signals it is blocked
- multiple agents are converging on the same target or duplicating work
- a fresh finding changes attack priority for the rest of the team

If no interruption is needed, respond exactly with: NO_DIRECTIVE

Otherwise write ONE strategic directive sentence.
Focus on prioritizing high-value targets, avoiding redundant attempts, and coordinating attacks.`;

    const directive = this.parseDirectiveResponse(await this.askLLM(prompt));
    if (!directive) return;
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
      const prompt = `You are the Red Team report reviewer.

Approve only if the vulnerability is clearly confirmed.
Reject for revision if:
- evidence is ambiguous or explicitly says the attack failed
- the summary claims code execution / compromise without proof
- the suggested fix does not match the actual issue
- the report confuses a hypothesis with a confirmed exploit

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
        ? 'Confirmed exploit evidence is sufficient.'
        : 'Do not file this until the evidence proves the exploit succeeded.');

      if (!approved) {
        this.postReviewReply(
          draft.threadId ?? draft.review!.findingId,
          draft.id,
          'needs_revision',
          `Reviewer feedback requested by Red Team: ${feedback}`,
          feedback,
        );
        continue;
      }

      this.postReviewReply(
        draft.threadId ?? draft.review!.findingId,
        draft.id,
        'approved',
        `Red Team reviewer marked this report ready: ${finding.type} "${finding.title}".`,
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
        'Filed after Red Team reviewer approval.',
      );
    }
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
    agent.run().catch((err) => {
      agent.recordCrash(err, 'ReconAgent crashed');
      this.log(`ReconAgent ${workerId} error: ${err instanceof Error ? err.message : String(err)}`);
    });
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
    agent.run().catch((err) => {
      agent.recordCrash(err, 'ExploitAgent crashed');
      this.log(`ExploitAgent ${workerId} error: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

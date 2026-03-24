import { BaseAgent, type AgentDeps } from '../base-agent';
import { ReportType, Severity, Team } from '../../core/types';

export interface PlayTesterDeps extends AgentDeps {
  goalIntervalMs: number;
}

/**
 * Free-form exploration agent. Acts like a curious user.
 *
 * Generates random, realistic goals (e.g., "post a comment", "find settings page",
 * "upload a profile picture") and tries to complete them. Reports UX issues,
 * broken flows, and unexpected behavior along the way.
 *
 * Goals change every goalIntervalMs or when completed/abandoned.
 */
export class PlayTester extends BaseAgent {
  private currentGoal = '';
  private goalIntervalMs: number;
  private goalSetAt = 0;
  private actionsOnCurrentGoal = 0;
  private visitedUrls = new Set<string>();

  constructor(deps: PlayTesterDeps) {
    super(deps);
    this.goalIntervalMs = deps.goalIntervalMs;
  }

  async run(): Promise<void> {
    this.status = 'running' as typeof this.status;
    this.startListeningToSystem();

    await this.navigate(this.siteMap.entryUrl);
    await this.generateGoal();

    while (!this.isStopped()) {
      await this.checkPaused();
      if (this.isStopped()) break;

      try {
        // Rotate goal on timeout or after too many actions (stuck)
        const goalAge = Date.now() - this.goalSetAt;
        if (goalAge > this.goalIntervalMs || this.actionsOnCurrentGoal > 20) {
          await this.generateGoal();
        }

        await this.exploreStep();
        await sleep(1_500);
      } catch (err) {
        this.log(`Explore step error: ${(err as Error).message}`);
        await sleep(3_000);
      }
    }
  }

  private async generateGoal(): Promise<void> {
    const recentTeamMessages = this.getTeamHistory(5);
    const visitedList = [...this.visitedUrls].slice(-5).join(', ');

    const prompt = `You are a play tester exploring a web application.

Site entry URL: ${this.siteMap.entryUrl}
Known routes: ${this.siteMap.routes.map((r) => r.path).join(', ')}
Recently visited: ${visitedList || 'nothing yet'}
Recent team findings: ${recentTeamMessages}

Generate ONE realistic user goal — something a real user might try to do on this site.
Make it specific and actionable. Examples:
- "Find and read the FAQ or help section"
- "Try to change account settings or profile info"
- "Search for content and open a result"
- "Try to post or create some content"
- "Navigate to checkout or payment area"

Respond with ONLY the goal, one sentence, no preamble.`;

    this.currentGoal = await this.askLLM(prompt);
    this.goalSetAt = Date.now();
    this.actionsOnCurrentGoal = 0;

    this.sendToTeam(`New goal: ${this.currentGoal}`, ['goal']);
    this.log(`New goal: ${this.currentGoal}`);
  }

  private async exploreStep(): Promise<void> {
    const pageContent = await this.readPage();
    const links = await this.getPageLinks();
    const currentUrl = this.page.url();
    this.visitedUrls.add(currentUrl);

    const prompt = `You are a play tester on a web application with this goal: "${this.currentGoal}"

Current page:
${pageContent.slice(0, 3000)}

Available links:
${links.slice(0, 15).join('\n')}

Actions taken on this goal so far: ${this.actionsOnCurrentGoal}

Choose ONE action to take next. Use one of these formats:
- NAVIGATE: <url>
- CLICK: <text or description of element>
- TYPE: <css-selector> | <text>
- ANALYZE_VISUAL: <question about the page>
- REPORT_UX: <title> | <severity: High/Medium/Low> | <description of UX issue>
- GOAL_DONE: <brief summary of what happened>
- GOAL_ABANDON: <reason>

Respond with ONE action only.`;

    const action = (await this.askLLM(prompt)).trim();
    this.actionsOnCurrentGoal++;

    await this.executeAction(action, pageContent);
  }

  private async executeAction(action: string, pageContent: string): Promise<void> {
    if (action.startsWith('NAVIGATE:')) {
      const url = action.slice(9).trim();
      const full = url.startsWith('http') ? url : `${this.siteMap.entryUrl}${url}`;
      await this.navigate(full);

    } else if (action.startsWith('CLICK:')) {
      const desc = action.slice(6).trim();
      await this.clickFuzzy(desc);

    } else if (action.startsWith('TYPE:')) {
      const parts = action.slice(5).split('|');
      if (parts.length >= 2) {
        await this.page.fill(parts[0].trim(), parts[1].trim()).catch(() => {});
      }

    } else if (action.startsWith('ANALYZE_VISUAL:')) {
      const question = action.slice(15).trim();
      const analysis = await this.analyzePageVisually(question);
      this.sendToTeam(`Visual analysis: ${analysis}`, ['observation']);

    } else if (action.startsWith('REPORT_UX:')) {
      const parts = action.slice(10).split('|');
      if (parts.length >= 3) {
        const severity = this.parseSeverity(parts[1].trim());
        const codeRefs = await this.findCodeRefs(parts[2].trim());
        await this.submitFindingForReview({
          title: parts[0].trim(),
          type: ReportType.UX,
          severity,
          team: Team.QA,
          url: this.page.url(),
          summary: parts[2].trim(),
          steps: [`Goal: "${this.currentGoal}"`, `Observed: ${parts[2].trim()}`],
          evidence: pageContent.slice(0, 500),
          codeRefs,
          suggestedFix: `Review the UX flow for goal: "${this.currentGoal}"`,
        }, async (currentFinding, feedback) => ({
          ...currentFinding,
          summary: `${currentFinding.summary}\n\nReviewer requested: ${feedback}`,
          evidence: `${currentFinding.evidence ?? ''}\n\nReviewer requested stronger proof: ${feedback}`.trim(),
        }));
      }

    } else if (action.startsWith('GOAL_DONE:') || action.startsWith('GOAL_ABANDON:')) {
      const summary = action.split(':').slice(1).join(':').trim();
      this.sendToTeam(`${action.startsWith('GOAL_DONE') ? 'Completed' : 'Abandoned'} goal "${this.currentGoal}": ${summary}`, ['goal']);
      // Force a new goal next iteration
      this.goalSetAt = 0;
    }
  }

  private async clickFuzzy(description: string): Promise<void> {
    try {
      const locator = this.page
        .getByRole('button', { name: new RegExp(description, 'i') })
        .or(this.page.getByRole('link', { name: new RegExp(description, 'i') }))
        .or(this.page.locator(`text=${description}`));
      await locator.first().click({ timeout: 5_000 });
    } catch {
      this.log(`Fuzzy click failed: ${description}`);
    }
  }

  private async findCodeRefs(description: string) {
    try {
      const keywords = description.split(' ').filter((w) => w.length > 4).slice(0, 3);
      const results = this.repoReader.searchCode(keywords.join('|'));
      return results.slice(0, 2).map((r) => ({ file: r.file, line: r.line, snippet: r.content }));
    } catch {
      return [];
    }
  }

  private parseSeverity(s: string): Severity {
    const map: Record<string, Severity> = {
      high: Severity.High, medium: Severity.Medium, low: Severity.Low,
    };
    return map[s.toLowerCase()] ?? Severity.Low;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

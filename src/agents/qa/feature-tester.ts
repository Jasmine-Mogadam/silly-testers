import { BaseAgent, type AgentDeps } from '../base-agent';
import { ReportType, Severity, Team } from '../../core/types';

export interface FeatureTesterDeps extends AgentDeps {
  feature: string;
}

/**
 * Tests a single feature from the feature list.
 *
 * Loop:
 *  1. Reason about how to test the feature (ask LLM)
 *  2. Navigate and interact with the site
 *  3. Verify expected behavior
 *  4. Report any bugs or unexpected behavior
 *  5. Repeat until stopped
 */
export class FeatureTester extends BaseAgent {
  private feature: string;
  private testCycleCount = 0;

  constructor(deps: FeatureTesterDeps) {
    super(deps);
    this.feature = deps.feature;
  }

  async run(): Promise<void> {
    this.status = 'running' as typeof this.status;
    this.startListeningToSystem();
    this.log(`Starting feature test: ${this.feature}`);

    const testPlan = await this.planTests();
    this.sendToTeam(`Starting tests for: "${this.feature}"\nPlan: ${testPlan}`, ['plan']);

    while (!this.isStopped()) {
      await this.checkPaused();
      if (this.isStopped()) break;

      try {
        await this.runTestCycle(testPlan);
        this.testCycleCount++;

        // After initial pass, wait a bit and re-test to catch timing/state issues
        if (this.testCycleCount > 1) {
          await sleep(10_000);
        }
      } catch (err) {
        this.log(`Test cycle error: ${(err as Error).message}`);
        await sleep(5_000);
      }
    }
  }

  private async planTests(): Promise<string> {
    const repoStructure = this.repoReader.getStructure(2);
    const teamHistory = this.getTeamHistory(10);
    const routeSummary = this.siteMap.routes
      .map((route) => {
        const access = route.access && route.access !== 'unknown' ? ` [${route.access}]` : '';
        const description = route.description ? ` - ${route.description}` : '';
        return `  ${route.method ?? 'GET'} ${route.path}${access}${description}`;
      })
      .join('\n');

    const prompt = `You are a QA tester for a web application.

Feature to test: "${this.feature}"

Repository structure:
${repoStructure}

Recent team findings:
${teamHistory}

The site is at: ${this.siteMap.entryUrl}
Known routes:
${routeSummary}

QA environment guidance:
${this.siteMap.qaGuidance ?? '(none provided)'}

Write a concise test plan (3-5 steps) to verify this feature works correctly. Focus on:
1. Happy path (normal expected usage)
2. Edge cases (empty input, invalid data, boundary values)
3. Error handling (what happens when something goes wrong)

Important:
- Some routes may be intentionally login-only and may redirect, return 401/403, or even return 404 before authentication. That alone is not a bug.
- Treat auth-gated access as a bug only when the user should already have access at that point, or when the app contradicts its intended flow.

Respond with numbered steps only, no preamble.`;

    return this.askLLM(prompt);
  }

  private async runTestCycle(testPlan: string): Promise<void> {
    // Navigate to entry point
    await this.navigate(this.siteMap.entryUrl);
    const pageContent = await this.readPage();

    const prompt = `You are a QA tester. You are testing this feature: "${this.feature}"

Your test plan:
${testPlan}

Current page content:
${pageContent}

Available links on this page:
${(await this.getPageLinks()).join('\n')}

QA environment guidance:
${this.siteMap.qaGuidance ?? '(none provided)'}

Your private notes:
${this.getPrivateNotesSummary()}

Describe exactly what browser actions to take next to test this feature.
For each action, use one of these formats:
- NAVIGATE: <url>
- CLICK: <description of element to click>
- TYPE: <css-selector> | <text to type>
- STORE_NOTE: <label> | <value to remember privately, such as email/password/token>
- SCREENSHOT: <reason>
- REPORT_BUG: <title> | <severity: Critical/High/Medium/Low> | <description>
- DONE: <summary of what was tested>

Important:
- If a page appears protected, try to authenticate or create an account before treating it as broken.
- Do not report a 401/403/404 on a likely protected route as a bug unless the app flow says the current user should already be allowed through.

Respond with one action per line.`;

    const actions = await this.askLLM(prompt);
    await this.executeActions(actions);
  }

  private async executeActions(actionsText: string): Promise<void> {
    const lines = actionsText.split('\n').map((l) => l.trim()).filter(Boolean);

    for (const line of lines) {
      if (this.isStopped()) return;
      await this.checkPaused();

      if (line.startsWith('NAVIGATE:')) {
        const url = line.slice(9).trim();
        await this.navigate(url);

      } else if (line.startsWith('CLICK:')) {
        const desc = line.slice(6).trim();
        await this.clickByDescription(desc);

      } else if (line.startsWith('TYPE:')) {
        const parts = line.slice(5).split('|');
        if (parts.length >= 2) {
          const selector = parts[0].trim();
          const text = parts[1].trim();
          await this.page.fill(selector, text).catch(() => {
            this.logPageInteraction('TYPE failed', `selector=${selector} text=${JSON.stringify(text)}`);
          });
        }

      } else if (line.startsWith('STORE_NOTE:')) {
        const parts = line.slice(11).split('|');
        if (parts.length >= 2) {
          this.savePrivateNote(parts[0].trim(), parts.slice(1).join('|').trim());
        }

      } else if (line.startsWith('SCREENSHOT:')) {
        const reason = line.slice(11).trim();
        const img = await this.screenshot();
        const analysis = await this.llm.vision(img, `Analyze this screenshot in the context of QA testing. ${reason}`);
        this.sendToTeam(`Screenshot analysis: ${analysis}`, ['observation']);

      } else if (line.startsWith('REPORT_BUG:')) {
        const parts = line.slice(11).split('|');
        if (parts.length >= 3) {
          const title = parts[0].trim();
          const severityStr = parts[1].trim();
          const description = parts[2].trim();
          const severity = this.parseSeverity(severityStr);

          const codeRefs = await this.findCodeRefs(description);
          const pageContent = await this.readPage();

          await this.submitFindingForReview({
            title,
            type: ReportType.Bug,
            severity,
            team: Team.QA,
            url: this.page.url(),
            summary: description,
            steps: [`Testing feature: "${this.feature}"`, `Found: ${description}`],
            evidence: pageContent.slice(0, 500),
            codeRefs,
            suggestedFix: await this.suggestFix(description, codeRefs),
          }, async (currentFinding, feedback) => {
            const revised = await this.reviseFinding(currentFinding, feedback);
            return {
              ...currentFinding,
              ...revised,
              type: currentFinding.type,
              team: currentFinding.team,
            };
          });
        }

      } else if (line.startsWith('DONE:')) {
        const summary = line.slice(5).trim();
        this.sendToTeam(`Completed test cycle for "${this.feature}": ${summary}`, ['done']);
        return;
      }

      await sleep(500);
    }
  }

  private async clickByDescription(description: string): Promise<void> {
    try {
      // Try to find by accessible name / text content
      const locator = this.page.getByRole('button', { name: new RegExp(description, 'i') })
        .or(this.page.getByRole('link', { name: new RegExp(description, 'i') }))
        .or(this.page.locator(`text=${description}`));
      await locator.first().click({ timeout: 5_000 });
    } catch {
      this.logPageInteraction('Could not click', description);
    }
  }

  private async findCodeRefs(description: string) {
    try {
      const keywords = description.split(' ').filter((w) => w.length > 4).slice(0, 3);
      const results = this.repoReader.searchCode(keywords.join('|'));
      return results.slice(0, 3).map((r) => ({
        file: r.file,
        line: r.line,
        snippet: r.content,
      }));
    } catch {
      return [];
    }
  }

  private async suggestFix(description: string, codeRefs: { file: string; line?: number; snippet?: string }[]): Promise<string> {
    const refsText = codeRefs.map((r) => `${r.file}:${r.line}\n${r.snippet}`).join('\n\n');
    return this.askLLM(
      `A QA tester found this bug: "${description}"\n\nRelevant code:\n${refsText}\n\nWrite a one-sentence suggested fix for a developer.`
    );
  }

  private async reviseFinding(currentFinding: {
    title: string;
    severity: Severity;
    summary: string;
    steps: string[];
    evidence?: string;
    suggestedFix?: string;
  }, feedback: string): Promise<Partial<typeof currentFinding>> {
    const prompt = `You are revising a QA bug report draft based on reviewer feedback.

Current draft:
Title: ${currentFinding.title}
Severity: ${currentFinding.severity}
Summary: ${currentFinding.summary}
Steps:
${currentFinding.steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}
Evidence:
${currentFinding.evidence ?? '(none)'}
Suggested fix:
${currentFinding.suggestedFix ?? '(none)'}

Reviewer feedback:
${feedback}

Return valid JSON with:
{
  "title": string,
  "severity": "Critical" | "High" | "Medium" | "Low" | "Info",
  "summary": string,
  "steps": string[],
  "evidence": string,
  "suggestedFix": string
}

Keep the report tightly scoped to the actual bug.`;

    try {
      const response = await this.askLLM(prompt);
      const parsed = JSON.parse(extractJsonObject(response));
      return {
        title: typeof parsed.title === 'string' ? parsed.title : currentFinding.title,
        severity: this.parseSeverity(String(parsed.severity ?? currentFinding.severity)),
        summary: typeof parsed.summary === 'string' ? parsed.summary : currentFinding.summary,
        steps: Array.isArray(parsed.steps) ? parsed.steps.map(String) : currentFinding.steps,
        evidence: typeof parsed.evidence === 'string' ? parsed.evidence : currentFinding.evidence,
        suggestedFix: typeof parsed.suggestedFix === 'string' ? parsed.suggestedFix : currentFinding.suggestedFix,
      };
    } catch {
      return {
        summary: `${currentFinding.summary}\n\nReviewer feedback addressed: ${feedback}`,
      };
    }
  }

  private parseSeverity(s: string): Severity {
    const map: Record<string, Severity> = {
      critical: Severity.Critical,
      high: Severity.High,
      medium: Severity.Medium,
      low: Severity.Low,
      info: Severity.Info,
    };
    return map[s.toLowerCase()] ?? Severity.Medium;
  }
}

function extractJsonObject(text: string): string {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON object found');
  return match[0];
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

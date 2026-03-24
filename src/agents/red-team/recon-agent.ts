import { BaseAgent, type AgentDeps } from '../base-agent';
import type { Route } from '../../core/types';

/**
 * Reconnaissance agent — maps the application's attack surface.
 *
 * Reads the source repo to identify:
 *  - API routes and HTTP methods
 *  - Authentication and authorization patterns
 *  - Input validation (or lack thereof)
 *  - Third-party dependencies with known issues
 *  - Sensitive data flows (passwords, tokens, PII)
 *
 * Posts structured findings to the Red Team channel so ExploitAgents
 * can pick up targets.
 */
export class ReconAgent extends BaseAgent {
  private reconComplete = false;
  private readonly discoveredUrls = new Set<string>();
  private readonly sentFindingFingerprints = new Set<string>();
  private lastWakeCheck = 0;

  async run(): Promise<void> {
    this.status = 'running' as typeof this.status;
    this.startListeningToSystem();

    this.log('Recon agent starting...');

    if (!this.reconComplete) {
      await this.performStaticRecon();
      await this.performDynamicRecon();
      this.reconComplete = true;
      this.lastWakeCheck = Date.now();
      this.log('Initial recon complete. Going dormant until new investigation is requested.');
    }

    while (!this.isStopped()) {
      await this.checkPaused();
      if (this.isStopped()) break;

      const wakeMessages = this.getWakeMessages();
      if (wakeMessages.length === 0) {
        await sleep(15_000);
        continue;
      }

      this.log(`Waking for focused recon due to ${wakeMessages.length} follow-up request(s).`);
      await this.performFocusedRecon(wakeMessages);
    }
  }

  // ─── Static Recon (repo analysis) ─────────────────────────────────────────

  private async performStaticRecon(): Promise<void> {
    this.log('Starting static recon (repo analysis)...');

    const structure = this.repoReader.getStructure(3);
    this.sendReconFinding(`Repo structure:\n${structure}`, ['recon', 'structure']);

    await this.analyzeRoutes();
    await this.analyzeAuthPatterns();
    await this.analyzeInputValidation();
    await this.analyzeDependencies();
  }

  private async analyzeRoutes(): Promise<void> {
    const routeFiles = this.findRouteFiles();
    const routeCode = routeFiles
      .slice(0, 5)
      .map((f) => {
        try {
          return `// ${f}\n${this.repoReader.readFile(f).slice(0, 2000)}`;
        } catch {
          return '';
        }
      })
      .filter(Boolean)
      .join('\n\n---\n\n');

    if (!routeCode) return;

    const prompt = `You are a security researcher performing recon on a web application.

Here are the route/controller files:
${routeCode}

List all HTTP endpoints you can identify. For each, note:
- Method + path
- Authentication required? (yes/no/unknown)
- User-controlled inputs
- Any obvious security concerns

Format as a list. Be concise.`;

    const analysis = await this.askLLM(prompt);
    this.sendReconFinding(`Route analysis:\n${analysis}`, ['recon', 'routes']);
  }

  private async analyzeAuthPatterns(): Promise<void> {
    const authResults = this.repoReader.searchCode('(auth|login|session|token|jwt|cookie|password)', 'ts');
    const jsResults = this.repoReader.searchCode('(auth|login|session|token|jwt|cookie|password)', 'js');
    const combined = [...authResults, ...jsResults].slice(0, 20);

    if (combined.length === 0) return;

    const snippets = combined.map((r) => `${r.file}:${r.line} → ${r.content}`).join('\n');

    const prompt = `You are analyzing authentication patterns for security vulnerabilities.

Code references:
${snippets}

Identify:
1. Authentication mechanism used (JWT, sessions, OAuth, etc.)
2. Any weak patterns (hardcoded secrets, missing expiry, insecure storage)
3. Specific files/lines to target for exploitation

Be brief and specific.`;

    const analysis = await this.askLLM(prompt);
    this.sendReconFinding(`Auth patterns:\n${analysis}`, ['recon', 'auth']);
  }

  private async analyzeInputValidation(): Promise<void> {
    const results = this.repoReader.searchCode('(req\\.body|req\\.query|req\\.params|request\\.form|input|FormData)');
    const snippets = results.slice(0, 15).map((r) => `${r.file}:${r.line} → ${r.content}`).join('\n');

    if (!snippets) return;

    const prompt = `Analyze these input handling code references for injection vulnerabilities (SQLi, XSS, command injection, path traversal):

${snippets}

List specific files and line numbers that lack proper sanitization/validation. Note what attack type is possible.`;

    const analysis = await this.askLLM(prompt);
    this.sendReconFinding(`Input validation gaps:\n${analysis}`, ['recon', 'injection']);
  }

  private async analyzeDependencies(): Promise<void> {
    try {
      const pkg = this.repoReader.readFile('package.json');
      const deps = JSON.parse(pkg);
      const allDeps = {
        ...deps.dependencies,
        ...deps.devDependencies,
      };

      const depList = Object.entries(allDeps)
        .map(([name, version]) => `${name}@${version}`)
        .join('\n');

      const prompt = `Review these npm dependencies for known vulnerability patterns. List any packages that commonly have security issues (old auth libraries, unpatched express versions, crypto libraries, etc.):

${depList}

Just list concerning packages and why. Be brief.`;

      const analysis = await this.askLLM(prompt);
      this.sendReconFinding(`Dependency concerns:\n${analysis}`, ['recon', 'deps']);
    } catch {
      // no package.json or not parseable
    }
  }

  // ─── Dynamic Recon (browser crawl) ────────────────────────────────────────

  private async performDynamicRecon(): Promise<void> {
    this.log('Starting dynamic recon (browser crawl)...');
    await this.navigate(this.siteMap.entryUrl);

    const toVisit = [this.siteMap.entryUrl];
    const visited = new Set<string>();

    while (toVisit.length > 0 && this.discoveredUrls.size < 30) {
      const url = toVisit.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);

      const ok = await this.navigate(url);
      if (!ok) continue;

      const links = await this.getPageLinks();
      const pageContent = await this.readPage();

      this.discoveredUrls.add(url);
      for (const link of links) {
        if (!visited.has(link)) toVisit.push(link);
      }

      // Look for forms — juicy targets
      const forms = await this.page.locator('form').count();
      if (forms > 0) {
        this.sendReconFinding(`Found ${forms} form(s) at: ${url}`, ['recon', 'forms']);
      }

      // Look for error messages that leak info
      if (/error|exception|stack trace|undefined|null/i.test(pageContent)) {
        this.sendReconFinding(`Potential info leak at ${url}: error messages visible`, ['recon', 'info-leak']);
      }

      await sleep(500);
    }

    const discoveredRoutes: Route[] = [...this.discoveredUrls].map((url) => {
      try {
        const { pathname } = new URL(url);
        return { path: pathname };
      } catch {
        return { path: url };
      }
    });

    this.sendReconFinding(
      `Dynamic recon complete. Discovered ${discoveredRoutes.length} pages:\n${discoveredRoutes.map((r) => r.path).join('\n')}`,
      ['recon', 'complete']
    );
  }

  private getWakeMessages(): Array<{ from: string; content: string; tags?: string[] }> {
    const recent = this.teamChannel
      .getRecent(this.lastWakeCheck)
      .filter((msg) => msg.from !== this.id);

    this.lastWakeCheck = Date.now();

    return recent.filter((msg) =>
      msg.tags?.includes('directive')
      || /\b(recon|investigate|look into|check|clarify|verify|which route|which endpoint|auth|form|parameter|input|payload|target)\b/i.test(msg.content)
      || /\?/.test(msg.content)
    );
  }

  private async performFocusedRecon(messages: Array<{ from: string; content: string }>): Promise<void> {
    await this.navigate(this.siteMap.entryUrl);
    const links = await this.getPageLinks();
    const pageContent = await this.readPage();
    const knownPaths = [...this.discoveredUrls]
      .map((url) => {
        try {
          return new URL(url).pathname;
        } catch {
          return url;
        }
      })
      .join('\n');

    const prompt = `You are a recon agent deciding whether follow-up discovery is needed.

Recent team requests:
${messages.map((message) => `[${message.from}] ${message.content}`).join('\n')}

Known discovered paths:
${knownPaths || '(none yet)'}

Current page:
${pageContent.slice(0, 2000)}

Visible links from the current page:
${links.join('\n') || '(none)'}

Respond in exactly one of these formats:
NO_NEW_RECON
TARGETS:
- <path or URL>
- <path or URL>`;

    const response = await this.askLLM(prompt);
    const targets = response
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim())
      .filter(Boolean);

    if (/NO_NEW_RECON/i.test(response) || targets.length === 0) {
      this.log('Focused recon found no new area worth investigating.');
      return;
    }

    for (const target of targets.slice(0, 3)) {
      await this.inspectTarget(target);
    }
  }

  private async inspectTarget(target: string): Promise<void> {
    const url = this.resolveUrl(target);
    if (!url || this.discoveredUrls.has(url)) return;

    const ok = await this.navigate(url);
    if (!ok) return;

    this.discoveredUrls.add(url);

    const pageContent = await this.readPage();
    const forms = await this.page.locator('form').count();

    if (forms > 0) {
      this.sendReconFinding(`Focused recon found ${forms} form(s) at: ${url}`, ['recon', 'forms']);
    }

    if (/error|exception|stack trace|undefined|null/i.test(pageContent)) {
      this.sendReconFinding(`Focused recon saw possible info leak at ${url}`, ['recon', 'info-leak']);
    }

    this.sendReconFinding(`Focused recon discovered: ${url}`, ['recon', 'update']);
  }

  private sendReconFinding(content: string, tags: string[]): void {
    const fingerprint = content
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();

    if (!fingerprint || this.sentFindingFingerprints.has(fingerprint)) {
      return;
    }

    this.sentFindingFingerprints.add(fingerprint);
    this.sendToTeam(content, tags);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private findRouteFiles(): string[] {
    const candidates = ['routes', 'controllers', 'api', 'server', 'app', 'pages/api', 'src/routes', 'src/api'];
    const files: string[] = [];

    for (const dir of candidates) {
      if (this.repoReader.exists(dir)) {
        try {
          const found = this.repoReader.listFiles('.ts').filter((f) => f.startsWith(dir));
          files.push(...found);
        } catch {
          const found = this.repoReader.listFiles('.js').filter((f) => f.startsWith(dir));
          files.push(...found);
        }
      }
    }

    // Fallback: search for route-defining patterns
    if (files.length === 0) {
      const results = this.repoReader.searchCode("(app\\.(get|post|put|delete|patch)|router\\.(get|post|put|delete|patch))");
      files.push(...[...new Set(results.map((r) => r.file))]);
    }

    return files;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

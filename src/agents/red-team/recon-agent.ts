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

  async run(): Promise<void> {
    this.status = 'running' as typeof this.status;
    this.startListeningToSystem();

    this.log('Recon agent starting...');

    if (!this.reconComplete) {
      await this.performStaticRecon();
      await this.performDynamicRecon();
      this.reconComplete = true;
    }

    // After initial recon, periodically scan for new pages/routes
    while (!this.isStopped()) {
      await this.checkPaused();
      if (this.isStopped()) break;
      await sleep(60_000);
      if (!this.isStopped()) {
        await this.updateDynamicRecon();
      }
    }
  }

  // ─── Static Recon (repo analysis) ─────────────────────────────────────────

  private async performStaticRecon(): Promise<void> {
    this.log('Starting static recon (repo analysis)...');

    const structure = this.repoReader.getStructure(3);
    this.sendToTeam(`Repo structure:\n${structure}`, ['recon', 'structure']);

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
    this.sendToTeam(`Route analysis:\n${analysis}`, ['recon', 'routes']);
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
    this.sendToTeam(`Auth patterns:\n${analysis}`, ['recon', 'auth']);
  }

  private async analyzeInputValidation(): Promise<void> {
    const results = this.repoReader.searchCode('(req\\.body|req\\.query|req\\.params|request\\.form|input|FormData)');
    const snippets = results.slice(0, 15).map((r) => `${r.file}:${r.line} → ${r.content}`).join('\n');

    if (!snippets) return;

    const prompt = `Analyze these input handling code references for injection vulnerabilities (SQLi, XSS, command injection, path traversal):

${snippets}

List specific files and line numbers that lack proper sanitization/validation. Note what attack type is possible.`;

    const analysis = await this.askLLM(prompt);
    this.sendToTeam(`Input validation gaps:\n${analysis}`, ['recon', 'injection']);
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
      this.sendToTeam(`Dependency concerns:\n${analysis}`, ['recon', 'deps']);
    } catch {
      // no package.json or not parseable
    }
  }

  // ─── Dynamic Recon (browser crawl) ────────────────────────────────────────

  private async performDynamicRecon(): Promise<void> {
    this.log('Starting dynamic recon (browser crawl)...');
    await this.navigate(this.siteMap.entryUrl);

    const discovered: Set<string> = new Set();
    const toVisit = [this.siteMap.entryUrl];
    const visited = new Set<string>();

    while (toVisit.length > 0 && discovered.size < 30) {
      const url = toVisit.shift()!;
      if (visited.has(url)) continue;
      visited.add(url);

      const ok = await this.navigate(url);
      if (!ok) continue;

      const links = await this.getPageLinks();
      const pageContent = await this.readPage();

      discovered.add(url);
      for (const link of links) {
        if (!visited.has(link)) toVisit.push(link);
      }

      // Look for forms — juicy targets
      const forms = await this.page.locator('form').count();
      if (forms > 0) {
        this.sendToTeam(`Found ${forms} form(s) at: ${url}`, ['recon', 'forms']);
      }

      // Look for error messages that leak info
      if (/error|exception|stack trace|undefined|null/i.test(pageContent)) {
        this.sendToTeam(`Potential info leak at ${url}: error messages visible`, ['recon', 'info-leak']);
      }

      await sleep(500);
    }

    const discoveredRoutes: Route[] = [...discovered].map((url) => {
      try {
        const { pathname } = new URL(url);
        return { path: pathname };
      } catch {
        return { path: url };
      }
    });

    this.sendToTeam(
      `Dynamic recon complete. Discovered ${discoveredRoutes.length} pages:\n${discoveredRoutes.map((r) => r.path).join('\n')}`,
      ['recon', 'complete']
    );
  }

  private async updateDynamicRecon(): Promise<void> {
    // Lighter follow-up scan — just check for new pages on known entry points
    await this.navigate(this.siteMap.entryUrl);
    const links = await this.getPageLinks();
    this.sendToTeam(`Periodic recon update: ${links.length} links visible from home`, ['recon', 'update']);
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

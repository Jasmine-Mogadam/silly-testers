import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { BaseAgent, type AgentDeps } from './base-agent';
import { ReportType, Severity, Team } from '../core/types';
import type { WatchdogConfig, SiteMap, Route, DiscoveredTarget } from '../core/types';
import type { OllamaClient } from '../core/llm';
import { RepoReader } from '../core/repo-reader';

export interface DevOpsAgentDeps extends AgentDeps {
  repoPath: string;
  discovered: DiscoveredTarget;
  reportDir: string;
}

// ─── Documentation Reader ─────────────────────────────────────────────────────

/**
 * Reads standard project documentation files and returns their content
 * concatenated with headers. These files often contain setup steps, required
 * env vars, and start commands that are more reliable than inferred heuristics.
 */
function readDocFiles(reader: RepoReader): string {
  const candidates = [
    'README.md', 'README.mdx', 'README.txt', 'README',
    'DEVELOPMENT.md', 'DEVELOP.md', 'DEVELOPING.md',
    'SETUP.md', 'INSTALL.md', 'INSTALLATION.md',
    'CONTRIBUTING.md', 'HACKING.md', 'QUICKSTART.md', 'GETTING_STARTED.md',
    'docs/development.md', 'docs/setup.md', 'docs/getting-started.md',
    'docs/contributing.md', 'docs/install.md', 'docs/local-development.md',
    '.github/CONTRIBUTING.md', '.github/DEVELOPMENT.md',
  ];

  const MAX_PER_FILE = 3000;
  const sections: string[] = [];

  for (const candidate of candidates) {
    if (reader.exists(candidate)) {
      try {
        const content = reader.readFile(candidate).slice(0, MAX_PER_FILE);
        sections.push(`### ${candidate}\n${content}`);
      } catch { /* skip unreadable */ }
    }
  }

  return sections.join('\n\n');
}

// ─── Static Discovery (runs before server starts, no browser) ─────────────────

/**
 * Reads the repository and uses the LLM to determine how to start the server
 * and what URL it will be available on. No browser required — purely static analysis.
 */
export async function discoverTargetConfig(
  repoPath: string,
  llm: OllamaClient
): Promise<DiscoveredTarget> {
  const reader = new RepoReader(repoPath);
  const log = (msg: string) => console.log(`[devops/discover] ${msg}`);

  log('Setting up environment and analyzing repository...');

  // Step 1: set up .env and other config files BEFORE we try to start anything
  await setupEnvironment(repoPath, llm, reader);

  log('Determining start command and HTTP server URL...');

  // Collect evidence from the repo
  const evidence: string[] = [];

  // Documentation files first — most reliable source of setup instructions
  const docs = readDocFiles(reader);
  if (docs) evidence.push(`Project documentation:\n${docs}`);

  // Repo structure
  evidence.push(`Repository structure:\n${reader.getStructure(3)}`);

  // Root package.json (workspaces, scripts)
  if (reader.exists('package.json')) {
    try {
      const pkg = JSON.parse(reader.readFile('package.json'));
      evidence.push(`Root package.json:\n${JSON.stringify({ scripts: pkg.scripts, workspaces: pkg.workspaces }, null, 2)}`);
    } catch { /* ignore */ }
  }

  // Workspace package.json files (monorepos)
  const workspacePackages = reader.searchCode('"scripts"').map(r => r.file)
    .filter(f => f.endsWith('package.json') && f !== 'package.json')
    .slice(0, 6);
  for (const pkgFile of workspacePackages) {
    try {
      const pkg = JSON.parse(reader.readFile(pkgFile));
      if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
        evidence.push(`${pkgFile} scripts:\n${JSON.stringify(pkg.scripts, null, 2)}`);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        const httpFrameworks = Object.keys(deps).filter(d =>
          ['express', 'fastify', 'koa', 'next', '@nestjs/core', 'hapi', 'restify'].includes(d)
        );
        if (httpFrameworks.length) evidence.push(`  → HTTP frameworks in ${pkgFile}: ${httpFrameworks.join(', ')}`);
      }
    } catch { /* ignore */ }
  }

  // Look for listen() calls in server source to find the HTTP port
  const listenCalls = reader.searchCode('app\\.listen|server\\.listen|\.listen\\(');
  const portHints = listenCalls.slice(0, 8).map(r => `${r.file}:${r.line} → ${r.content.trim()}`);
  if (portHints.length) evidence.push(`HTTP listen() calls found:\n${portHints.join('\n')}`);

  // .env for PORT (after setup, so it may now exist)
  for (const envFile of ['.env', '.env.local', '.env.example']) {
    if (reader.exists(envFile)) {
      try {
        const lines = reader.readFile(envFile).split('\n')
          .filter(l => /^(PORT|HOST)\s*=/i.test(l));
        if (lines.length) evidence.push(`${envFile} port vars:\n${lines.join('\n')}`);
      } catch { /* ignore */ }
      break;
    }
  }

  // Vite / Next / other framework configs
  for (const cfgFile of ['vite.config.ts', 'vite.config.js', 'next.config.js', 'next.config.ts', 'next.config.mjs']) {
    if (reader.exists(cfgFile)) {
      try {
        evidence.push(`${cfgFile}:\n${reader.readFile(cfgFile).slice(0, 500)}`);
      } catch { /* ignore */ }
    }
  }

  // docker-compose (for understanding service ports — but we only want HTTP ports)
  for (const dc of ['docker-compose.yml', 'docker-compose.yaml']) {
    if (reader.exists(dc)) {
      try { evidence.push(`${dc}:\n${reader.readFile(dc).slice(0, 800)}`); } catch { /* ignore */ }
      break;
    }
  }

  const prompt = `You are a DevOps engineer. Analyze this repository to determine exactly how to start the HTTP web server for development testing.

Evidence:
${evidence.join('\n\n---\n\n')}

Determine:
1. The exact shell command to start the HTTP development server
2. The HTTP URL where the web UI will be accessible (NOT a database URL)

Critical rules:
- The URL must be an HTTP server URL, NOT a database connection URL
- IGNORE these database ports entirely: 5432 (PostgreSQL), 3306 (MySQL), 27017 (MongoDB), 6379 (Redis), 5433, 1433
- The URL must start with http:// and use a port that an HTTP server listens on
- For monorepos, use the workspace command that starts the web server / frontend
- Prefer "dev" script over "start"
- Common HTTP ports: 3000 (Node/Next/Rails), 4000 (GraphQL), 5173 (Vite), 8000 (Django/FastAPI), 8080 (Java/Go), 3001 (fallback)
- If a listen() call shows a specific port, use that

Respond in EXACTLY this format (two lines, nothing else):
START_COMMAND: <full shell command>
URL: http://localhost:<port>`;

  const response = await llm.complete(prompt);

  const cmdMatch = response.match(/START_COMMAND:\s*(.+)/);
  const urlMatch = response.match(/URL:\s*(https?:\/\/[^\s]+)/);

  const startCommand = cmdMatch?.[1]?.trim() ?? 'npm run dev';
  // Strip trailing slash and validate it's not a DB port
  let url = urlMatch?.[1]?.trim().replace(/\/$/, '') ?? 'http://localhost:3000';
  url = sanitizeHttpUrl(url);

  log(`Start command: ${startCommand}`);
  log(`URL: ${url}`);

  return { startCommand, url };
}

/** Reject DB ports and other non-HTTP URLs, falling back to :3000 */
function sanitizeHttpUrl(url: string): string {
  const DB_PORTS = new Set(['5432', '5433', '3306', '27017', '6379', '1433', '1521']);
  try {
    const u = new URL(url);
    if (DB_PORTS.has(u.port)) {
      console.warn(`[devops/discover] Rejected DB port ${u.port} as HTTP URL — falling back to :3000`);
      return 'http://localhost:3000';
    }
  } catch { /* ignore */ }
  return url;
}

// ─── Environment Setup ────────────────────────────────────────────────────────

/**
 * Creates .env files and other config files required to run the project.
 * - Finds .env.example / .env.sample and creates .env if missing
 * - Finds other *.example / *.template files and creates their non-example counterparts
 * - Uses the LLM to fill in sensible development defaults for missing values
 * - Never overwrites existing files
 */
export async function setupEnvironment(
  repoPath: string,
  llm: OllamaClient,
  reader?: RepoReader
): Promise<void> {
  const r = reader ?? new RepoReader(repoPath);
  const log = (msg: string) => console.log(`[devops/env] ${msg}`);

  // 1. Handle .env files
  await setupEnvFile(repoPath, r, llm, log);

  // 2. Handle other *.example / *.sample / *.template config files
  await setupOtherConfigFiles(repoPath, r, llm, log);
}

async function setupEnvFile(
  repoPath: string,
  reader: RepoReader,
  llm: OllamaClient,
  log: (msg: string) => void
): Promise<void> {
  // Find a template to base .env on
  const templates = ['.env.example', '.env.sample', '.env.local.example', '.env.template'];
  let templateFile: string | null = null;
  let templateContent = '';

  for (const t of templates) {
    if (reader.exists(t)) {
      templateFile = t;
      try { templateContent = reader.readFile(t); } catch { /* ignore */ }
      break;
    }
  }

  // Also check workspace subdirectories
  if (!templateFile) {
    const found = reader.listFiles('.example').filter(f => path.basename(f) === '.env.example').slice(0, 3);
    for (const f of found) {
      const envTarget = f.replace(/\.example$/, '');
      if (!reader.exists(envTarget)) {
        templateFile = f;
        try { templateContent = reader.readFile(f); } catch { /* ignore */ }
        // Set up this workspace env file too
        await writeEnvFile(path.join(repoPath, envTarget), templateContent, llm, log, reader, repoPath);
      }
    }
  }

  // Handle root .env
  const envPath = path.join(repoPath, '.env');
  if (fs.existsSync(envPath)) {
    // .env exists — check for missing variables vs template
    if (templateContent) {
      await fillMissingEnvVars(envPath, templateContent, llm, log, reader, repoPath);
    }
    return;
  }

  if (!templateContent) {
    // No template found — check the codebase for required env vars and generate minimal .env
    log('No .env template found — scanning codebase for required environment variables...');
    templateContent = await inferEnvRequirements(reader, llm);
  }

  if (templateContent) {
    await writeEnvFile(envPath, templateContent, llm, log, reader, repoPath);
  }
}

async function writeEnvFile(
  envPath: string,
  templateContent: string,
  llm: OllamaClient,
  log: (msg: string) => void,
  reader: RepoReader,
  repoPath: string
): Promise<void> {
  log(`Creating ${path.relative(repoPath, envPath)}...`);

  const repoStructure = reader.getStructure(2);
  const docs = readDocFiles(reader);
  const prompt = `You are a DevOps engineer setting up a development environment.

Repository structure:
${repoStructure}
${docs ? `\nProject documentation (use this to infer correct values):\n${docs}\n` : ''}
This is the .env template for the project:
${templateContent}

Fill in appropriate VALUES for local development. Rules:
- DATABASE_URL: use postgresql://postgres:postgres@localhost:5432/dev (or mysql://root:@localhost:3306/dev for MySQL)
- SECRET_KEY / JWT_SECRET / APP_SECRET: generate a random 32-char alphanumeric string
- NODE_ENV / APP_ENV: development
- PORT: keep existing value or use 3000
- API_URL / BACKEND_URL: use http://localhost:3000 (adjust port if you can infer it)
- REDIS_URL: redis://localhost:6379
- Keep comments from the template
- For any other variable, provide a sensible development placeholder
- NEVER use production values

Return the complete .env file content with all variables filled in. No explanation — just the file content.`;

  const filled = await llm.complete(prompt);

  // Strip markdown code fences the LLM might add, then sanitize
  const raw = filled.replace(/^```[^\n]*\n?/gm, '').replace(/^```\s*$/gm, '').trim();
  const content = sanitizeEnvContent(raw);
  const header = `# Auto-generated by silly-testers DevOps agent for local development\n# Review before using in any non-local environment\n\n`;

  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, header + content + '\n', 'utf8');
  log(`Created ${path.relative(repoPath, envPath)} ✓`);
}

/**
 * Ensures every assignment line in a .env string has a valid key.
 * - Strips lines whose key contains spaces (invalid) rather than letting dotenv choke on them
 * - Converts keys with spaces to SCREAMING_SNAKE_CASE as a best-effort rescue
 * - Leaves comments and blank lines untouched
 */
function sanitizeEnvContent(content: string): string {
  return content.split('\n').map(line => {
    // Blank lines and comments pass through unchanged
    if (line.trim() === '' || line.trim().startsWith('#')) return line;

    const eqIdx = line.indexOf('=');

    // Lines with no `=` are not valid env syntax — comment them out.
    // e.g. LLM preamble like "Here are the filled environment variables:"
    if (eqIdx === -1) return `# REMOVED (not KEY=VALUE): ${line}`;

    const key = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);

    if (!/\s/.test(key)) return line; // already valid

    // Convert "Some Key Name" → "SOME_KEY_NAME"
    const fixed = key.trim().toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, '');
    return fixed ? `${fixed}=${value}` : `# REMOVED (invalid key): ${line}`;
  }).join('\n');
}

/** Returns a sensible dev placeholder for a known env var name. */
function defaultEnvValue(key: string): string {
  const k = key.toUpperCase();
  if (/DATABASE_URL|DB_URL/.test(k)) return 'postgresql://postgres:postgres@localhost:5432/dev';
  if (/REDIS_URL/.test(k)) return 'redis://localhost:6379';
  if (/SECRET|JWT|TOKEN|KEY|SALT/.test(k)) return randomHex(32);
  if (/PORT$/.test(k)) return '3000';
  if (/HOST$/.test(k)) return 'localhost';
  if (/NODE_ENV|APP_ENV|ENV/.test(k)) return 'development';
  if (/URL|URI/.test(k)) return 'http://localhost:3000';
  return 'dev_placeholder';
}

function randomHex(length: number): string {
  return Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

async function fillMissingEnvVars(
  envPath: string,
  templateContent: string,
  llm: OllamaClient,
  log: (msg: string) => void,
  reader: RepoReader,
  repoPath: string
): Promise<void> {
  const existing = fs.readFileSync(envPath, 'utf8');
  const existingKeys = new Set(
    existing.split('\n')
      .filter(l => /^[A-Z_]+=/.test(l))
      .map(l => l.split('=')[0])
  );

  const missingLines = templateContent.split('\n').filter(l => {
    const key = l.match(/^([A-Z_][A-Z0-9_]*)=/)?.[1];
    return key && !existingKeys.has(key);
  });

  if (missingLines.length === 0) return;

  log(`Adding ${missingLines.length} missing env var(s) to existing .env...`);

  const repoStructure = reader.getStructure(2);
  const prompt = `You are a DevOps engineer. Fill in these missing environment variables for local development:

${missingLines.join('\n')}

Repository structure:
${repoStructure}

Return ONLY the filled variable lines (KEY=value format), one per line. No comments, no explanation.`;

  const filled = await llm.complete(prompt);
  const raw = filled.replace(/^```[^\n]*\n?/gm, '').replace(/^```\s*$/gm, '').trim();
  const newVars = sanitizeEnvContent(raw);

  const appended = `\n# Added by silly-testers DevOps agent\n${newVars}\n`;
  fs.appendFileSync(envPath, appended, 'utf8');
  log(`Updated .env with missing variables ✓`);
}

async function inferEnvRequirements(reader: RepoReader, llm: OllamaClient): Promise<string> {
  // Search for process.env references to infer what vars are needed
  const envRefs = reader.searchCode('process\\.env\\.|os\\.environ|ENV\\[').slice(0, 30);
  if (envRefs.length === 0) return '';

  const refs = envRefs.map(r => `${r.file}:${r.line} → ${r.content.trim()}`).join('\n');
  const docs = readDocFiles(reader);

  const prompt = `Based on these environment variable references in the code, generate a minimal .env file for local development:

${refs}
${docs ? `\nProject documentation (use this to infer correct values):\n${docs}\n` : ''}
Return ONLY the .env file content in KEY=value format. Fill in sensible development defaults.`;

  return llm.complete(prompt);
}

async function setupOtherConfigFiles(
  repoPath: string,
  reader: RepoReader,
  llm: OllamaClient,
  log: (msg: string) => void
): Promise<void> {
  // Find *.example and *.sample files that don't have a non-example counterpart
  const allFiles = reader.listFiles();
  const templateFiles = allFiles.filter(f => {
    const base = path.basename(f);
    return (base.endsWith('.example') || base.endsWith('.sample') || base.endsWith('.template')) &&
      !base.startsWith('.env');  // handled separately above
  });

  for (const templateFile of templateFiles) {
    const target = templateFile
      .replace(/\.example$/, '')
      .replace(/\.sample$/, '')
      .replace(/\.template$/, '');

    if (target === templateFile || reader.exists(target)) continue;

    const absTarget = path.join(repoPath, target);
    log(`Creating ${target} from ${templateFile}...`);

    try {
      const templateContent = reader.readFile(templateFile);
      const ext = path.extname(target);

      // Only fill in templates for known config-like extensions
      const configExts = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.config', '.js', '.ts']);
      if (!configExts.has(ext)) {
        // Just copy it
        fs.mkdirSync(path.dirname(absTarget), { recursive: true });
        fs.writeFileSync(absTarget, templateContent, 'utf8');
        log(`Copied ${target} ✓`);
        continue;
      }

      const prompt = `You are setting up a development environment. Fill in this config template with sensible local development defaults:

File: ${target}
Content:
${templateContent.slice(0, 2000)}

Return ONLY the filled file content. No explanation.`;

      const filled = await llm.complete(prompt);
      const content = filled.replace(/^```[^\n]*\n?/gm, '').replace(/^```\s*$/gm, '').trim();

      fs.mkdirSync(path.dirname(absTarget), { recursive: true });
      fs.writeFileSync(absTarget, content + '\n', 'utf8');
      log(`Created ${target} ✓`);
    } catch (err) {
      log(`Skipped ${target}: ${(err as Error).message}`);
    }
  }
}

export interface DevOpsResult {
  watchdogConfig: WatchdogConfig;
  siteMap: SiteMap;
}

/**
 * Runs once at startup (and again on watchdog failure) to:
 *
 * 1. Inspect the target repo to determine how to health-check the running server
 * 2. Discover all valid routes/origins to build the SiteMap
 * 3. Write watchdog.config.json for the Watchdog to use
 *
 * In recovery mode (invoked after watchdog gives up), it also attempts
 * manual diagnosis and writes a recovery report.
 */
export class DevOpsAgent extends BaseAgent {
  private repoPath: string;
  private startCommand: string;
  private targetUrl: string;
  private reportDir: string;

  constructor(deps: DevOpsAgentDeps) {
    super(deps);
    this.repoPath = deps.repoPath;
    this.startCommand = deps.discovered.startCommand;
    this.targetUrl = deps.discovered.url;
    this.reportDir = deps.reportDir;
  }

  async run(): Promise<void> {
    this.status = 'running' as typeof this.status;
    this.log('DevOps agent starting initial configuration...');
    // Not used in streaming mode; use configure() instead
  }

  /**
   * Called by the runner after each failed startup attempt.
   *
   * Analyzes server output to understand the failure, attempts a targeted fix
   * (env vars, missing deps, prisma generate, etc.), then returns whether a fix
   * was applied so the runner knows whether to retry.
   *
   * On the final attempt it writes a full startup failure report instead of trying to fix.
   */
  async diagnoseStartupFailure(
    serverOutput: string,
    attempt: number,
    maxAttempts: number
  ): Promise<{ fixApplied: boolean }> {
    const isFinal = attempt >= maxAttempts;
    this.log(`Diagnosing startup failure (attempt ${attempt}/${maxAttempts})...`);

    const repoStructure = this.repoReader.getStructure(3);

    // Read current .env if it exists (may have been written in a prior attempt)
    let currentEnv = '';
    const envPath = path.join(this.repoPath, '.env');
    if (fs.existsSync(envPath)) {
      try { currentEnv = fs.readFileSync(envPath, 'utf8'); } catch { /* ignore */ }
    }

    if (isFinal) {
      await this.writeStartupFailureReport(serverOutput, attempt, repoStructure, currentEnv);
      return { fixApplied: false };
    }

    // ── Pattern-based fast fixes (no LLM needed for known errors) ──────────────

    // Invalid .env key (space in key name or prose line) — always re-sanitize and rewrite
    const spaceKeyMatch = serverOutput.match(/line (\d+): key cannot contain a space/);
    if (spaceKeyMatch) {
      if (fs.existsSync(envPath)) {
        const fixed = sanitizeEnvContent(currentEnv);
        fs.writeFileSync(envPath, fixed, 'utf8');
        this.log('Fixed .env: sanitized key names ✓');
        return { fixApplied: true };
      }
    }

    // Missing env var (Prisma, dotenv, etc.)
    const missingVarMatch = serverOutput.match(/Environment variable not found:\s*(\w+)/i)
      ?? serverOutput.match(/Missing required env var:\s*(\w+)/i)
      ?? serverOutput.match(/process\.env\.(\w+) is (undefined|not set)/i);
    if (missingVarMatch) {
      const varName = missingVarMatch[1];
      this.log(`Detected missing env var: ${varName}`);
      const placeholder = defaultEnvValue(varName);
      const entry = `\n# Added by silly-testers (missing var detected)\n${varName}=${placeholder}\n`;
      fs.appendFileSync(envPath, entry, 'utf8');
      this.log(`Added ${varName} to .env ✓`);
      return { fixApplied: true };
    }

    // Missing node_modules
    if (/Cannot find module|MODULE_NOT_FOUND/.test(serverOutput) && !/node_modules/.test(serverOutput.match(/Cannot find module '([^']+)'/)?.[1] ?? '')) {
      this.log('Detected missing dependencies — running install...');
      const installCmd = fs.existsSync(path.join(this.repoPath, 'yarn.lock')) ? 'yarn install' : 'npm install';
      try {
        execSync(installCmd, { cwd: this.repoPath, stdio: 'inherit', timeout: 120_000 });
        return { fixApplied: true };
      } catch { /* fall through to LLM */ }
    }

    // Port already in use
    if (/EADDRINUSE|address already in use/i.test(serverOutput)) {
      const portMatch = serverOutput.match(/EADDRINUSE.*:(\d+)/);
      const port = portMatch ? parseInt(portMatch[1]) : null;
      if (port) {
        this.log(`Port ${port} in use — bumping PORT in .env`);
        const newPort = port + 1;
        const portRegex = new RegExp(`^PORT=.*$`, 'm');
        const updated = portRegex.test(currentEnv)
          ? currentEnv.replace(portRegex, `PORT=${newPort}`)
          : currentEnv + `\nPORT=${newPort}\n`;
        fs.writeFileSync(envPath, updated, 'utf8');
        return { fixApplied: true };
      }
    }

    // Ask LLM to diagnose and describe a fix
    const docs = readDocFiles(this.repoReader);
    const prompt = `You are a DevOps engineer. A development server failed to start. Attempt ${attempt} of ${maxAttempts}.

Start command: ${this.startCommand}
Working directory: ${this.repoPath}

Server output (last output before failure):
\`\`\`
${serverOutput.slice(-3000)}
\`\`\`

Current .env file:
\`\`\`
${currentEnv || '(empty or missing)'}
\`\`\`

Repository structure:
${repoStructure}
${docs ? `\nProject documentation:\n${docs}\n` : ''}

Diagnose the failure and describe ONE specific fix to apply. Choose from these fix types:

FIX_ENV: Add or update environment variable(s)
  Format: FIX_ENV
  KEY1=value1
  KEY2=value2
  END_FIX

FIX_RUN_COMMAND: Run a setup command (e.g. install deps, generate files, run migrations)
  Format: FIX_RUN_COMMAND
  <shell command>
  END_FIX

FIX_FILE: Create or overwrite a specific file
  Format: FIX_FILE path/to/file
  <file content>
  END_FIX

NO_FIX: Cannot determine a safe fix
  Format: NO_FIX
  <reason>

Respond with EXACTLY one of the above formats. No preamble.`;

    const response = await this.askLLM(prompt);
    this.log(`LLM fix suggestion:\n${response.slice(0, 200)}`);

    return this.applyFix(response);
  }

  private applyFix(response: string): { fixApplied: boolean } {
    const lines = response.trim().split('\n');
    const directive = lines[0].trim();

    try {
      if (directive === 'FIX_ENV') {
        const endIdx = lines.findIndex(l => l.trim() === 'END_FIX');
        const varLines = lines.slice(1, endIdx === -1 ? undefined : endIdx)
          .filter(l => /^[A-Z_][A-Z0-9_]*=/.test(l.trim()));

        if (varLines.length === 0) return { fixApplied: false };

        const envPath = path.join(this.repoPath, '.env');
        let existing = '';
        if (fs.existsSync(envPath)) {
          existing = fs.readFileSync(envPath, 'utf8');
        }

        // Update existing keys or append new ones
        let updated = existing;
        for (const line of varLines) {
          const key = line.split('=')[0].trim();
          const keyRegex = new RegExp(`^${key}=.*$`, 'm');
          if (keyRegex.test(updated)) {
            updated = updated.replace(keyRegex, line.trim());
          } else {
            updated += (updated.endsWith('\n') ? '' : '\n') + line.trim() + '\n';
          }
        }
        fs.writeFileSync(envPath, updated, 'utf8');
        this.log(`Applied FIX_ENV: ${varLines.map(l => l.split('=')[0]).join(', ')}`);
        return { fixApplied: true };

      } else if (directive === 'FIX_RUN_COMMAND') {
        const endIdx = lines.findIndex(l => l.trim() === 'END_FIX');
        const cmd = lines.slice(1, endIdx === -1 ? 2 : endIdx).join('\n').trim();
        if (!cmd) return { fixApplied: false };

        // Safety: only allow known safe setup commands
        const allowed = /^(npm|yarn|pnpm|npx|pip|pip3|bundle|composer|cargo|go|python|python3)\s/;
        if (!allowed.test(cmd)) {
          this.log(`Rejected unsafe FIX_RUN_COMMAND: ${cmd}`);
          return { fixApplied: false };
        }

        this.log(`Running setup command: ${cmd}`);
        execSync(cmd, { cwd: this.repoPath, stdio: 'inherit', timeout: 120_000 });
        this.log(`FIX_RUN_COMMAND completed ✓`);
        return { fixApplied: true };

      } else if (directive.startsWith('FIX_FILE')) {
        const filePath = directive.replace('FIX_FILE', '').trim();
        if (!filePath) return { fixApplied: false };

        const endIdx = lines.findIndex(l => l.trim() === 'END_FIX');
        const content = lines.slice(1, endIdx === -1 ? undefined : endIdx).join('\n');
        const absPath = path.join(this.repoPath, filePath);

        // Safety: must stay within the repo
        const rel = path.relative(this.repoPath, absPath);
        if (rel.startsWith('..')) {
          this.log(`Rejected FIX_FILE outside repo: ${filePath}`);
          return { fixApplied: false };
        }

        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content, 'utf8');
        this.log(`Applied FIX_FILE: ${filePath} ✓`);
        return { fixApplied: true };
      }
    } catch (err) {
      this.log(`Fix attempt failed: ${(err as Error).message}`);
    }

    return { fixApplied: false };
  }

  private async writeStartupFailureReport(
    serverOutput: string,
    attempts: number,
    repoStructure: string,
    currentEnv: string
  ): Promise<void> {
    this.log('Writing startup failure report...');

    const prompt = `You are a DevOps engineer writing a report about a server that failed to start after ${attempts} fix attempts.

Start command: ${this.startCommand}
Working directory: ${this.repoPath}

Final server output:
\`\`\`
${serverOutput.slice(-3000)}
\`\`\`

Current .env file:
\`\`\`
${currentEnv || '(empty or missing)'}
\`\`\`

Repository structure:
${repoStructure}

Write a concise report covering:
1. Root cause of the failure
2. What was attempted
3. What manual steps a developer should take to resolve it`;

    const analysis = await this.askLLM(prompt);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const reportPath = path.join(this.reportDir, 'devops', `startup-failure-${timestamp}.md`);

    const content = `# Startup Failure Report

**Timestamp:** ${new Date().toISOString()}
**Start Command:** ${this.startCommand}
**Working Directory:** ${this.repoPath}
**Fix Attempts:** ${attempts}

## Server Output
\`\`\`
${serverOutput.slice(-3000)}
\`\`\`

## Analysis
${analysis}

## Current .env
\`\`\`
${currentEnv || '(empty or missing)'}
\`\`\`
`;

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, content, 'utf8');
    this.log(`Startup failure report written: ${reportPath}`);

    this.report({
      title: 'Server Failed to Start After Maximum Retry Attempts',
      type: ReportType.DevOps,
      severity: Severity.Critical,
      team: Team.DEVOPS,
      url: this.targetUrl,
      summary: `Server could not be started after ${attempts} attempts. See ${reportPath} for full details.`,
      steps: [`Start command: ${this.startCommand}`, `Attempts: ${attempts}`, `See report for server output and analysis`],
      evidence: serverOutput.slice(-500),
      codeRefs: [],
      suggestedFix: analysis.split('\n').find(l => l.trim()) ?? analysis.slice(0, 200),
    });
  }

  /**
   * Main entry point — analyze the repo and produce the watchdog config + site map.
   */
  async configure(): Promise<DevOpsResult> {
    this.log('Analyzing repository for health check configuration...');

    const healthChecks = await this.discoverHealthChecks();
    const siteMap = await this.buildSiteMap();

    const watchdogConfig: WatchdogConfig = {
      startCommand: this.startCommand,
      healthChecks,
      healthCheckIntervalMs: 5_000,
      restartCommand: this.startCommand,
      maxRestartAttempts: 3,
      workingDirectory: this.repoPath,
    };

    this.writeWatchdogConfig(watchdogConfig);
    this.log(`Watchdog config written. Health checks: ${healthChecks.map((h) => h.label).join(', ')}`);

    return { watchdogConfig, siteMap };
  }

  /**
   * Recovery mode — diagnose why the server won't start and write a report.
   */
  async diagnoseFailure(error: string): Promise<void> {
    this.log('Attempting failure diagnosis...');

    const repoStructure = this.repoReader.getStructure(3);
    const prompt = `You are a DevOps engineer. A web application server has failed to restart.

Error information: ${error}

Repository structure:
${repoStructure}

Start command: ${this.startCommand}

Based on the repo structure and start command, diagnose what might have gone wrong. Consider:
1. Missing dependencies (node_modules, build artifacts)
2. Port conflicts
3. Missing environment variables
4. Database connectivity issues
5. Build errors

List the most likely causes and steps to fix them.`;

    const diagnosis = await this.askLLM(prompt);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const reportPath = path.join(this.reportDir, 'devops', `recovery-${timestamp}.md`);

    const content = `# DevOps Recovery Report

**Timestamp:** ${new Date().toISOString()}
**Start Command:** ${this.startCommand}
**Working Directory:** ${this.repoPath}
**Target URL:** ${this.targetUrl}

## Error
\`\`\`
${error}
\`\`\`

## Diagnosis
${diagnosis}

## Repository Structure
\`\`\`
${repoStructure}
\`\`\`
`;

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, content, 'utf8');
    this.log(`Recovery report written: ${reportPath}`);

    // Also file as a structured finding
    this.report({
      title: 'Server Failed to Recover After Crash',
      type: ReportType.DevOps,
      severity: Severity.Critical,
      team: Team.DEVOPS,
      url: this.targetUrl,
      summary: `The target server could not be restarted by the watchdog. Manual intervention required.`,
      steps: [
        `Start command: ${this.startCommand}`,
        `Error: ${error}`,
        `See ${reportPath} for full diagnosis`,
      ],
      evidence: diagnosis,
      codeRefs: [],
      suggestedFix: diagnosis.split('\n')[0],
    });
  }

  // ─── Health Check Discovery ────────────────────────────────────────────────

  private async discoverHealthChecks(): Promise<WatchdogConfig['healthChecks']> {
    const { hostname, port, protocol } = this.parseUrl(this.targetUrl);
    const checks: WatchdogConfig['healthChecks'] = [];

    // Check for explicit health endpoints in code
    const healthRoutes = this.repoReader.searchCode('(/health|/ping|/status|/healthz|/ready)');
    const foundPaths = [...new Set(
      healthRoutes
        .map((r) => {
          const match = r.content.match(/['"](\/(health|ping|status|healthz|ready)[^'"]*)['"]/);
          return match?.[1];
        })
        .filter(Boolean)
    )];

    if (foundPaths.length > 0) {
      checks.push({
        url: `${protocol}//${hostname}:${port}${foundPaths[0]}`,
        label: `Health endpoint (${foundPaths[0]})`,
      });
    } else {
      // Default: poll the root or a known route
      checks.push({
        url: this.targetUrl,
        label: 'Application root',
      });
    }

    // Check for multi-process setups
    const additionalPorts = await this.detectAdditionalPorts();
    for (const { port: p, label } of additionalPorts) {
      if (p !== port) {
        checks.push({
          url: `${protocol}//${hostname}:${p}`,
          label,
        });
      }
    }

    return checks;
  }

  private async detectAdditionalPorts(): Promise<Array<{ port: string; label: string }>> {
    const ports: Array<{ port: string; label: string }> = [];

    // Look for Vite/webpack dev server configs
    const viteConfig = ['vite.config.ts', 'vite.config.js', 'vite.config.mts'];
    for (const f of viteConfig) {
      if (this.repoReader.exists(f)) {
        try {
          const content = this.repoReader.readFile(f);
          const portMatch = content.match(/port:\s*(\d+)/);
          if (portMatch) {
            ports.push({ port: portMatch[1], label: 'Vite dev server' });
          } else {
            ports.push({ port: '5173', label: 'Vite dev server (default)' });
          }
        } catch {
          ports.push({ port: '5173', label: 'Vite dev server (default)' });
        }
        break;
      }
    }

    // Check package.json for proxy/dev-server port hints
    if (this.repoReader.exists('package.json')) {
      try {
        const pkg = JSON.parse(this.repoReader.readFile('package.json'));
        if (pkg.proxy) {
          try {
            const proxyUrl = new URL(pkg.proxy as string);
            ports.push({ port: proxyUrl.port || '3000', label: 'API proxy target' });
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    }

    return ports;
  }

  // ─── SiteMap Building ─────────────────────────────────────────────────────

  private async buildSiteMap(): Promise<SiteMap> {
    const routes: Route[] = [];

    // Pull from static analysis
    const routeResults = this.repoReader.searchCode(
      "(app\\.(get|post|put|delete|patch)|router\\.(get|post|put|delete|patch)|@(Get|Post|Put|Delete|Patch))"
    );

    const routePatterns = routeResults
      .map((r) => {
        const match = r.content.match(/['"](\/[^'"]+)['"]/);
        return match ? { path: match[1], method: undefined, description: r.file } : null;
      })
      .filter(Boolean) as Route[];

    routes.push(...routePatterns);

    // Also crawl the live site briefly to find actual navigable pages
    try {
      await this.navigate(this.targetUrl);
      const links = await this.getPageLinks();
      const liveRoutes: Route[] = links.map((link) => {
        try {
          const { pathname } = new URL(link);
          return { path: pathname };
        } catch {
          return { path: link };
        }
      });
      routes.push(...liveRoutes);
    } catch {
      // if site isn't up yet, that's fine — routes from static analysis are enough
    }

    const { origin, hostname, protocol } = this.parseUrl(this.targetUrl);
    const uniqueRoutes = this.dedupeRoutes(routes);

    // Build the full allowed-origins list: main URL + every additional port the app uses
    // (API servers, Vite dev server, HMR websocket, etc.)
    const allowedOrigins = new Set<string>([origin]);
    const additionalPorts = await this.detectAdditionalPorts();
    for (const { port, label } of additionalPorts) {
      const extraOrigin = `${protocol}//${hostname}:${port}`;
      if (!allowedOrigins.has(extraOrigin)) {
        allowedOrigins.add(extraOrigin);
        this.log(`Allowing additional origin: ${extraOrigin} (${label})`);
      }
    }

    return {
      allowedOrigins: [...allowedOrigins],
      routes: uniqueRoutes,
      entryUrl: this.targetUrl,
    };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private parseUrl(url: string): { hostname: string; port: string; protocol: string; origin: string } {
    try {
      const u = new URL(url);
      return {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? '443' : '80'),
        protocol: u.protocol,
        origin: u.origin,
      };
    } catch {
      return { hostname: 'localhost', port: '3000', protocol: 'http:', origin: url };
    }
  }

  private dedupeRoutes(routes: Route[]): Route[] {
    const seen = new Set<string>();
    return routes.filter((r) => {
      if (seen.has(r.path)) return false;
      seen.add(r.path);
      return true;
    });
  }

  private writeWatchdogConfig(config: WatchdogConfig): void {
    const outputPath = path.join(this.reportDir, 'watchdog.config.json');
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(config, null, 2), 'utf8');
  }
}

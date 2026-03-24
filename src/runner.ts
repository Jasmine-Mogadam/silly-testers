import { spawn, execSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Config } from './core/types';
import { Team, SystemEvent } from './core/types';
import { BrowserPool } from './core/browser';
import { OllamaClient } from './core/llm';
import { getTeamChannel, SystemChannel, resetChannels } from './core/channel';
import { RepoReader } from './core/repo-reader';
import { Watchdog } from './watchdog';
import { DevOpsAgent, discoverTargetConfig } from './agents/devops-agent';
import { QACoordinator } from './agents/qa/qa-coordinator';
import { RedCoordinator } from './agents/red-team/red-coordinator';
import { WebBridge } from './web/web-bridge';
import { WebServer } from './web/web-server';
import { ReporterBridge } from './web/reporter-bridge';
import type { SiteMap, WatchdogConfig, DiscoveredTarget } from './core/types';

export interface RunnerOptions {
  configPath: string;
  team: 'qa' | 'red' | 'both';
  dryRun: boolean;
  clean: boolean;
}

export class Runner {
  private config: Config;
  private options: RunnerOptions;
  private discovered: DiscoveredTarget | null = null;
  private workingDir: string | null = null;
  private serverProcess: ChildProcess | null = null;
  private serverOutputLines: string[] = [];
  private watchdog: Watchdog | null = null;
  private browserPool: BrowserPool | null = null;
  private qaCoordinator: QACoordinator | null = null;
  private redCoordinator: RedCoordinator | null = null;
  private activeCrashIncident: { announcedAt: number; recentOutput: string } | null = null;
  private systemChannel = SystemChannel.getInstance();
  private webServer: WebServer | null = null;
  private readonly reusableWorkDir: string;
  private readonly composeProjectName: string;

  constructor(config: Config, options: RunnerOptions) {
    this.config = config;
    this.options = options;
    this.reusableWorkDir = resolveReusableWorkDir(config.target.repo);
    this.composeProjectName = buildComposeProjectName(config.target.repo);
  }

  async run(): Promise<void> {
    const { config } = this;
    resetChannels();

    console.log('[runner] Initializing silly-testers...');

    // 1. Eagerly create all team channels so the bridge captures everything,
    //    including early DevOps messages before QA/Red are spawned.
    const devopsChannel = getTeamChannel(Team.DEVOPS);
    const qaChannel = getTeamChannel(Team.QA);
    const redChannel = getTeamChannel(Team.RED);

    // 2. Start web UI (if enabled)
    if (config.web.enabled) {
      const bridge = WebBridge.init();
      bridge.attach(devopsChannel, qaChannel, redChannel, this.systemChannel);
      this.webServer = new WebServer(bridge);
      const publicDir = path.resolve(__dirname, 'web/public');
      const webUrl = await this.webServer.start(config.web.port, publicDir);
      // OSC 8 hyperlink — ctrl+clickable in VSCode terminal, iTerm2, Warp, etc.
      const link = `\x1b]8;;${webUrl}\x1b\\${webUrl}\x1b]8;;\x1b\\`;
      console.log(`[runner] Web UI ready → ${link}`);
    }

    // 3. Check Ollama connectivity
    const llm = new OllamaClient(config.ollama);
    const ollamaHealth = await llm.healthCheck();
    if (!ollamaHealth.ok) {
      throw new Error(`Cannot reach Ollama at ${config.ollama.endpoint}. Is it running?`);
    }
    if (ollamaHealth.missing.length > 0) {
      console.warn(`[runner] Warning: Missing Ollama models: ${ollamaHealth.missing.join(', ')}`);
      console.warn('[runner] Run: ollama pull ' + ollamaHealth.missing.join(' && ollama pull '));
    }

    console.log('[runner] Warming up Ollama text model...');
    try {
      await llm.warmup();
    } catch (err) {
      console.warn('[runner] Ollama warm-up failed; continuing with normal retries:', (err as Error).message);
    }

    // Give the bridge access to the LLM so it can summarize long agent logs
    WebBridge.getInstanceIfExists()?.setLlm(llm);
    WebBridge.getInstanceIfExists()?.setLlmModel(config.ollama.textModel);

    // 2. Create a working copy of the repo — the original is NEVER modified
    if (this.options.clean) {
      console.log('[runner] --clean requested. Removing reusable working copy and Docker resources...');
      await this.down();
    }

    console.log('[runner] Creating working copy of repository...');
    this.workingDir = await this.prepareWorkingDirectory(config.target.repo);
    console.log(`[runner] Working copy ready: ${this.workingDir}`);

    // RepoReader for QA/Red agents always points at the original (read-only source of truth)
    const repoReader = new RepoReader(config.target.repo);

    // 3. DevOps static discovery — runs against the working copy so it can write .env etc.
    console.log('[runner] DevOps agent analyzing repository...');
    this.discovered = await discoverTargetConfig(
      this.workingDir,
      llm,
      (msg) => WebBridge.getInstanceIfExists()?.agentLog('devops-0', msg),
    );

    // 4. Init browser pool (no sitemap yet — sandbox will be set after configure())
    this.browserPool = new BrowserPool(config.browser);
    await this.browserPool.init();

    // 5. Start server with DevOps-assisted retry loop
    const reporter = new ReporterBridge(this.resolveReportDir());
    const devopsSiteMap: SiteMap = {
      allowedOrigins: [this.discovered.url],
      routes: [],
      entryUrl: this.discovered.url,
      qaGuidance: '',
    };
    const { page: devopsPage, context: devopsContext } = await this.browserPool.acquirePage();

    const devopsAgent = new DevOpsAgent({
      id: 'devops-0',
      team: Team.DEVOPS,
      llm,
      teamChannel: devopsChannel,
      systemChannel: this.systemChannel,
      reporter,
      repoReader,
      siteMap: devopsSiteMap,
      page: devopsPage,
      context: devopsContext,
      repoPath: this.workingDir,
      discovered: this.discovered,
      reportDir: this.resolveReportDir(),
    });

    await this.startServerWithRetry(devopsAgent, config.runner.serverStartTimeoutMs, config.runner.startupRetries);

    // 6. DevOps browser-based configure (server is confirmed up at this point)
    const { watchdogConfig, siteMap } = await devopsAgent.configure();
    await this.browserPool.releasePage(devopsContext);

    // Update allowed preview origins now that we know the real site map
    WebBridge.getInstanceIfExists()?.allowedPreviewOrigins.push(...siteMap.allowedOrigins);

    if (this.options.dryRun) {
      console.log('[runner] Dry run complete. Config looks good.');
      console.log('[runner] Site map:', JSON.stringify(siteMap, null, 2));
      console.log('[runner] Watchdog config:', JSON.stringify(watchdogConfig, null, 2));
      await this.cleanup();
      return;
    }

    // Reinit browser pool with proper sandbox origins
    await this.browserPool.close();
    this.browserPool = new BrowserPool(config.browser);
    await this.browserPool.init(siteMap);

    // 7. Start watchdog
    this.watchdog = new Watchdog(watchdogConfig);
    this.setupWatchdogHandlers(watchdogConfig, siteMap, llm, reporter, repoReader, devopsAgent);
    this.watchdog.start();

    // 8. Spawn coordinators
    if (this.options.team === 'qa' || this.options.team === 'both') {
      this.qaCoordinator = await this.spawnQA(llm, reporter, repoReader, siteMap);
    }

    if (this.options.team === 'red' || this.options.team === 'both') {
      this.redCoordinator = await this.spawnRed(llm, reporter, repoReader, siteMap);
    }

    console.log('[runner] All agents running. Press Ctrl+C to stop.');

    // 9. Wait for max duration or SIGINT
    await this.waitForCompletion();
    await this.cleanup();
  }

  // ─── Server Management ────────────────────────────────────────────────────

  /**
   * Attempts to start the server, invoking the DevOps agent to diagnose and
   * apply fixes on each failure. Throws only after maxRetries is exhausted
   * (by which point the DevOps agent has already written a failure report).
   */
  private async startServerWithRetry(
    devopsAgent: DevOpsAgent,
    timeoutMs: number,
    maxRetries: number
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      console.log(`[runner] Starting server (attempt ${attempt}/${maxRetries}): ${this.discovered!.startCommand}`);
      this.serverOutputLines = [];
      this.serverProcess = this.spawnServer();

      const started = await this.pollForServer(this.discovered!.url, timeoutMs);

      if (started) {
        console.log('[runner] Server is up!');
        return;
      }

      // Server didn't come up — kill it and let DevOps diagnose
      this.killServer();
      const output = this.serverOutputLines.join('');

      const { fixApplied } = await devopsAgent.diagnoseStartupFailure(output, attempt, maxRetries);

      if (!fixApplied && attempt < maxRetries) {
        console.log('[runner] No fix could be applied — retrying anyway...');
      }

      if (attempt === maxRetries) {
        throw new Error(`Server failed to start after ${maxRetries} attempts. See reports/devops/ for the failure report.`);
      }

      await sleep(3_000);
    }
  }

  private spawnServer(): ChildProcess {
    // Pass the full command string to shell=true — splitting breaks multi-word commands
    // like "yarn workspace @pkg/server dev" or "npm run dev -- --port 4000"
    const proc = spawn(this.discovered!.startCommand, {
      cwd: this.workingDir!,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      detached: false,
      env: {
        ...process.env,
        COMPOSE_PROJECT_NAME: this.composeProjectName,
      },
    });

    const pushLine = (data: Buffer) => {
      const text = data.toString();
      process.stdout.write(`[server] ${text}`);
      // Keep last 500 lines for DevOps agent diagnostics
      this.serverOutputLines.push(text);
      if (this.serverOutputLines.length > 500) this.serverOutputLines.shift();
    };

    proc.stdout?.on('data', pushLine);
    proc.stderr?.on('data', pushLine);
    proc.on('exit', (code) => {
      if (code !== null && code !== 0) {
        console.log(`[runner] Server process exited with code ${code}`);
      }
    });

    return proc;
  }

  /** Returns true if the server responds before the deadline, false otherwise. */
  private async pollForServer(url: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
        if (res.status < 500) return true;
      } catch {
        // not ready yet
      }
      await sleep(2_000);
    }

    return false;
  }

  private killServer(): void {
    if (this.serverProcess && !this.serverProcess.killed) {
      this.serverProcess.kill('SIGTERM');
      this.serverProcess = null;
    }
  }

  // ─── Watchdog Handlers ────────────────────────────────────────────────────

  private setupWatchdogHandlers(
    watchdogConfig: WatchdogConfig,
    siteMap: SiteMap,
    llm: OllamaClient,
    reporter: ReporterBridge,
    repoReader: RepoReader,
    devopsAgent: DevOpsAgent
  ): void {
    this.watchdog!.onUnhealthy((status) => {
      const down = status.checks.filter((c) => !c.up).map((c) => c.label).join(', ');
      console.log(`[runner] Site DOWN — ${down}. Pausing all agents...`);
      const recentOutput = this.serverOutputLines.join('');
      this.activeCrashIncident = {
        announcedAt: Date.now(),
        recentOutput,
      };
      devopsAgent.announceCrashIncident(status, recentOutput);
      this.systemChannel.broadcast({
        event: SystemEvent.SiteDown,
        detail: `Server down: ${down}`,
        healthStatus: status,
      });
    });

    this.watchdog!.onHealthy((status) => {
      console.log('[runner] Site UP — resuming all agents...');
      if (this.activeCrashIncident) {
        devopsAgent.announceCrashRecovery(status, this.activeCrashIncident.recentOutput);
        this.activeCrashIncident = null;
      }
      this.systemChannel.broadcast({
        event: SystemEvent.SiteUp,
        detail: 'Server recovered — resume testing. Be aware the site was recently down.',
        healthStatus: status,
      });
    });

    this.watchdog!.onGiveUp(async (error) => {
      console.error('[runner] Watchdog gave up. Halting agents and running recovery...');
      this.activeCrashIncident = null;

      this.systemChannel.broadcast({ event: SystemEvent.SiteDown, detail: 'Unrecoverable server failure' });

      // Wake DevOps agent for diagnosis
      try {
        const { page, context } = await this.browserPool!.acquirePage();
        const devopsChannel = getTeamChannel(Team.DEVOPS);
        const devopsAgent = new DevOpsAgent({
          id: 'devops-recovery',
          team: Team.DEVOPS,
          llm,
          teamChannel: devopsChannel,
          systemChannel: this.systemChannel,
          reporter,
          repoReader,
          siteMap,
          page,
          context,
          repoPath: this.workingDir!,
          discovered: this.discovered!,
          reportDir: this.resolveReportDir(),
        });

        await devopsAgent.diagnoseFailure(error);
        await this.browserPool!.releasePage(context);
      } catch (diagErr) {
        console.error('[runner] DevOps diagnosis also failed:', diagErr);
      }

      console.error('[runner] Cannot recover. Shutting down.');
      await this.cleanup();
      process.exit(1);
    });
  }

  // ─── Agent Spawning ────────────────────────────────────────────────────────

  private async spawnQA(
    llm: OllamaClient,
    reporter: ReporterBridge,
    repoReader: RepoReader,
    siteMap: SiteMap
  ): Promise<QACoordinator> {
    const { page, context } = await this.browserPool!.acquirePage();
    const channel = getTeamChannel(Team.QA);

    const coordinator = new QACoordinator({
      id: 'qa-coordinator',
      team: Team.QA,
      llm,
      teamChannel: channel,
      systemChannel: this.systemChannel,
      reporter,
      repoReader,
      siteMap,
      page,
      context,
      featureListPath: this.resolveFeatureList(),
      featureTesterCount: this.config.agents.qa.featureTesters,
      playTesterCount: this.config.agents.qa.playTesters,
      goalIntervalMs: this.config.runner.playTesterGoalIntervalMs,
      browserPool: this.browserPool!,
    });

    coordinator.run().catch((err) => console.error('[qa-coordinator] Error:', err));
    return coordinator;
  }

  private async spawnRed(
    llm: OllamaClient,
    reporter: ReporterBridge,
    repoReader: RepoReader,
    siteMap: SiteMap
  ): Promise<RedCoordinator> {
    const { page, context } = await this.browserPool!.acquirePage();
    const channel = getTeamChannel(Team.RED);

    const coordinator = new RedCoordinator({
      id: 'red-coordinator',
      team: Team.RED,
      llm,
      teamChannel: channel,
      systemChannel: this.systemChannel,
      reporter,
      repoReader,
      siteMap,
      page,
      context,
      reconCount: this.config.agents.redTeam.recon,
      exploitCount: this.config.agents.redTeam.exploit,
      browserPool: this.browserPool!,
    });

    coordinator.run().catch((err) => console.error('[red-coordinator] Error:', err));
    return coordinator;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  private async waitForCompletion(): Promise<void> {
    return new Promise((resolve) => {
      const maxDuration = this.config.runner.maxRunDurationMs;

      if (maxDuration > 0) {
        setTimeout(resolve, maxDuration);
      }

      process.once('SIGINT', () => {
        console.log('\n[runner] Received SIGINT — shutting down...');
        resolve();
      });

      process.once('SIGTERM', () => {
        console.log('\n[runner] Received SIGTERM — shutting down...');
        resolve();
      });
    });
  }

  async cleanup(): Promise<void> {
    console.log('[runner] Cleaning up...');

    this.watchdog?.stop();
    this.qaCoordinator?.stop();
    this.redCoordinator?.stop();

    await this.browserPool?.close().catch(() => {});

    this.killServer();
    this.webServer?.stop();
    WebBridge.reset();

    if (this.workingDir) {
      this.workingDir = null;
    }

    console.log('[runner] Cleanup complete. Reports are in:', this.resolveReportDir());
  }

  /**
   * Copies the original repo to a temp directory so the DevOps agent can write
   * .env files, run installs, etc. without touching the user's source tree.
   *
   * Excludes node_modules, .git, and common build artifact directories.
   */
  private async prepareWorkingDirectory(originalRepo: string): Promise<string> {
    const tmpBase = path.join(os.tmpdir(), 'silly-testers');
    fs.mkdirSync(tmpBase, { recursive: true });
    const workDir = this.reusableWorkDir;

    const EXCLUDED = new Set(['node_modules', '.git', 'dist', '.next', 'build', '__pycache__', '.cache', 'coverage', '.turbo']);

    fs.rmSync(workDir, { recursive: true, force: true });

    fs.cpSync(originalRepo, workDir, {
      recursive: true,
      filter: (src: string) => !EXCLUDED.has(path.basename(src)),
    });

    // Install dependencies in the working copy so the server can actually run
    const hasYarnLock = fs.existsSync(path.join(workDir, 'yarn.lock'));
    const hasPnpmLock = fs.existsSync(path.join(workDir, 'pnpm-lock.yaml'));
    const installCmd = hasPnpmLock ? 'pnpm install' : hasYarnLock ? 'yarn install' : 'npm install';

    console.log(`[runner] Installing dependencies in working copy (${installCmd})...`);
    try {
      execSync(installCmd, { cwd: workDir, stdio: 'inherit', timeout: 300_000 });
    } catch (err) {
      console.warn('[runner] Dependency install failed — will retry during startup:', (err as Error).message);
    }

    return workDir;
  }

  async down(): Promise<void> {
    const composeDir = this.resolveComposeDirectory();
    const composeFile = composeDir ? findComposeFile(composeDir) : null;

    if (composeDir && composeFile) {
      const relativeComposeFile = path.relative(composeDir, composeFile);
      console.log(`[runner] Running docker compose down for project "${this.composeProjectName}"...`);
      try {
        execSync(`docker compose -f "${relativeComposeFile}" down --remove-orphans`, {
          cwd: composeDir,
          stdio: 'inherit',
          env: {
            ...process.env,
            COMPOSE_PROJECT_NAME: this.composeProjectName,
          },
          timeout: 300_000,
        });
      } catch (err) {
        console.warn('[runner] docker compose down failed:', (err as Error).message);
      }
    } else {
      console.log('[runner] No docker compose file found in reusable working copy or target repo. Skipping docker cleanup.');
    }

    try {
      fs.rmSync(this.reusableWorkDir, { recursive: true, force: true });
      console.log('[runner] Reusable working copy deleted.');
    } catch (err) {
      console.warn('[runner] Could not delete reusable working copy:', err);
    }
  }

  private resolveReportDir(): string {
    return path.resolve(path.dirname(this.options.configPath), this.config.reports.outputDir);
  }

  private resolveFeatureList(): string {
    return path.resolve(path.dirname(this.options.configPath), this.config.target.featureList);
  }

  private resolveComposeDirectory(): string | null {
    const candidates = [this.reusableWorkDir, this.config.target.repo];
    for (const candidate of candidates) {
      if (!candidate || !fs.existsSync(candidate)) continue;
      if (findComposeFile(candidate)) return candidate;
    }
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function resolveReusableWorkDir(originalRepo: string): string {
  const repoName = sanitizeName(path.basename(originalRepo));
  const hash = shortHash(path.resolve(originalRepo));
  return path.join(os.tmpdir(), 'silly-testers', `${repoName}-${hash}`);
}

function buildComposeProjectName(originalRepo: string): string {
  const repoName = sanitizeName(path.basename(originalRepo));
  const hash = shortHash(path.resolve(originalRepo));
  return `silly-testers-${repoName}-${hash}`.slice(0, 63);
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function findComposeFile(dir: string): string | null {
  for (const file of ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml']) {
    const fullPath = path.join(dir, file);
    if (fs.existsSync(fullPath)) return fullPath;
  }
  return null;
}

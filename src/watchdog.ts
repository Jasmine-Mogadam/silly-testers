import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import type { WatchdogConfig, HealthStatus } from './core/types';

export type WatchdogEvent = 'healthy' | 'unhealthy' | 'give-up';

/**
 * Code-only (no AI) server health monitor.
 *
 * Polls all configured health check URLs on a fixed interval.
 * The server is healthy only when ALL checks pass.
 *
 * On failure:
 *  1. Emits 'unhealthy' with details of which services are down
 *  2. Attempts restart via restartCommand
 *  3. If healthy after restart → emits 'healthy'
 *  4. After maxRestartAttempts failures → emits 'give-up'
 */
export class Watchdog extends EventEmitter {
  private config: WatchdogConfig;
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;
  private consecutiveFailures = 0;
  private restartAttempts = 0;
  private isRestarting = false;
  private lastStatus: HealthStatus | null = null;

  constructor(config: WatchdogConfig) {
    super();
    this.config = config;
    this.setMaxListeners(20);
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.log('Watchdog started.');
    this.scheduleCheck();
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log('Watchdog stopped.');
  }

  onHealthy(cb: (status: HealthStatus) => void): this {
    return this.on('healthy', cb);
  }

  onUnhealthy(cb: (status: HealthStatus) => void): this {
    return this.on('unhealthy', cb);
  }

  onGiveUp(cb: (error: string) => void): this {
    return this.on('give-up', cb);
  }

  /** Force an immediate health check (used after initial server start). */
  async checkNow(): Promise<HealthStatus> {
    return this.performHealthCheck();
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private scheduleCheck(): void {
    if (!this.isRunning) return;
    this.timer = setTimeout(() => this.tick(), this.config.healthCheckIntervalMs);
  }

  private async tick(): Promise<void> {
    if (!this.isRunning || this.isRestarting) {
      this.scheduleCheck();
      return;
    }

    const status = await this.performHealthCheck();
    this.lastStatus = status;

    if (status.healthy) {
      if (this.consecutiveFailures > 0) {
        this.consecutiveFailures = 0;
        this.restartAttempts = 0;
        this.log('Server is healthy.');
        this.emit('healthy', status);
      }
    } else {
      this.consecutiveFailures++;

      const downServices = status.checks
        .filter((c) => !c.up)
        .map((c) => `${c.label} (${c.url})`)
        .join(', ');

      this.log(`Health check failed. Down: ${downServices}`);

      if (this.consecutiveFailures === 1) {
        // First failure — notify listeners once so agents can pause promptly.
        this.emit('unhealthy', status);
      }

      await this.attemptRestart();
    }

    this.scheduleCheck();
  }

  private async performHealthCheck(): Promise<HealthStatus> {
    const results = await Promise.all(
      this.config.healthChecks.map(async (check) => {
        try {
          const res = await fetch(check.url, {
            signal: AbortSignal.timeout(5_000),
            // No redirects — if the server is down, it won't redirect
          });
          return { label: check.label, url: check.url, up: res.ok || res.status < 500 };
        } catch (err) {
          return {
            label: check.label,
            url: check.url,
            up: false,
            error: (err as Error).message,
          };
        }
      })
    );

    return {
      healthy: results.every((r) => r.up),
      checks: results,
    };
  }

  private async attemptRestart(): Promise<void> {
    if (this.restartAttempts >= this.config.maxRestartAttempts) {
      const summary = this.buildFailureSummary();
      this.log(`Giving up after ${this.restartAttempts} restart attempts.`);
      this.emit('give-up', summary);
      this.stop();
      return;
    }

    this.isRestarting = true;
    this.restartAttempts++;
    this.log(`Restart attempt ${this.restartAttempts}/${this.config.maxRestartAttempts}...`);

    try {
      await this.runCommand(this.config.restartCommand);
      // Wait for server to come up
      await sleep(5_000);

      const status = await this.performHealthCheck();
      this.lastStatus = status;
      if (status.healthy) {
        this.consecutiveFailures = 0;
        this.restartAttempts = 0;
        this.log('Server recovered after restart.');
        this.emit('healthy', status);
      } else {
        this.log(`Server still unhealthy after restart ${this.restartAttempts}.`);
        if (this.restartAttempts >= this.config.maxRestartAttempts) {
          const summary = this.buildFailureSummary();
          this.log(`Giving up after ${this.restartAttempts} restart attempts.`);
          this.emit('give-up', summary);
          this.stop();
        }
        // Will retry on next tick
      }
    } catch (err) {
      this.log(`Restart command failed: ${(err as Error).message}`);
    } finally {
      this.isRestarting = false;
    }
  }

  private runCommand(command: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const [cmd, ...args] = command.split(' ');
      const proc = spawn(cmd, args, {
        cwd: this.config.workingDirectory,
        detached: true,
        stdio: 'ignore',
        shell: true,
      });

      proc.unref();

      // We don't wait for the process to exit — it's a long-running server
      // Just give it a moment to start
      setTimeout(resolve, 2_000);

      proc.on('error', reject);
    });
  }

  private buildFailureSummary(): string {
    const checks = this.lastStatus?.checks ?? [];
    const down = checks.filter((c) => !c.up);
    const details = down.map((c) => `${c.label}: ${c.error ?? 'no response'}`).join('; ');
    return `Failed after ${this.restartAttempts} restart attempts. Down services: ${details || 'unknown'}`;
  }

  private log(msg: string): void {
    console.log(`[${new Date().toISOString().slice(11, 19)}][watchdog] ${msg}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

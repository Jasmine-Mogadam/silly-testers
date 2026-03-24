import * as vm from 'vm';
import type { SiteMap } from './types';

const MAX_RESPONSE_BODY_CHARS = 8_000;
const MAX_SCRIPT_SOURCE_CHARS = 20_000;
const MAX_REDIRECTS = 5;
const DEFAULT_SCRIPT_TIMEOUT_MS = 5_000;

export interface AttackRequestSpec {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface AttackResponseSummary {
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  redirectChain: string[];
}

export interface AttackScriptResult {
  logs: string[];
  result: string;
}

export interface RunAttackScriptSpec {
  name?: string;
  code?: string;
  input?: unknown;
}

export class AttackWorkbench {
  private readonly allowedOrigins: Set<string>;
  private readonly scripts = new Map<string, string>();

  constructor(private readonly siteMap: SiteMap) {
    this.allowedOrigins = new Set(
      siteMap.allowedOrigins
        .map((origin) => {
          try {
            return new URL(origin).origin;
          } catch {
            return null;
          }
        })
        .filter((origin): origin is string => !!origin)
    );
  }

  listScripts(): string[] {
    return [...this.scripts.keys()].sort();
  }

  saveScript(name: string, code: string): void {
    const normalizedName = name.trim().slice(0, 80);
    const normalizedCode = code.trim();

    if (!normalizedName) {
      throw new Error('Script name is required');
    }
    if (!normalizedCode) {
      throw new Error('Script source is required');
    }
    if (normalizedCode.length > MAX_SCRIPT_SOURCE_CHARS) {
      throw new Error(`Script exceeds ${MAX_SCRIPT_SOURCE_CHARS} characters`);
    }

    this.scripts.set(normalizedName, normalizedCode);
  }

  async request(spec: AttackRequestSpec): Promise<AttackResponseSummary> {
    const method = (spec.method ?? 'GET').toUpperCase();
    let currentUrl = this.resolveAllowedUrl(spec.url);
    let currentMethod = method;
    let currentBody = spec.body;
    const headers = this.normalizeHeaders(spec.headers);
    const redirectChain: string[] = [];

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
      const response = await fetch(currentUrl, {
        method: currentMethod,
        headers,
        body: this.shouldAllowBody(currentMethod) ? currentBody : undefined,
        redirect: 'manual',
      });

      const responseHeaders = this.headersToObject(response.headers);
      const responseBody = truncate(await response.text(), MAX_RESPONSE_BODY_CHARS);

      if (!this.isRedirect(response.status) || !responseHeaders.location) {
        return {
          url: currentUrl,
          status: response.status,
          statusText: response.statusText,
          headers: responseHeaders,
          body: responseBody,
          redirectChain,
        };
      }

      if (redirectCount === MAX_REDIRECTS) {
        throw new Error(`Redirect limit exceeded for ${currentUrl}`);
      }

      redirectChain.push(currentUrl);
      currentUrl = this.resolveAllowedUrl(new URL(responseHeaders.location, currentUrl).toString());

      if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET';
        currentBody = undefined;
      }
    }

    throw new Error('Unexpected redirect handling state');
  }

  async runScript(spec: RunAttackScriptSpec): Promise<AttackScriptResult> {
    const source = this.getScriptSource(spec);
    const logs: string[] = [];

    const sandbox: Record<string, unknown> = {
      URL,
      URLSearchParams,
      baseUrl: this.siteMap.entryUrl,
      allowedOrigins: [...this.allowedOrigins],
      input: spec.input ?? null,
      request: async (requestSpec: AttackRequestSpec) => this.request(requestSpec),
      sleep: (ms: number) => sleep(Math.max(0, Math.min(ms, 5_000))),
      console: {
        log: (...args: unknown[]) => {
          logs.push(args.map((arg) => this.stringifyValue(arg)).join(' '));
        },
      },
    };
    sandbox.globalThis = sandbox;

    const context = vm.createContext(sandbox, {
      name: 'attack-workbench',
      codeGeneration: {
        strings: false,
        wasm: false,
      },
    });

    const wrappedSource = `(async () => {\n${source}\n})()`;
    const script = new vm.Script(wrappedSource, {
      filename: spec.name ?? 'attack-workbench.js',
    });

    const execution = script.runInContext(context) as Promise<unknown>;
    const result = await withTimeout(execution, DEFAULT_SCRIPT_TIMEOUT_MS);

    return {
      logs,
      result: this.stringifyValue(result),
    };
  }

  private getScriptSource(spec: RunAttackScriptSpec): string {
    if (spec.code?.trim()) {
      return spec.code.trim();
    }
    if (spec.name) {
      const saved = this.scripts.get(spec.name);
      if (!saved) {
        throw new Error(`Unknown saved script: ${spec.name}`);
      }
      return saved;
    }
    throw new Error('Script name or inline code is required');
  }

  private resolveAllowedUrl(url: string): string {
    const resolved = new URL(url, this.siteMap.entryUrl);
    if (!['http:', 'https:'].includes(resolved.protocol)) {
      throw new Error(`Disallowed protocol for workbench request: ${resolved.protocol}`);
    }
    if (!this.allowedOrigins.has(resolved.origin)) {
      throw new Error(`Blocked request outside sandbox: ${resolved.toString()}`);
    }
    return resolved.toString();
  }

  private shouldAllowBody(method: string): boolean {
    return !['GET', 'HEAD'].includes(method);
  }

  private isRedirect(status: number): boolean {
    return [301, 302, 303, 307, 308].includes(status);
  }

  private normalizeHeaders(headers?: Record<string, string>): Record<string, string> {
    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
      const cleanKey = key.trim();
      if (!cleanKey) continue;
      normalized[cleanKey] = String(value);
    }
    return normalized;
  }

  private headersToObject(headers: Headers): Record<string, string> {
    const result: Record<string, string> = {};
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }

  private stringifyValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === undefined) return 'undefined';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Script timed out after ${timeoutMs}ms`)), timeoutMs);
    }),
  ]);
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated]` : text;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

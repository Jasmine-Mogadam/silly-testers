import type { OllamaConfig } from './types';

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  system?: string;
  onRetryUpdate?: (event: RetryUpdate) => void;
}

export interface RetryUpdate {
  state: 'retrying' | 'failed' | 'succeeded';
  attempt: number;
  total: number;
  operation: string;
  details: string;
}

export class OllamaClient {
  private endpoint: string;
  private textModel: string;
  private visionModel: string;
  private timeoutMs: number;

  constructor(config: OllamaConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.textModel = config.textModel;
    this.visionModel = config.visionModel;
    this.timeoutMs = config.timeoutMs;
  }

  /**
   * Send a text prompt and return the model's response.
   */
  async complete(prompt: string, opts: CompletionOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.textModel,
      prompt: opts.system ? `${opts.system}\n\n${prompt}` : prompt,
      stream: false,
    };

    if (opts.temperature !== undefined || opts.maxTokens !== undefined) {
      body['options'] = {
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { num_predict: opts.maxTokens } : {}),
      };
    }

    return this.request('/api/generate', body, 'text completion', opts.onRetryUpdate);
  }

  /**
   * Analyze a screenshot (base64 PNG) with the vision model.
   */
  async vision(imageBase64: string, prompt: string, opts: CompletionOptions = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.visionModel,
      prompt: opts.system ? `${opts.system}\n\n${prompt}` : prompt,
      images: [imageBase64],
      stream: false,
    };

    return this.request('/api/generate', body, 'vision completion', opts.onRetryUpdate);
  }

  /**
   * Check that the Ollama server is reachable and the required models are available.
   */
  async healthCheck(): Promise<{ ok: boolean; missing: string[] }> {
    try {
      const res = await fetch(`${this.endpoint}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });

      if (!res.ok) return { ok: false, missing: [] };

      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const available = (data.models ?? []).map((m) => m.name);

      const required = [this.textModel, this.visionModel];
      const missing = required.filter(
        (m) => !available.some((a) => a === m || a.startsWith(`${m}:`))
      );

      return { ok: true, missing };
    } catch {
      return { ok: false, missing: [] };
    }
  }

  private async request(
    path: string,
    body: Record<string, unknown>,
    operation: string,
    onRetryUpdate?: (event: RetryUpdate) => void,
  ): Promise<string> {
    const url = `${this.endpoint}${path}`;
    let lastError: Error | undefined;
    let lastFailureDetails = '';

    for (let attempt = 0; attempt < 3; attempt++) {
      const startedAt = Date.now();
      let timedOut = false;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, this.timeoutMs);

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`Ollama HTTP ${res.status}: ${text}`);
        }

        const data = (await res.json()) as { response: string };
        if (attempt > 0) {
          onRetryUpdate?.({
            state: 'succeeded',
            attempt: attempt + 1,
            total: 3,
            operation,
            details: `Recovered after ${attempt + 1} attempts. operation=${operation}, model=${String(body.model ?? 'unknown')}, endpoint=${path}, elapsed=${Date.now() - startedAt}ms`,
          });
        }
        return data.response.trim();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        lastFailureDetails = this.describeFailure(lastError, {
          operation,
          path,
          model: String(body.model ?? 'unknown'),
          timeoutMs: this.timeoutMs,
          elapsedMs: Date.now() - startedAt,
          promptPreview: this.buildPromptPreview(body),
          imageCount: Array.isArray(body.images) ? body.images.length : 0,
          timedOut,
        });

        if (attempt < 2) {
          onRetryUpdate?.({
            state: 'retrying',
            attempt: attempt + 2,
            total: 3,
            operation,
            details: lastFailureDetails,
          });
        } else {
          onRetryUpdate?.({
            state: 'failed',
            attempt: 3,
            total: 3,
            operation,
            details: lastFailureDetails,
          });
        }

        if (attempt < 2) {
          await sleep(1_000 * (attempt + 1));
        }
      }
    }

    throw new Error(`Ollama request failed after 3 attempts. ${lastFailureDetails || lastError?.message}`);
  }

  private buildPromptPreview(body: Record<string, unknown>): string {
    const prompt = typeof body.prompt === 'string' ? body.prompt : '';
    return prompt
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160);
  }

  private describeFailure(
    error: Error,
    context: {
      operation: string;
      path: string;
      model: string;
      timeoutMs: number;
      elapsedMs: number;
      promptPreview: string;
      imageCount: number;
      timedOut: boolean;
    },
  ): string {
    const errorName = error.name || 'Error';
    const reason = context.timedOut
      ? `request timed out after ${context.timeoutMs}ms`
      : `${errorName}: ${error.message}`;
    const promptDetail = context.promptPreview
      ? `prompt="${context.promptPreview}"`
      : 'prompt=<empty>';
    const imageDetail = context.imageCount > 0 ? `, images=${context.imageCount}` : '';

    return [
      `operation=${context.operation}`,
      `model=${context.model}`,
      `endpoint=${context.path}`,
      `elapsed=${context.elapsedMs}ms`,
      `reason=${reason}`,
      `${promptDetail}${imageDetail}`,
    ].join(', ');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

import type { OllamaConfig } from './types';

export interface CompletionOptions {
  temperature?: number;
  maxTokens?: number;
  system?: string;
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

    return this.request('/api/generate', body);
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

    return this.request('/api/generate', body);
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

  private async request(path: string, body: Record<string, unknown>): Promise<string> {
    const url = `${this.endpoint}${path}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);

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
        return data.response.trim();
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < 2) {
          await sleep(1_000 * (attempt + 1));
        }
      }
    }

    throw new Error(`Ollama request failed after 3 attempts: ${lastError?.message}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

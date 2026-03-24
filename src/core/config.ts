import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { Config } from './types';

const DEFAULTS: Config = {
  target: {
    repo: '',
    featureList: './features.md',
  },
  ollama: {
    endpoint: 'http://localhost:11434',
    textModel: 'llama3.1:8b',
    visionModel: 'llava',
    timeoutMs: 120_000,
  },
  agents: {
    qa: {
      featureTesters: 2,
      playTesters: 2,
    },
    redTeam: {
      recon: 1,
      exploit: 2,
    },
  },
  browser: {
    headless: true,
    timeoutMs: 30_000,
  },
  reports: {
    outputDir: './reports',
  },
  runner: {
    playTesterGoalIntervalMs: 300_000,
    maxRunDurationMs: 0,
    serverStartTimeoutMs: 60_000,
    startupRetries: 10,
  },
  web: {
    enabled: true,
    port: 4242,
  },
};

function deepMerge<T>(base: T, override: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(override) as (keyof T)[]) {
    const overrideVal = override[key];
    const baseVal = base[key];
    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(baseVal, overrideVal as Partial<typeof baseVal>);
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal as T[keyof T];
    }
  }
  return result;
}

export function loadConfig(configPath: string): Config {
  const resolved = path.resolve(configPath);

  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}\nCopy config.example.yaml to config.yaml and fill in your values.`);
  }

  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = yaml.load(raw) as Partial<Config>;

  const config = deepMerge(DEFAULTS, parsed);

  validate(config, resolved);
  return config;
}

function validate(config: Config, configPath: string): void {
  const errors: string[] = [];

  if (!config.target.repo) {
    errors.push('target.repo is required — set it to the absolute path of the repository to test');
  } else if (!fs.existsSync(config.target.repo)) {
    errors.push(`target.repo does not exist: ${config.target.repo}`);
  }

  const featureListPath = path.resolve(path.dirname(configPath), config.target.featureList);
  if (!fs.existsSync(featureListPath)) {
    errors.push(`target.featureList not found: ${featureListPath}\nCreate a features.md file (see features.example.md)`);
  }

  if (errors.length > 0) {
    throw new Error(`Configuration errors:\n${errors.map(e => `  • ${e}`).join('\n')}`);
  }
}

export function resolveReportDir(config: Config, configPath: string): string {
  return path.resolve(path.dirname(configPath), config.reports.outputDir);
}

export function resolveFeatureList(config: Config, configPath: string): string {
  return path.resolve(path.dirname(configPath), config.target.featureList);
}

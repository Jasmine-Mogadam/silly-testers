#!/usr/bin/env node
/**
 * silly-testers setup script
 * Installs all prerequisites: npm packages, Playwright browsers, and Ollama models.
 */

import { execSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REQUIRED_MODELS = ['llama3.1:8b', 'llava'];
const OLLAMA_ENDPOINT = 'http://localhost:11434';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

function ok(msg)   { console.log(`${GREEN}  ✓${RESET} ${msg}`); }
function warn(msg) { console.log(`${YELLOW}  ⚠${RESET} ${msg}`); }
function fail(msg) { console.log(`${RED}  ✗${RESET} ${msg}`); }
function step(msg) { console.log(`\n${BOLD}${msg}${RESET}`); }
function run(cmd, opts = {}) {
  return spawnSync(cmd, { shell: true, stdio: 'inherit', cwd: ROOT, ...opts });
}

// ─── Node version check ────────────────────────────────────────────────────────

step('Checking Node.js version...');
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  fail(`Node.js 18+ required. You have v${process.versions.node}.`);
  process.exit(1);
}
ok(`Node.js v${process.versions.node}`);

// ─── npm install ──────────────────────────────────────────────────────────────

step('Installing npm dependencies...');
const install = run('npm install');
if (install.status !== 0) {
  fail('npm install failed.');
  process.exit(1);
}
ok('npm packages installed');

// ─── Playwright browsers ─────────────────────────────────────────────────────

step('Installing Playwright browsers (Chromium)...');
const pw = run('npx playwright install chromium');
if (pw.status !== 0) {
  fail('Playwright browser install failed.');
  process.exit(1);
}
ok('Chromium installed');

// ─── Ollama ───────────────────────────────────────────────────────────────────

step('Checking Ollama...');

// Check if ollama CLI exists
const ollamaCheck = spawnSync('ollama', ['--version'], { shell: true, stdio: 'pipe' });
if (ollamaCheck.status !== 0) {
  warn('Ollama CLI not found. Install it from https://ollama.com before running.');
  warn('Then run: npm run setup:models');
  console.log('');
  printNextSteps(false);
  process.exit(0);
}
ok(`Ollama CLI found`);

// Check if server is running
let serverRunning = false;
try {
  const res = await fetch(`${OLLAMA_ENDPOINT}/api/tags`, { signal: AbortSignal.timeout(3000) });
  serverRunning = res.ok;
} catch {
  // not running
}

if (!serverRunning) {
  warn('Ollama server is not running. Start it with: ollama serve');
  warn('Then pull the required models with: npm run setup:models');
  console.log('');
  printNextSteps(false);
  process.exit(0);
}
ok('Ollama server is reachable');

// Pull required models
await pullModels();

console.log('');
printNextSteps(true);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function pullModels() {
  step('Pulling Ollama models (this may take a while on first run)...');

  let available = [];
  try {
    const res = await fetch(`${OLLAMA_ENDPOINT}/api/tags`);
    const data = await res.json();
    available = (data.models ?? []).map(m => m.name);
  } catch {
    warn('Could not list models — will attempt to pull anyway.');
  }

  for (const model of REQUIRED_MODELS) {
    const alreadyPulled = available.some(a => a === model || a.startsWith(`${model}:`));
    if (alreadyPulled) {
      ok(`${model} already pulled`);
      continue;
    }
    console.log(`  Pulling ${model}...`);
    const result = run(`ollama pull ${model}`);
    if (result.status !== 0) {
      fail(`Failed to pull ${model}. Run manually: ollama pull ${model}`);
    } else {
      ok(`${model} pulled`);
    }
  }
}

function printNextSteps(modelsReady) {
  console.log(`${BOLD}Setup complete! Next steps:${RESET}`);
  console.log('');
  if (!modelsReady) {
    console.log('  1. Start Ollama:          ollama serve');
    console.log('  2. Pull models:           npm run setup:models');
    console.log('  3. Create config:         cp config.example.yaml config.yaml');
    console.log('  4. Create feature list:   cp features.example.md features.md');
    console.log('  5. Edit both files, then: npm start -- --dry-run');
  } else {
    console.log('  1. Create config:         cp config.example.yaml config.yaml');
    console.log('  2. Create feature list:   cp features.example.md features.md');
    console.log('  3. Edit both files, then: npm start -- --dry-run');
    console.log('  4. Run:                   npm start');
  }
  console.log('');
}

#!/usr/bin/env node
import { Command } from 'commander';
import * as path from 'path';
import { loadConfig } from './core/config';
import { Runner } from './runner';

const program = new Command();

program
  .name('silly-testers')
  .description('AI agent framework for QA and red team testing of web applications')
  .version('0.1.0');

program
  .command('run', { isDefault: true })
  .description('Run QA and/or red team agents against the target site')
  .option('-c, --config <path>', 'Path to config.yaml', './config.yaml')
  .option(
    '-t, --team <team>',
    'Which team to run: qa | red | both',
    'both'
  )
  .option('--dry-run', 'Validate config and connectivity without starting agents', false)
  .action(async (opts: { config: string; team: string; dryRun: boolean }) => {
    const configPath = path.resolve(opts.config);

    let config;
    try {
      config = loadConfig(configPath);
    } catch (err) {
      console.error(`\nConfiguration error:\n${(err as Error).message}\n`);
      process.exit(1);
    }

    const team = opts.team as 'qa' | 'red' | 'both';
    if (!['qa', 'red', 'both'].includes(team)) {
      console.error(`Invalid --team value: "${team}". Must be qa, red, or both.`);
      process.exit(1);
    }

    const runner = new Runner(config, { configPath, team, dryRun: opts.dryRun });

    try {
      await runner.run();
    } catch (err) {
      console.error(`\nFatal error: ${(err as Error).message}`);
      await runner.cleanup().catch(() => {});
      process.exit(1);
    }
  });

program.parse(process.argv);

import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { CLI_VERSION } from './execution.mjs';
import { WORK, command, cleanEnvironment, output } from './lib.mjs';

const runtime = path.join(WORK, 'runtime');
command('npm', ['install', '--prefix', runtime, '--ignore-scripts', '--no-audit', '--no-fund', `@openai/codex@${CLI_VERSION}`],
  { timeout: 180000, env: cleanEnvironment() });
const bin = path.join(runtime, 'node_modules/.bin');
if (process.env.GITHUB_PATH) appendFileSync(process.env.GITHUB_PATH, bin + '\n');
output('binary', path.join(bin, 'codex'));
console.log(`Installed CLI ${CLI_VERSION}.`);

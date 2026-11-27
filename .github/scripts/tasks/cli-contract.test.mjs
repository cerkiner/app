import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CLI_VERSION, cliArgs, settings } from './execution.mjs';
import { command, ROOT } from './lib.mjs';

// No subscription login or remote inference. Enable with the pinned executable.
for (const mode of ['issue', 'review']) test(`pinned CLI strictly parses the native ${mode} configuration`, {
  skip: !process.env.CODEX_CLI_BIN, timeout: 20000,
}, async t => {
  const binary = process.env.CODEX_CLI_BIN;
  assert.equal(command(binary, ['--version']).trim(), `codex-cli ${CLI_VERSION}`);
  const temp = mkdtempSync(path.join(os.tmpdir(), 'repository-contract-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, 'project'), auth = path.join(temp, 'login');
  mkdirSync(workspace); mkdirSync(auth);
  const catalog = path.join(temp, 'catalog.json');
  writeFileSync(catalog, JSON.stringify({ models: [{ slug: 'local-contract-test', display_name: 'Local contract test',
    description: 'Local-only test metadata', base_instructions: 'Inspect the tool catalog.', supported_reasoning_levels: [],
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 0, support_verbosity: false,
    apply_patch_tool_type: null, truncation_policy: { mode: 'tokens', limit: 10000 }, experimental_supported_tools: [],
    supports_search_tool: true, tool_mode: 'direct',
  }] }));
  // Proposed project configuration must not start its own integrations.
  mkdirSync(path.join(workspace, '.codex'));
  const marker = path.join(temp, 'project-config-ran');
  writeFileSync(path.join(workspace, '.codex/config.toml'), '[mcp_servers.injected]\ncommand = ' + JSON.stringify(process.execPath) + '\nargs = [' + JSON.stringify('-e') + ',' + JSON.stringify('require("fs").writeFileSync(' + JSON.stringify(marker) + ',"unexpected")') + ']\n');
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { requests.push(JSON.parse(body)); } catch { /* ignore non-inference requests */ }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Intentional local contract endpoint' } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const args = cliArgs(workspace, mode, 'local-contract-test', temp); args.pop();
  const forced = args.indexOf('forced_login_method="chatgpt"'); args.splice(forced - 1, 2);
  for (const setting of ['model_provider="test"', 'model_providers.test.name="Local test"',
    `model_providers.test.base_url="http://127.0.0.1:${server.address().port}/v1"`,
    'model_providers.test.env_key="LOCAL_TEST_KEY"', 'model_providers.test.wire_api="responses"',
    'model_providers.test.requires_openai_auth=false', 'features.enable_request_compression=false', 'feedback.enabled=false',
    `model_catalog_json=${JSON.stringify(catalog)}`]) args.push('-c', setting);
  args.push('-');
  const child = spawn(binary, args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: auth, LOCAL_TEST_KEY: 'local-test-only' }, stdio: ['pipe','pipe','pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let stderr = ''; child.stderr.on('data', chunk => stderr = (stderr + chunk).slice(-4000)); child.stdout.resume();
  child.stdin.on('error', () => {}); child.stdin.end('Inspect only the tool catalog.');
  const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
  const code = await new Promise((resolve,reject) => { child.on('close', resolve); child.on('error', reject); }); clearTimeout(timer);
  assert.notEqual(code, 0);
  assert.ok(requests.length > 0, `Native configuration was rejected: ${stderr}`);
  const names = requests[0].tools.flatMap(tool => tool.type === 'namespace' ? tool.tools.map(item => tool.name + '.' + item.name) : [tool.name]);
  assert.ok(names.some(name => /exec|shell/.test(name)), JSON.stringify(names));
  assert.ok(!names.some(name => /mcp__workspace|mcp__injected/.test(name)));
  assert.ok(!existsSync(marker));
});

test('Ubuntu native profiles permit project work and deny login reads, review writes and review networking', {
  skip: !process.env.CODEX_CLI_BIN || process.platform !== 'linux', timeout: 30000,
}, async t => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'repository-permissions-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const project = path.join(temp, 'project'), credentials = path.join(temp, 'login'), scratch = path.join(temp, 'scratch');
  for (const dir of [project, credentials, scratch]) mkdirSync(dir);
  const protectedFile = path.join(credentials, 'auth.json'); writeFileSync(protectedFile, 'synthetic-login-only');
  const binary = process.env.CODEX_CLI_BIN;
  const toml = value => value && typeof value === 'object' ? '{' + Object.entries(value).map(([k,v]) => JSON.stringify(k) + '=' + toml(v)).join(',') + '}' : JSON.stringify(value);
  function run(mode, script) {
    const cfg = settings(project, mode, { credentials, scratch, runtime: path.resolve(binary, '../../..') });
    const args = ['sandbox', '--cd', project, '--permission-profile', 'task'];
    for (const [key,value] of Object.entries(cfg)) args.push('-c', key + '=' + toml(value));
    return spawnSync(binary, [...args, '--', process.execPath, '-e', script], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: credentials }, encoding: 'utf8', timeout: 10000 });
  }
  const allowed = run('issue', `const fs=require('fs'),ts=require(${JSON.stringify(path.join(ROOT, 'node_modules/typescript'))});fs.writeFileSync('source.ts','const total: number = 2 + 2; module.exports = total;');fs.writeFileSync('build.cjs',ts.transpile(fs.readFileSync('source.ts','utf8')));require('node:assert/strict').equal(require(process.cwd()+'/build.cjs'),4);`);
  assert.equal(allowed.status, 0, allowed.stderr); assert.ok(existsSync(path.join(project, 'build.cjs')));
  for (const mode of ['issue','review']) {
    const denied = run(mode, `try {require('fs').readFileSync(${JSON.stringify(protectedFile)});process.exit(2)} catch(e) {if(!['EACCES','EPERM'].includes(e.code))throw e}`);
    assert.equal(denied.status, 0, denied.stderr);
  }
  const readonly = run('review', `try {require('fs').writeFileSync('blocked.txt','x');process.exit(2)} catch(e) {if(!['EACCES','EPERM','EROFS'].includes(e.code))throw e}`);
  assert.equal(readonly.status, 0, readonly.stderr); assert.ok(!existsSync(path.join(project,'blocked.txt')));
  const server = http.createServer(); await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); t.after(() => server.close());
  const network = run('review', `const socket=require('net').connect(${server.address().port},'127.0.0.1');socket.on('connect',()=>process.exit(2));socket.on('error',e=>process.exit(['EACCES','EPERM'].includes(e.code)?0:3));setTimeout(()=>process.exit(4),2000)`);
  assert.equal(network.status, 0, network.stderr);
});

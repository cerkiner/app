import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CODEX_VERSION, cliArgs } from './run-codex.mjs';
import { command } from './lib.mjs';

// Optional real-CLI contract test: no subscription credentials, API billing or
// Docker daemon. All inference traffic goes to this local, intentionally failing
// HTTP stub. Set CODEX_CLI_BIN to an installed pinned executable to enable it.
test('pinned CLI accepts the controller policy and exposes only the permitted review tools', {
  skip: !process.env.CODEX_CLI_BIN, timeout: 25000,
}, async t => {
  const binary = process.env.CODEX_CLI_BIN;
  assert.equal(command(binary, ['--version']).trim(), `codex-cli ${CODEX_VERSION}`);
  const temp = mkdtempSync(path.join(os.tmpdir(), 'codex-cli-contract-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const controller = path.join(temp, 'controller'); mkdirSync(controller); mkdirSync(path.join(temp, 'auth'));
  let captured;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { captured = JSON.parse(body); } catch { /* not an inference request */ }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Intentional local-only contract test' } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const args = cliArgs(controller, 'codex-contract-test', 'review', 'local-contract-test'); args.pop();
  // Change only authentication/provider for this mock test. Production always
  // enforces ChatGPT auth; no auth cache from the caller is read here.
  const forced = args.indexOf('forced_login_method="chatgpt"'); args.splice(forced - 1, 2);
  for (const setting of ['model_provider="test"', 'model_providers.test.name="Local test"',
    `model_providers.test.base_url="http://127.0.0.1:${server.address().port}/v1"`,
    'model_providers.test.env_key="CODEX_LOCAL_TEST_KEY"', 'model_providers.test.wire_api="responses"',
    'model_providers.test.requires_openai_auth=false', 'features.enable_request_compression=false', 'feedback.enabled=false']) args.push('-c', setting);
  args.push('-');
  const child = spawn(binary, args, { env: { PATH: process.env.PATH, HOME: temp, CODEX_HOME: path.join(temp, 'auth'), CODEX_LOCAL_TEST_KEY: 'local-test-only' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); }); child.stdout.resume();
  child.stdin.on('error', () => {}); child.stdin.end('Inspect only the tool catalog.');
  const timer = setTimeout(() => child.kill('SIGTERM'), 20000);
  const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); }); clearTimeout(timer);
  assert.notEqual(code, 0); // the stub deliberately refuses inference
  assert.ok(captured, `CLI did not reach the local endpoint: ${stderr}`);
  assert.equal(stderr, '');
  const names = captured.tools.flatMap(tool => tool.type === 'namespace' ? tool.tools.map(item => `${tool.name}.${item.name}`) : [tool.name]);
  for (const name of names) assert.ok(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'request_user_input',
    'mcp__workspace.list_files', 'mcp__workspace.read_file', 'mcp__workspace.search'].includes(name), `Unexpected native tool: ${name}`);
  assert.ok(names.includes('mcp__workspace.read_file'));
});

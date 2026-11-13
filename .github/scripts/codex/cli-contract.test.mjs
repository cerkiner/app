import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CODEX_VERSION, cliArgs } from './run-codex.mjs';
import { command } from './lib.mjs';

// Optional real-CLI contract test: no subscription credentials, API billing or
// Docker daemon. All inference traffic goes to this local, intentionally failing
// HTTP stub, and Docker execution is replaced with an inert argv recorder.
// Set CODEX_CLI_BIN to an installed pinned executable to enable it.
for (const mode of ['issue', 'review']) for (const toolMode of ['direct', 'code_mode_only']) test(`pinned CLI exposes isolated ${mode} tools directly without approval for ${toolMode} models`, {
  skip: !process.env.CODEX_CLI_BIN, timeout: 25000,
}, async t => {
  const binary = process.env.CODEX_CLI_BIN;
  assert.equal(command(binary, ['--version']).trim(), `codex-cli ${CODEX_VERSION}`);
  const temp = mkdtempSync(path.join(os.tmpdir(), 'codex-cli-contract-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const controller = path.join(temp, 'controller'); mkdirSync(controller); mkdirSync(path.join(temp, 'auth'));
  const catalog = path.join(temp, 'catalog.json');
  writeFileSync(catalog, JSON.stringify({ models: [{ slug: 'local-contract-test', display_name: 'Local contract test',
    description: 'Local-only test metadata', base_instructions: 'Inspect only the tool catalog.', supported_reasoning_levels: [],
    shell_type: 'unified_exec', visibility: 'list', supported_in_api: true, priority: 0, support_verbosity: false,
    apply_patch_tool_type: null, truncation_policy: { mode: 'tokens', limit: 10000 }, experimental_supported_tools: [],
    supports_search_tool: true, tool_mode: toolMode,
  }] }));
  const bin = path.join(temp, 'bin'); mkdirSync(bin);
  const calls = path.join(temp, 'docker-calls.jsonl');
  writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
console.log('isolated-tool-executed');
`, { mode: 0o700 });
  const toolCalls = mode === 'review' ? [
    { name: 'list_files', arguments: {} },
    { name: 'read_file', arguments: { path: 'README.md' } },
    { name: 'search', arguments: { pattern: 'test' } },
  ] : [{ name: 'workspace', arguments: { command: 'printf isolated' } }];
  const requests = [];
  const sse = events => events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { requests.push(JSON.parse(body)); } catch { /* not an inference request */ }
      if (requests.length === 1) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(sse([
          { type: 'response.created', response: { id: 'local-tool-request' } },
          ...toolCalls.map((call, index) => ({ type: 'response.output_item.done', item: { type: 'function_call',
            call_id: `isolated-${index}`, namespace: 'mcp__workspace', name: call.name, arguments: JSON.stringify(call.arguments) } })),
          { type: 'response.completed', response: { id: 'local-tool-request', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } },
        ]));
        return;
      }
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Intentional local-only contract test' } }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const args = cliArgs(controller, 'codex-contract-test', mode, 'local-contract-test'); args.pop();
  // Change only authentication/provider for this mock test. Production always
  // enforces ChatGPT auth; no auth cache from the caller is read here.
  const forced = args.indexOf('forced_login_method="chatgpt"'); args.splice(forced - 1, 2);
  for (const setting of ['model_provider="test"', 'model_providers.test.name="Local test"',
    `model_providers.test.base_url="http://127.0.0.1:${server.address().port}/v1"`,
    'model_providers.test.env_key="CODEX_LOCAL_TEST_KEY"', 'model_providers.test.wire_api="responses"',
    'model_providers.test.requires_openai_auth=false', 'features.enable_request_compression=false', 'feedback.enabled=false',
    `model_catalog_json=${JSON.stringify(catalog)}`]) args.push('-c', setting);
  args.push('-');
  const child = spawn(binary, args, { env: { PATH: `${bin}:${process.env.PATH}`, HOME: temp, CODEX_HOME: path.join(temp, 'auth'), CODEX_LOCAL_TEST_KEY: 'local-test-only' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGTERM'));
  let stderr = ''; child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); }); child.stdout.resume();
  child.stdin.on('error', () => {}); child.stdin.end('Inspect only the tool catalog.');
  const timer = setTimeout(() => child.kill('SIGTERM'), 20000);
  const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); }); clearTimeout(timer);
  assert.notEqual(code, 0); // the stub deliberately refuses inference
  assert.equal(requests.length, 2, `CLI did not complete the tool round trip: ${stderr}`);
  const [captured, followup] = requests;
  assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, toolCalls.length);
  for (let index = 0; index < toolCalls.length; index++) {
    const output = followup.input.find(item => item.type === 'function_call_output' && item.call_id === `isolated-${index}`);
    assert.ok(JSON.stringify(output).includes('isolated-tool-executed'), `Tool ${toolCalls[index].name} was blocked: ${JSON.stringify(output)}`);
  }
  assert.equal(stderr, '');
  const names = captured.tools.flatMap(tool => tool.type === 'namespace' ? tool.tools.map(item => `${tool.name}.${item.name}`) : [tool.name]);
  for (const name of names) assert.ok(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource', 'request_user_input',
    'exec', 'wait', 'functions.exec', 'functions.wait',
    ...(mode === 'review' ? ['mcp__workspace.list_files', 'mcp__workspace.read_file', 'mcp__workspace.search'] : ['mcp__workspace.workspace'])].includes(name), `Unexpected native tool: ${name}`);
  assert.ok(names.includes(mode === 'review' ? 'mcp__workspace.read_file' : 'mcp__workspace.workspace'));
});

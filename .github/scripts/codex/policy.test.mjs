import test from 'node:test';
import assert from 'node:assert/strict';
import { toolDefinitions, toolArgv, handle } from './sandbox-mcp.mjs';
import { cliArgs, containerArgs, parseResult } from './run-codex.mjs';
import { validateAuth } from './auth.mjs';
import { BOT, records, marker, validateChanges, sha, branch, repository, redactor, redactValue, cleanEnvironment, validateResult } from './lib.mjs';
import { repairBudget, humanRevisionAuthor, credentialsAreFresh, changedLines, findingKey } from './state.mjs';
import { nextRuns } from './agent.mjs';

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40);
const botComment = record => ({ id: 1, user: { login: BOT, type: 'Bot' }, body: marker(record) });
test('three repairs across bot SHAs exhaust one cycle, including crashed reservations', () => {
  const first = { kind: 'repair', cycle: `head-${a}`, attempt: 1, input_sha: a, output_sha: b, status: 'complete' };
  const second = { ...first, attempt: 2, input_sha: b, output_sha: c, status: 'publishing' };
  const third = { ...first, attempt: 3, input_sha: c, output_sha: d, status: 'reserved' };
  assert.equal(repairBudget([first], b).attempt, 2);
  assert.equal(repairBudget([first, second], c).attempt, 3);
  assert.equal(repairBudget([first, second, third], d).allowed, false);
  assert.equal(repairBudget([first, second, third], c).allowed, false);
});
test('only a new human revision or an explicit authorized cycle can reset the budget', () => {
  const history = [1, 2, 3].map(attempt => ({ kind: 'repair', cycle: 'old', attempt, input_sha: a, output_sha: b }));
  assert.equal(repairBudget(history, c, false).allowed, false);
  assert.equal(repairBudget(history, c, true).attempt, 1);
  assert.equal(repairBudget(history, b, undefined, 'manual-10').attempt, 1);
  assert.equal(repairBudget([{ ...history[0], status: 'halted' }], b).allowed, false);
});
test('signed GitHub web-editor commits identify the human author without trusting arbitrary bots', () => {
  const author = { type: 'User', login: 'maintainer' };
  const commit = { author, committer: { login: 'web-flow', type: 'User' }, commit: { verification: { verified: true } } };
  assert.deepEqual(humanRevisionAuthor(commit), author);
  assert.equal(humanRevisionAuthor({ ...commit, commit: { verification: { verified: false } } }), null);
  assert.equal(humanRevisionAuthor({ ...commit, author: { type: 'Bot', login: BOT } }), null);
  assert.equal(humanRevisionAuthor({ ...commit, committer: { type: 'Bot', login: 'some-other-bot' } }), null);
  assert.equal(humanRevisionAuthor({ ...commit, committer: { type: 'Bot', login: BOT } }), null);
  assert.equal(humanRevisionAuthor({ committer: author }), author);
});
test('a known repair output keeps its exhausted cycle even when the revision is human-associated', () => {
  const history = [1, 2, 3].map(attempt => ({ kind: 'repair', cycle: 'old', attempt, input_sha: a, output_sha: b }));
  assert.equal(repairBudget(history, b, true).allowed, false);
});
test('untrusted comment markers cannot forge attempt counters or agent ownership', () => {
  const record = { kind: 'repair', attempt: 3 };
  const human = { ...botComment(record), user: { login: 'contributor', type: 'User' } };
  assert.deepEqual(records([human]), []);
  assert.equal(records([botComment(record)])[0].attempt, 3);
});
test('queued secret snapshots are rejected, including timestamp equality', () => {
  assert.equal(credentialsAreFresh('2026-11-13T00:00:02Z', '2026-11-13T00:00:01Z'), true);
  assert.equal(credentialsAreFresh('2026-11-13T00:00:01Z', '2026-11-13T00:00:02Z'), false);
  assert.equal(credentialsAreFresh('2026-11-13T00:00:01Z', '2026-11-13T00:00:01Z'), false);
  assert.throws(() => credentialsAreFresh('unknown', 'unknown'));
});
test('only subscription credentials are accepted', () => {
  const auth = { auth_mode: 'chatgpt', tokens: { access_token: 'a'.repeat(20), refresh_token: 'r'.repeat(20), id_token: 'i'.repeat(20) } };
  assert.equal(validateAuth(auth), auth);
  assert.throws(() => validateAuth({ ...auth, auth_mode: 'apikey', OPENAI_API_KEY: 'secret' }));
  assert.throws(() => validateAuth({ ...auth, tokens: { access_token: 'a'.repeat(20) } }));
});
test('review tools cannot execute shell code or read paths outside the repository', () => {
  assert.deepEqual(toolDefinitions(true).map(t => t.name), ['list_files', 'read_file', 'search']);
  assert.throws(() => toolArgv('workspace', { command: 'cat /auth.json' }, true));
  assert.throws(() => toolArgv('read_file', { path: '../auth.json' }, true));
  assert.throws(() => toolArgv('read_file', { path: '/proc/1/environ' }, true));
  const argv = toolArgv('read_file', { path: 'x;cat /auth.json', start_line: 1 }, true);
  assert.equal(argv[0], 'python3');
  assert.equal(argv.at(-2), 'x;cat /auth.json'); // argv data, never host shell syntax
  let called = false;
  const result = handle({ id: 1, method: 'resources/read', params: { uri: 'file:///auth.json' } }, true, () => { called = true; });
  assert.equal(called, false);
  assert.equal(result.error.code, -32601);
});
test('implementation commands stay inside Docker argv and credentials are never mounted', () => {
  const argv = toolArgv('workspace', { command: 'echo x; cat /proc/1/environ' }, false);
  assert.equal(argv[0], 'timeout');
  assert.equal(argv.at(-1), 'echo x; cat /proc/1/environ');
  const args = containerArgs('codex-1', '/tmp/work/workspace', false).join(' ');
  assert.ok(args.includes('--cap-drop=ALL'));
  assert.ok(args.includes('--security-opt=no-new-privileges'));
  assert.ok(!args.includes('credentials') && !args.includes('docker.sock') && !args.includes('--privileged'));
  const review = containerArgs('codex-1', '/tmp/work/workspace', true).join(' ');
  assert.ok(review.includes('--network none'));
  assert.ok(review.includes('target=/workspace,readonly'));
});
test('Codex controller has no native shell, image, hooks, plugins or child agents', () => {
  const args = cliArgs('/tmp/controller', 'codex-1', 'review');
  for (const setting of ['features.shell_tool=false', 'features.view_image=false', 'features.hooks=false', 'features.multi_agent=false', 'features.plugins=false', 'forced_login_method="chatgpt"']) assert.ok(args.includes(setting), setting);
  assert.ok(args.includes('default_permissions="controller"'));
  assert.ok(args.includes('features.code_mode={"enabled"=false,"direct_only_tool_namespaces"=["mcp__workspace"]}'));
  assert.ok(args.includes('features.code_mode_host=false'));
  assert.ok(args.some(a => a.startsWith('permissions=') && a.includes('credentials"="deny"') && a.includes('"/proc"="deny"')));
  assert.ok(args.includes('--ignore-user-config') && args.includes('--ignore-rules') && args.includes('--ephemeral'));
  process.env.CODEX_AUTH_JSON_B64 = 'fake-test-secret'; process.env.GH_TOKEN = 'fake-test-token';
  const env = cleanEnvironment();
  assert.equal(env.GH_TOKEN, undefined); assert.equal(env.CODEX_AUTH_JSON_B64, undefined);
  delete process.env.CODEX_AUTH_JSON_B64; delete process.env.GH_TOKEN;
});
test('automation, credential, test-config, traversal, symlink and submodule edits are rejected', () => {
  for (const file of ['.github/workflows/CI.yml', 'nested/.codex/config.toml', 'AGENTS.md', 'src/AGENTS.md', '.gitignore', '../source.ts', 'src/../../key', '.env.local', 'auth.json', 'private.key', 'angular.json', 'src/karma.conf.js']) {
    assert.throws(() => validateChanges([{ file, mode: '100644' }]), file);
  }
  assert.throws(() => validateChanges([{ file: 'src/link', mode: '120000' }]));
  assert.throws(() => validateChanges([{ file: 'submodule', mode: '160000' }]));
  assert.doesNotThrow(() => validateChanges([{ file: 'src/app.spec.ts', mode: '100644' }]));
});
test('invalid identifiers never reach Git or API path construction', () => {
  assert.throws(() => sha('HEAD; rm -rf x'));
  for (const ref of ['--upload-pack=x', 'a..b', 'a b', 'a.lock', 'foo/@{bar', '/master']) assert.throws(() => branch(ref));
  assert.throws(() => repository('owner/repo/../../other'));
  assert.equal(branch('codex/issue-123'), 'codex/issue-123');
});
test('redaction removes seed and rotated tokens, common token formats and bearer headers', () => {
  const redact = redactor(['old-oauth-access-token', 'rotated-oauth-refresh-token']);
  const text = redact('old-oauth-access-token rotated-oauth-refresh-token Bearer abcdefghi ghp_' + 'x'.repeat(30));
  assert.ok(!text.includes('old-oauth') && !text.includes('rotated-oauth') && !text.includes('abcdefghi') && !text.includes('ghp_'));
  assert.ok(redact('{"refresh_token":"top-secret-value"}').includes('[REDACTED]'));
});
test('result redaction preserves JSON quoting, escapes, nested strings and schema fields', () => {
  const input = { outcome: 'changes', title: 'Handle quoted input',
    summary: 'Use password="example" and C:\\temp\\file\nThen test an escaped quote: "value".',
    investigated: ['password="example"'], unresolved: ['refresh_token=example'],
    tests: [{ command: 'printf \'password="example"\'', status: 'passed', details: 'rotated-token-123456' }], findings: [] };
  const result = parseResult(JSON.stringify(input), 'issue', redactor(['rotated-token-123456']));
  assert.match(result.summary, /password="\[REDACTED\]"/);
  assert.ok(result.summary.includes('C:\\temp\\file\n'));
  assert.equal(result.tests[0].details, '[REDACTED]');
  assert.equal(result.tests[0].status, 'passed');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.deepEqual(redactValue({ nested: [null, 123, true, 'password="example"'] }, redactor()),
    { nested: [null, 123, true, 'password="[REDACTED]"'] });
});
test('malformed Codex JSON does not expose its contents in parse errors', () => {
  assert.throws(() => parseResult('{"summary":"private-token-1234', 'issue'), error =>
    error.message.includes('invalid JSON') && !error.message.includes('private-token-1234'));
});
test('inline review findings use actual added right-side lines', () => {
  const lines = changedLines([{ filename: 'a.ts', patch: '@@ -2,3 +2,4 @@\n context\n-old\n+new\n+next\n context' }]);
  assert.deepEqual([...lines], ['a.ts:3', 'a.ts:4']);
  assert.equal(findingKey({ path: 'a.ts', line: 3, title: ' A defect ' }), findingKey({ path: 'a.ts', line: 3, title: 'a defect' }));
});
test('malformed or mode-conflicting model results fail closed', () => {
  const result = { outcome: 'changes', title: 'Fix', summary: 'Fixed', investigated: [], tests: [], unresolved: [], findings: [] };
  assert.throws(() => validateResult(result, 'review'));
  assert.throws(() => validateResult({ ...result, tests: [{ command: 'x', status: 'green', details: '' }] }, 'issue'));
  assert.throws(() => validateResult({ ...result, findings: [{ priority: 'P1', title: 'x', body: 'x', path: '../auth.json', line: 2 }] }, 'issue'));
});
test('CI is explicitly dispatched for older feature branches without new workflow inputs', () => {
  const calls = [], reviews = [];
  nextRuns({ repo: 'owner/repo', branch: 'feature' }, 2, a, (endpoint, request) => {
    calls.push({ endpoint, request });
    if (calls.length === 1) throw Object.assign(new Error('unsupported inputs'), { httpStatus: 422 });
  }, (...args) => reviews.push(args));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].request.body.inputs.expected_sha, a);
  assert.deepEqual(calls[1].request.body, { ref: 'feature' });
  assert.deepEqual(reviews[0], ['owner/repo', 'review', 2, a]);
});
test('uncertain network or permission failures never blindly duplicate CI dispatches', () => {
  let calls = 0;
  assert.throws(() => nextRuns({ repo: 'owner/repo', branch: 'feature' }, 2, a, () => {
    calls++; throw Object.assign(new Error('access denied'), { httpStatus: 403 });
  }));
  assert.equal(calls, 1);
});

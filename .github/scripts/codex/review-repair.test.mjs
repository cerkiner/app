import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fixture, repairResponses } from './fixtures.mjs';
import { BOT, marker, recordFrom, validateResult } from './lib.mjs';
import { canonicalFindings, findingKey, repairBudget, remainingFindings, validateRepairVerification } from './state.mjs';
import { validateReviewRequest } from './reviews.mjs';
import { enforceReviewCompletion } from './run-codex.mjs';

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40);
const defect = { path: 'source.txt', line: 1, title: 'Avoid applying the discount twice', body: 'A discounted total is multiplied by the discount again, undercharging customers.', priority: 'P1', actionable: true, previous_key: null };
const finding = () => canonicalFindings([defect])[0];
const result = (overrides = {}) => ({ outcome: 'review', review_status: 'complete', finding_verifications: [], title: 'Review', summary: 'A material logic defect.', investigated: ['Read relevant source'], tests: [], unresolved: [], findings: [defect], ...overrides });
const review = (overrides = {}) => ({ id: 200, commit_id: a, state: 'COMMENTED', user: { login: BOT, type: 'Bot' },
  body: marker({ kind: 'review', head_sha: a, run_id: 40, review_status: 'complete', findings: [finding()], finding_keys: [finding().key], repair_requested: false }), ...overrides });
function responses(history = [], options) {
  const data = repairResponses(history, options);
  data['repos/owner/repo/pulls/1/reviews?per_page=100'] = [review()];
  data['repos/owner/repo/pulls/1/reviews/200'] = review();
  data['repos/owner/repo/actions/workflows/CI.yml/runs?head_sha=' + a + '&status=failure&per_page=10'] = { workflow_runs: [] };
  data['repos/owner/repo/actions/workflows/codex-agent.yml/dispatches'] = null;
  return data;
}
const env = { CODEX_MODE: 'repair', CODEX_TARGET: '1', CODEX_REPAIR_SOURCE: 'review', CODEX_REVIEW_ID: '200', CODEX_EXPECTED_SHA: a, CODEX_REVIEW_FINDINGS: JSON.stringify([finding()]) };
function saveResult(f, task, output) {
  writeFileSync(path.join(f.work, 'task.json'), JSON.stringify(task));
  mkdirSync(path.join(f.work, 'artifacts'), { recursive: true });
  writeFileSync(path.join(f.work, 'artifacts/result.json'), JSON.stringify(output));
}
const publishedTask = () => ({ mode: 'review', repo: 'owner/repo', number: 1, target: 1, run_id: 50, head_sha: a, default_branch: 'master',
  previous_findings: [], previous_structured_findings: [], context: { pr: {} }, files: [{ filename: 'source.txt', patch: '@@ -1 +1 @@\n-old\n+new' }] });

test('significant review findings publish first, then dispatch exact SHA, source review and structured findings', t => {
  const data = responses(); data['repos/owner/repo/pulls/1/reviews?per_page=100'] = [];
  data['repos/owner/repo/pulls/1/reviews'] = { id: 200 };
  const f = fixture(t, data); saveResult(f, publishedTask(), result());
  const run = f.run('agent.mjs', 'publish'); assert.equal(run.status, 0, run.stderr);
  const calls = f.calls(), created = calls.findIndex(c => c.args.includes('repos/owner/repo/pulls/1/reviews'));
  const queued = calls.findIndex(c => c.args.some(a => a.endsWith('/dispatches')));
  assert.ok(queued > created);
  const payload = JSON.parse(calls[queued].input).inputs;
  assert.equal(payload.mode, 'repair'); assert.equal(payload.repair_source, 'review'); assert.equal(payload.target, '1');
  assert.equal(payload.review_id, '200'); assert.equal(payload.expected_sha, a);
  assert.deepEqual(JSON.parse(payload.review_findings), [finding()]);
  const body = JSON.parse(calls[created].input).body;
  assert.match(body, /Codex Review Agent — Changes needed/);
  assert.equal(JSON.parse(calls[created].input).event, 'COMMENT');
  assert.equal(calls.at(-1).args[calls.at(-1).args.indexOf('--method') + 1], 'PUT');
});
test('green-CI review repair prepares and reserves without requiring CI failure, labels or author opt-in', t => {
  const f = fixture(t, responses());
  const prepared = f.run('agent.mjs', 'prepare', env); assert.equal(prepared.status, 0, prepared.stderr);
  const task = JSON.parse(readFileSync(path.join(f.work, 'task.json')));
  assert.equal(task.review_id, 200); assert.equal(task.ci_run_id, undefined); assert.deepEqual(task.context.review_findings, [finding()]);
  assert.equal(task.budget.attempt, 1);
  const reserved = f.run('agent.mjs', 'reserve', env); assert.equal(reserved.status, 0, reserved.stderr);
  assert.match(JSON.parse(f.calls().at(-1).input).body, /Investigating review findings · Attempt 1\/3/);
});
test('CI and review requests for one revision coalesce before reservation and a duplicate consumes no attempt', t => {
  const data = responses(); data['repos/owner/repo/actions/workflows/CI.yml/runs?head_sha=' + a + '&status=failure&per_page=10'] = { workflow_runs: [data['repos/owner/repo/actions/runs/123']] };
  const f = fixture(t, data);
  assert.equal(f.run('agent.mjs', 'prepare', env).status, 0);
  assert.equal(f.run('agent.mjs', 'reserve', env).status, 0);
  const task = JSON.parse(readFileSync(path.join(f.work, 'task.json')));
  assert.deepEqual(task.record.request_keys.sort(), ['ci:123:1', 'review:200']);
  const next = fixture(t, { ...data, 'repos/owner/repo/issues/1/comments?per_page=100': [{ id: 101, user: { login: BOT, type: 'Bot' }, body: marker(task.record) }] });
  const duplicate = next.run('agent.mjs', 'prepare', { CODEX_MODE: 'repair', CODEX_TARGET: '123' });
  assert.equal(duplicate.status, 0, duplicate.stderr); assert.equal(existsSync(path.join(next.work, 'task.json')), false);
});
test('CI, review, CI consume the same three-attempt budget across bot commits', () => {
  const history = [
    { kind: 'repair', source: 'ci', cycle: 'shared', attempt: 1, input_sha: a, output_sha: b },
    { kind: 'repair', source: 'review', cycle: 'shared', attempt: 2, input_sha: b, output_sha: c },
  ];
  assert.equal(repairBudget(history, c, false, '', { source: 'ci' }).attempt, 3);
  history.push({ kind: 'repair', source: 'ci', cycle: 'shared', attempt: 3, input_sha: c, output_sha: d });
  const exhausted = repairBudget(history, d, false, '', { source: 'review' });
  assert.equal(exhausted.allowed, false); assert.equal(exhausted.reason_code, 'exhausted');
});
test('stale review requests stop before execution or source fetch', t => {
  const data = responses([], { head: b }), f = fixture(t, data);
  const run = f.run('agent.mjs', 'prepare', env);
  assert.equal(run.status, 0, run.stderr); assert.equal(existsSync(path.join(f.work, 'task.json')), false);
  assert.equal(existsSync(path.join(f.dir, 'git-calls.jsonl')), false);
});
test('tampered findings and reviews authored by humans cannot authorize repair', t => {
  for (const [input, source] of [[JSON.stringify([{ ...finding(), body: 'tampered' }]), review()], [JSON.stringify([finding()]), review({ user: { login: 'maintainer', type: 'User' } })]]) {
    const data = responses(); data['repos/owner/repo/pulls/1/reviews/200'] = source;
    const f = fixture(t, data), run = f.run('agent.mjs', 'prepare', { ...env, CODEX_REVIEW_FINDINGS: input });
    assert.notEqual(run.status, 0); assert.equal(existsSync(path.join(f.work, 'task.json')), false);
  }
});
test('protected and fork branches never receive review-triggered repair execution', t => {
  for (const fork of [false, true]) {
    const data = responses([], { protectedBranch: !fork });
    if (fork) data['repos/owner/repo/pulls/1'].head.repo.full_name = 'external/fork';
    const f = fixture(t, data), run = f.run('agent.mjs', 'prepare', env);
    assert.equal(run.status, 0, run.stderr); assert.equal(existsSync(path.join(f.work, 'task.json')), false);
    assert.equal(existsSync(path.join(f.dir, 'git-calls.jsonl')), false);
  }
});
test('disputed finding publishes an explanation, stops its path and leaves unrelated CI eligible', t => {
  const f = fixture(t, responses()); assert.equal(f.run('agent.mjs', 'prepare', env).status, 0); assert.equal(f.run('agent.mjs', 'reserve').status, 0);
  const task = JSON.parse(readFileSync(path.join(f.work, 'task.json')));
  const verification = { finding_key: finding().key, status: 'incorrect', explanation: 'The caller passes the original price, so the discount is applied once.' };
  saveResult(f, task, result({ outcome: 'no_change', review_status: 'not_applicable', findings: [], finding_verifications: [verification], summary: verification.explanation }));
  const run = f.run('agent.mjs', 'publish'); assert.equal(run.status, 0, run.stderr);
  const body = JSON.parse(f.calls().at(-1).input).body;
  assert.match(body, /Codex Repair Agent — Human input needed/); assert.match(body, /applied once/);
  const record = recordFrom({ user: { login: BOT, type: 'Bot' }, body });
  assert.equal(record.status, 'complete'); assert.equal(remainingFindings([record], task.budget.cycle, [finding()]).length, 0);
  assert.equal(repairBudget([record], a, true, '', { source: 'ci' }).attempt, 2);
});
test('repeated disputed findings are filtered without another reservation', t => {
  const record = { kind: 'repair', source: 'review', cycle: 'head-' + a, attempt: 1, input_sha: a, status: 'complete', finding_verifications: [{ finding_key: finding().key, status: 'not_reproduced', explanation: 'No failing case.' }] };
  const f = fixture(t, responses([record])), run = f.run('agent.mjs', 'prepare', env);
  assert.equal(run.status, 0, run.stderr); assert.equal(existsSync(path.join(f.work, 'task.json')), false);
});
test('unchanged findings on a new head remain eligible without duplicate inline comments', t => {
  const old = review(), data = responses(); data['repos/owner/repo/pulls/1/reviews?per_page=100'] = [old];
  data['repos/owner/repo/pulls/1/reviews'] = { id: 201 }; data['repos/owner/repo/pulls/1/reviews/201'] = { id: 201 };
  data['repos/owner/repo/pulls/1'].head.sha = b;
  const task = { ...publishedTask(), head_sha: b, previous_findings: [finding().key], previous_structured_findings: [finding()] };
  const f = fixture(t, data); saveResult(f, task, result({ findings: [{ ...defect, line: 9, previous_key: finding().key }] }));
  const run = f.run('agent.mjs', 'publish'); assert.equal(run.status, 0, run.stderr);
  const created = f.calls().find(c => c.args.includes('repos/owner/repo/pulls/1/reviews'));
  const output = JSON.parse(created.input); assert.deepEqual(output.comments, []); assert.match(output.body, /Changes needed/);
  const queued = f.calls().find(c => c.args.some(a => a.endsWith('/dispatches')));
  assert.equal(JSON.parse(queued.input).inputs.expected_sha, b);
});
test('optional suggestions publish feedback without repair', t => {
  const data = responses(); data['repos/owner/repo/pulls/1/reviews?per_page=100'] = []; data['repos/owner/repo/pulls/1/reviews'] = { id: 200 };
  const f = fixture(t, data); saveResult(f, publishedTask(), result({ findings: [{ ...defect, priority: 'P3', actionable: false }] }));
  const run = f.run('agent.mjs', 'publish'); assert.equal(run.status, 0, run.stderr);
  assert.ok(!f.calls().some(c => c.args.some(a => a.endsWith('/dispatches'))));
});
test('incomplete and partial reviews never publish a clean heading', t => {
  for (const partial of [false, true]) {
    const data = responses(); data['repos/owner/repo/pulls/1/reviews?per_page=100'] = []; data['repos/owner/repo/pulls/1/reviews'] = { id: 200 };
    const task = publishedTask(); task.context.pr.diff_is_partial = partial;
    const f = fixture(t, data); saveResult(f, task, result({ review_status: partial ? 'complete' : 'incomplete', findings: [], unresolved: partial ? [] : ['Tool access failed.'] }));
    const run = f.run('agent.mjs', 'publish'); assert.equal(run.status, 0, run.stderr);
    const body = JSON.parse(f.calls().at(-1).input).body;
    assert.match(body, /Review incomplete/); assert.ok(!body.includes('No significant issues found'));
  }
});
test('a duplicate review signal recovers a missing dispatch without a new model execution', t => {
  const f = fixture(t, responses()), run = f.run('agent.mjs', 'prepare', { CODEX_MODE: 'review', CODEX_TARGET: '1' });
  assert.equal(run.status, 0, run.stderr); assert.equal(existsSync(path.join(f.work, 'task.json')), false);
  assert.ok(f.calls().some(c => c.args.some(a => a.endsWith('/dispatches'))));
});
test('already requested repair is not dispatched again by duplicate review events', t => {
  const data = responses(); data['repos/owner/repo/pulls/1/reviews?per_page=100'][0].body = marker({ ...recordFrom(review()), repair_requested: true });
  const f = fixture(t, data), run = f.run('agent.mjs', 'prepare', { CODEX_MODE: 'review', CODEX_TARGET: '1' });
  assert.equal(run.status, 0, run.stderr); assert.ok(!f.calls().some(c => c.args.some(a => a.endsWith('/dispatches'))));
});
test('the head is checked again immediately before executing Codex', t => {
  const f = fixture(t, responses([], { head: b }));
  writeFileSync(path.join(f.work, 'task.json'), JSON.stringify({ mode: 'review', number: 1, repo: 'owner/repo', head_sha: a }));
  const output = path.join(f.dir, 'outputs'); const run = f.run('agent.mjs', 'recheck', { GITHUB_OUTPUT: output });
  assert.equal(run.status, 0, run.stderr); assert.match(readFileSync(output, 'utf8'), /current=false/);
});
test('review completion is independently downgraded when repository reads fail', () => {
  for (const audit of [[], [{ tool: 'read_file', success: false }], [{ tool: 'read_file', success: true }, { tool: 'search', success: false }]]) {
    const output = enforceReviewCompletion(result({ findings: [] }), 'review', audit);
    assert.equal(output.review_status, 'incomplete'); assert.ok(output.unresolved.length);
  }
  assert.equal(enforceReviewCompletion(result(), 'review', [{ tool: 'read_file', success: true }, { tool: 'read_file', success: false, optional_instruction: true }]).review_status, 'complete');
});
test('result validation requires actionable classification and complete finding verification', () => {
  assert.throws(() => validateResult(result({ findings: [{ ...defect, priority: 'P3' }] }), 'review'));
  assert.throws(() => validateResult(result({ review_status: 'incomplete', unresolved: [] }), 'review'));
  const output = result({ outcome: 'changes', review_status: 'not_applicable', findings: [], finding_verifications: [] });
  assert.throws(() => validateRepairVerification(output, [finding()]));
  output.finding_verifications = [{ finding_key: finding().key, status: 'verified_fixed', explanation: 'Fixed.' }];
  assert.throws(() => validateRepairVerification(output, [finding()]), /regression/);
  output.tests = [{ command: 'unit regression test', status: 'passed', details: 'Failed before the fix; passes after.' }];
  assert.doesNotThrow(() => validateRepairVerification(output, [finding()]));
});
test('finding identities survive line movement and validated previous-key reuse', () => {
  assert.equal(findingKey(defect), findingKey({ ...defect, line: 200 }));
  assert.equal(canonicalFindings([{ ...defect, title: 'Reworded defect', previous_key: finding().key }], [finding()])[0].key, finding().key);
  assert.throws(() => canonicalFindings([{ ...defect, previous_key: 'b'.repeat(20) }], [finding()]));
});

test('blocked findings stop only their own path while different findings remain eligible', () => {
  const record = { kind: 'repair', source: 'review', cycle: 'same', attempt: 1, input_sha: a, status: 'complete',
    finding_verifications: [{ finding_key: finding().key, status: 'blocked', explanation: 'Missing reproduction input.' }] };
  const other = canonicalFindings([{ ...defect, title: 'Handle an independent rounding defect' }])[0];
  assert.deepEqual(remainingFindings([record], 'same', [finding(), other]), [other]);
  assert.equal(repairBudget([record], a, true, '', { source: 'review' }).attempt, 2);
});
test('stale-credential redispatch preserves the exact review repair request', t => {
  const f = fixture(t, { 'repos/owner/repo/actions/secrets/CODEX_AUTH_JSON_B64': { updated_at: '2026-11-03T00:00:00Z' },
    'repos/owner/repo/actions/workflows/codex-agent.yml/dispatches': null });
  writeFileSync(path.join(f.work, 'task.json'), JSON.stringify({ created_at: '2026-11-02T00:00:00Z', mode: 'repair', target: 1,
    head_sha: a, repair_source: 'review', review_id: 200, requested_findings: [finding()] }));
  const run = f.run('auth.mjs', 'restore', { CODEX_AUTH_JSON_B64: 'invalid-unused-snapshot', CODEX_DISPATCH_TOKEN: 'job-token' });
  assert.equal(run.status, 0, run.stderr);
  const inputs = JSON.parse(f.calls().at(-1).input).inputs;
  assert.equal(inputs.target, '1'); assert.equal(inputs.repair_source, 'review'); assert.equal(inputs.review_id, '200');
  assert.equal(inputs.expected_sha, a); assert.deepEqual(JSON.parse(inputs.review_findings), [finding()]);
});

test('successful same-file retries recover lookup errors while unrelated reads do not', () => {
  const failed = { tool: 'read_file', path: '/workspace/src/a.ts', success: false };
  const recovered = enforceReviewCompletion(result(), 'review', [failed, { tool: 'read_file', path: 'src/a.ts', success: true }], ['src/a.ts']);
  assert.equal(recovered.review_status, 'complete');
  const unrelated = enforceReviewCompletion(result(), 'review', [failed, { tool: 'read_file', path: 'src/b.ts', success: true }], ['src/a.ts', 'src/b.ts']);
  assert.equal(unrelated.review_status, 'incomplete');
  assert.equal(enforceReviewCompletion(result(), 'review', [{ tool: 'read_file', path: '/workspace/src/a.ts', success: true }], ['src/a.ts']).review_status, 'complete');
});
test('a recovered lookup never upgrades a model-reported incomplete review', () => {
  const output = enforceReviewCompletion(result({ review_status: 'incomplete', unresolved: ['Required external specification unavailable.'] }), 'review',
    [{ tool: 'read_file', path: 'src/a.ts', success: true }], ['src/a.ts']);
  assert.equal(output.review_status, 'incomplete');
});

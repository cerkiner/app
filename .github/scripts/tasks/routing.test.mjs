import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fixture, repairResponses } from './fixtures.mjs';
import { BOT, marker } from './lib.mjs';
import { documentationOnly } from './validation.mjs';

const head = 'a'.repeat(40);
const event = { GITHUB_EVENT_NAME: 'workflow_run', CODEX_MODE: 'auto', CODEX_TARGET: '123' };
function data(conclusion) {
  const responses = repairResponses();
  Object.assign(responses['repos/owner/repo/actions/runs/123'], { conclusion });
  responses['repos/owner/repo/actions/runs/50'].event = 'workflow_run';
  responses['repos/owner/repo/actions/runs/123/attempts/1/jobs?per_page=100'].jobs[0].conclusion = conclusion;
  return responses;
}
test('one completed PR checks run selects review on success and repair on failure', t => {
  for (const [conclusion, mode] of [['success', 'review'], ['failure', 'repair'], ['timed_out', 'repair']]) {
    const f = fixture(t, data(conclusion));
    const run = f.run('tasks.mjs', 'prepare', event); assert.equal(run.status, 0, run.stderr);
    const task = JSON.parse(readFileSync(path.join(f.work, 'task.json')));
    assert.equal(task.mode, mode); assert.equal(task.number, 1); assert.equal(task.head_sha, head);
    assert.equal(task.source_run_id, 123);
    assert.ok(!f.calls().some(call => call.args.some(value => /\/(?:dispatches|approve)$/.test(value))));
  }
});
test('canceled, skipped and superseded PR checks do not select an execution', t => {
  for (const conclusion of ['cancelled', 'skipped']) {
    const f = fixture(t, data(conclusion));
    assert.equal(f.run('tasks.mjs', 'prepare', event).status, 0);
    assert.ok(!existsSync(path.join(f.work, 'task.json')));
  }
  const responses = data('success'); responses['repos/owner/repo/pulls/1'].head.sha = 'b'.repeat(40);
  const f = fixture(t, responses);
  assert.equal(f.run('tasks.mjs', 'prepare', event).status, 0);
  assert.ok(!existsSync(path.join(f.work, 'task.json')));
});
test('another workflow cannot authorize a follow-up by copying the PR check name', t => {
  const responses = data('success'); responses['repos/owner/repo/actions/runs/123'].path = '.github/workflows/CI.yml';
  const f = fixture(t, responses), run = f.run('tasks.mjs', 'prepare', event);
  assert.notEqual(run.status, 0); assert.ok(!existsSync(path.join(f.work, 'task.json')));
});
test('descriptive run titles are allowed but a mismatched workflow ID is rejected', t => {
  const responses = data('success'); responses['repos/owner/repo/actions/runs/123'].name = 'PR checks #1 - Documentation update';
  const f = fixture(t, responses); assert.equal(f.run('tasks.mjs', 'prepare', event).status, 0);
  responses['repos/owner/repo/actions/runs/123'].workflow_id = 2;
  writeFileSync(path.join(f.dir, 'responses.json'), JSON.stringify({ ...responses,
    'repos/owner/repo/actions/workflows/pr-checks.yml': { id: 1, path: '.github/workflows/pr-checks.yml', name: 'PR checks' } }));
  assert.notEqual(f.run('tasks.mjs', 'prepare', event).status, 0);
});
test('review waits until the originating task has finished publication', t => {
  const responses = data('success');
  responses['repos/owner/repo/pulls/1'].user = { login: BOT, type: 'Bot' };
  responses['repos/owner/repo/pulls/1'].body = marker({ kind: 'origin', issue: 7, run_id: 42 });
  responses['repos/owner/repo/issues/7/comments?per_page=100'] = [];
  const f = fixture(t, responses), run = f.run('tasks.mjs', 'prepare', event);
  assert.equal(run.status, 0, run.stderr); assert.ok(!existsSync(path.join(f.work, 'task.json')));
  assert.ok(JSON.parse(f.calls().at(-1).input).body.includes('not finished publishing'));
});
test('deployment investigation uses the artifact revision and deduplicates its exact attempt', t => {
  const responses = data('failure');
  responses['repos/owner/repo/issues/7'] = { number: 7, state: 'open', title: 'Publication failed', body: 'Sanitized incident', user: { login: BOT } };
  responses['repos/owner/repo/issues/7/comments?per_page=100'] = [];
  responses['repos/owner/repo/pulls?state=all&head=owner%3Adeployment-123-2&per_page=100'] = [];
  const f = fixture(t, responses);
  writeFileSync(path.join(f.work, 'deployment-context.json'), JSON.stringify({ repo: 'owner/repo', run_id: 123, attempt: 2, issue_number: 7, source_sha: head, source_build: 120, workflow_sha: 'b'.repeat(40) }));
  const run = f.run('tasks.mjs', 'prepare', { CODEX_MODE: 'deployment', CODEX_TARGET: '123' });
  assert.equal(run.status, 0, run.stderr);
  const task = JSON.parse(readFileSync(path.join(f.work, 'task.json')));
  assert.equal(task.head_sha, head); assert.equal(task.branch, 'deployment-123-2');
  assert.equal(task.context.deployment.source_build, 120);
  responses['repos/owner/repo/issues/7/comments?per_page=100'] = [{ user: { login: BOT, type: 'Bot' }, body: marker({ kind: 'deployment', status: 'complete', source_run: 123, source_attempt: 2 }) }];
  writeFileSync(path.join(f.dir, 'responses.json'), JSON.stringify(responses));
  const output = path.join(f.dir, 'outputs');
  assert.equal(f.run('tasks.mjs', 'prepare', { CODEX_MODE: 'deployment', CODEX_TARGET: '123', GITHUB_OUTPUT: output }).status, 0);
  assert.equal(readFileSync(output, 'utf8').trim(), 'proceed=false');
});
test('a published review continues into an independent repair in the same workflow', t => {
  const finding = { key: 'c'.repeat(20), priority: 'P2', actionable: true, previous_key: null,
    title: 'Correct a broken link', body: 'The documentation points at an absent command.', path: 'README.md', line: 2 };
  const review = { id: 200, state: 'COMMENTED', commit_id: head, user: { login: BOT, type: 'Bot' },
    body: marker({ kind: 'review', head_sha: head, review_status: 'complete', findings: [finding], finding_keys: [finding.key], repair_requested: true }) };
  const responses = data('success');
  responses['repos/owner/repo/pulls/1/reviews?per_page=100'] = [review];
  responses['repos/owner/repo/pulls/1/reviews/200'] = review;
  responses['repos/owner/repo/actions/workflows/pr-checks.yml/runs?head_sha=' + head + '&status=failure&per_page=10'] = { workflow_runs: [] };
  const f = fixture(t, responses);
  writeFileSync(path.join(f.work, 'repair-request.json'), JSON.stringify({ target: 1, head, review_id: 200, source: 'review' }));
  const run = f.run('tasks.mjs', 'prepare-repair', event); assert.equal(run.status, 0, run.stderr);
  const task = JSON.parse(readFileSync(path.join(f.work, 'task.json')));
  assert.equal(task.mode, 'repair'); assert.equal(task.repair_source, 'review');
  assert.deepEqual(task.context.review_findings, [finding]); assert.equal(task.budget.attempt, 1);
  assert.equal(f.run('tasks.mjs', 'reserve').status, 0);
  assert.ok(!f.calls().some(call => call.args.some(value => value.endsWith('/dispatches'))));
});
test('documentation fast path requires complete metadata and considers both sides of a rename', () => {
  assert.equal(documentationOnly([{ filename: 'README.md' }], 1), true);
  assert.equal(documentationOnly([{ filename: 'docs/help.md', previous_filename: 'src/help.ts' }], 1), false);
  assert.equal(documentationOnly([{ filename: '.github/prompts/review.md' }], 1), false);
  assert.equal(documentationOnly([{ filename: 'src/assets/readme.md' }], 1), false);
  assert.equal(documentationOnly([{ filename: 'README.md' }], 2), false);
  assert.equal(documentationOnly([], 0), false);
});
test('raw auth preserves extra fields and malformed snapshots fail without disclosure', t => {
  const responses = { 'repos/owner/repo/actions/secrets/CODEX_CHATGPT_AUTH_JSON': { updated_at: '2026-11-01T00:00:00Z' } };
  const f = fixture(t, responses); writeFileSync(path.join(f.work, 'task.json'), JSON.stringify({ created_at: '2026-11-02T00:00:00Z' }));
  const raw = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a'.repeat(20), refresh_token: 'b'.repeat(20), id_token: 'c'.repeat(20), extra: 'preserved-field' }, account: { additional: true } }, null, 2);
  assert.equal(f.run('auth.mjs', 'restore', { CODEX_CHATGPT_AUTH_JSON: raw }).status, 0);
  assert.equal(readFileSync(path.join(f.work, 'credentials/auth.json'), 'utf8'), raw);
  const malformed = f.run('auth.mjs', 'restore', { CODEX_CHATGPT_AUTH_JSON: 'private-malformed-value' });
  assert.notEqual(malformed.status, 0); assert.ok(!malformed.stderr.includes('private-malformed-value'));
});
test('persistence still saves a rotated raw file after task setup fails', t => {
  const f = fixture(t, { 'repos/owner/repo/actions/secrets/CODEX_CHATGPT_AUTH_JSON': { updated_at: '2026-11-01T00:00:00Z' } });
  writeFileSync(path.join(f.work, 'task.json'), JSON.stringify({ created_at: '2026-11-02T00:00:00Z', mode: 'issue', head_sha: head, context: {} }));
  const auth = { auth_mode: 'chatgpt', tokens: { access_token: 'a'.repeat(20), refresh_token: 'b'.repeat(20), id_token: 'c'.repeat(20) } };
  assert.equal(f.run('auth.mjs', 'restore', { CODEX_CHATGPT_AUTH_JSON: JSON.stringify(auth) }).status, 0);
  const rotated = { ...auth, tokens: { ...auth.tokens, refresh_token: 'rotated-synthetic-login' } };
  writeFileSync(path.join(f.work, 'credentials/auth.json'), JSON.stringify(rotated));
  assert.notEqual(f.run('execution.mjs', '').status, 0);
  const persisted = f.run('auth.mjs', 'persist'); assert.equal(persisted.status, 0, persisted.stderr);
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.dir, 'saved-secret'))), rotated);
  assert.equal(f.run('auth.mjs', 'persist').status, 0);
  assert.equal(f.calls().filter(call => call.args[0] === 'secret').length, 1);
  assert.equal(JSON.parse(readFileSync(path.join(f.work, 'artifacts/authentication.json'))).persistence, 'saved');
});

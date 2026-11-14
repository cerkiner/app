import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildCommit, pushArguments } from './agent.mjs';
import { marker, BOT } from './lib.mjs';

import { fixture, repairResponses } from './fixtures.mjs';

const a = 'a'.repeat(40), b = 'b'.repeat(40);
const auth = { auth_mode: 'chatgpt', tokens: { access_token: 'test-access-value-123', refresh_token: 'test-refresh-value-456', id_token: 'test-id-value-789' }, last_refresh: '2026-11-01T00:00:00Z' };
test('auth restores on a fresh runner, writes the actual rotated file via stdin, then erases it', t => {
  const f = fixture(t, { 'repos/owner/repo/actions/secrets/CODEX_AUTH_JSON_B64': { updated_at: '2026-11-01T00:00:00Z' } });
  writeFileSync(path.join(f.work, 'task.json'), JSON.stringify({ created_at: '2026-11-02T00:00:00Z' }));
  const restored = f.run('auth.mjs', 'restore', { CODEX_AUTH_JSON_B64: Buffer.from(JSON.stringify(auth)).toString('base64') });
  assert.equal(restored.status, 0, restored.stderr);
  const file = path.join(f.work, 'credentials/auth.json');
  assert.deepEqual(JSON.parse(readFileSync(file)), auth);
  const rotated = { ...auth, tokens: { ...auth.tokens, refresh_token: 'rotated-refresh-value-999' } };
  writeFileSync(file, JSON.stringify(rotated));
  const persisted = f.run('auth.mjs', 'persist');
  assert.equal(persisted.status, 0, persisted.stderr);
  assert.deepEqual(JSON.parse(Buffer.from(readFileSync(path.join(f.dir, 'saved-secret'), 'utf8'), 'base64')), rotated);
  assert.ok(!JSON.stringify(f.calls().at(-1).args).includes('rotated-refresh'));
  assert.ok(!persisted.stdout.includes('rotated-refresh') && !restored.stdout.includes('test-access'));
  assert.equal(f.run('auth.mjs', 'cleanup').status, 0);
  assert.equal(existsSync(file), false);
});
test('unchanged auth avoids unnecessary secret rotations and stale queue churn', t => {
  const f = fixture(t, { 'repos/owner/repo/actions/secrets/CODEX_AUTH_JSON_B64': { updated_at: '2026-11-01T00:00:00Z' } });
  writeFileSync(path.join(f.work, 'task.json'), JSON.stringify({ created_at: '2026-11-02T00:00:00Z' }));
  assert.equal(f.run('auth.mjs', 'restore', { CODEX_AUTH_JSON_B64: Buffer.from(JSON.stringify(auth)).toString('base64') }).status, 0);
  assert.equal(f.run('auth.mjs', 'persist').status, 0);
  assert.equal(existsSync(path.join(f.dir, 'saved-secret')), false);
});
test('stale queued runner redispatches without decoding credentials or reserving an attempt', t => {
  const f = fixture(t, {
    'repos/owner/repo/actions/secrets/CODEX_AUTH_JSON_B64': { updated_at: '2026-11-03T00:00:00Z' },
    'repos/owner/repo/actions/workflows/codex-agent.yml/dispatches': null,
  });
  writeFileSync(path.join(f.work, 'task.json'), JSON.stringify({ created_at: '2026-11-02T00:00:00Z', mode: 'review', target: 12, head_sha: a }));
  const run = f.run('auth.mjs', 'restore', { CODEX_AUTH_JSON_B64: 'deliberately-not-valid-base64', CODEX_DISPATCH_TOKEN: 'test-job-token' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(path.join(f.work, 'credentials/auth.json')), false);
  assert.equal(JSON.parse(f.calls().at(-1).input).inputs.target, '12');
});
test('expired PAT fails explicitly without leaking credential values', t => {
  const f = fixture(t);
  writeFileSync(path.join(f.work, 'task.json'), '{}');
  const run = f.run('auth.mjs', 'restore', { CODEX_AUTH_JSON_B64: 'private-auth-secret' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /GH_PAT expiry/);
  assert.ok(!run.stderr.includes('private-auth-secret'));
});
test('a collaborator issue runs automatically in a public repository without a visibility gate', t => {
  const f = fixture(t, {
    'repos/owner/repo': { visibility: 'public', default_branch: 'master' },
    'repos/owner/repo/actions/runs/50': { id: 50, created_at: '2026-11-02T00:00:00Z' },
    'repos/owner/repo/issues/1': { number: 1, state: 'open', title: 'Fix the bug', body: 'Steps', user: { login: 'maintainer', type: 'User' } },
    'repos/owner/repo/commits/master': { sha: a },
    'repos/owner/repo/issues/1/comments?per_page=100': [],
    'repos/owner/repo/collaborators/maintainer/permission': { permission: 'admin' },
    'repos/owner/repo/pulls?state=all&head=owner%3Acodex%2Fissue-1&per_page=100': [],
  });
  const run = f.run('agent.mjs', 'prepare');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(f.work, 'task.json'))).mode, 'issue');
  assert.equal(existsSync(path.join(f.dir, 'git-calls.jsonl')), true);
  assert.ok(!f.calls().some(c => c.args.some(a => a.includes('/secrets/'))));
});
test('every new issue starts investigation regardless of creator and without extra metadata', t => {
  const f = fixture(t, {
    'repos/owner/repo': { visibility: 'public', default_branch: 'master' },
    'repos/owner/repo/actions/runs/50': { id: 50, created_at: '2026-11-02T00:00:00Z' },
    'repos/owner/repo/issues/1': { number: 1, state: 'open', title: 'Fix the bug', body: 'Steps', user: { login: 'outsider', type: 'User' } },
    'repos/owner/repo/commits/master': { sha: a },
    'repos/owner/repo/issues/1/comments?per_page=100': [],
    'repos/owner/repo/pulls?state=all&head=owner%3Acodex%2Fissue-1&per_page=100': [],
  });
  const run = f.run('agent.mjs', 'prepare');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(f.work, 'task.json'))).context.issue.author, 'outsider');
  assert.equal(existsSync(path.join(f.dir, 'git-calls.jsonl')), true);
  assert.ok(!f.calls().some(c => c.args.some(a => a.includes('/collaborators/'))));
});
test('fork PRs receive a read-only review through the base repository PR head ref', t => {
  const responses = repairResponses();
  responses['repos/owner/repo/pulls/1'].head.repo.full_name = 'contributor/fork';
  responses['repos/owner/repo/pulls/1'].user = { login: 'contributor', type: 'User' };
  const f = fixture(t, responses);
  const run = f.run('agent.mjs', 'prepare', { CODEX_MODE: 'review' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(f.work, 'task.json'))).mode, 'review');
  assert.match(readFileSync(path.join(f.dir, 'git-calls.jsonl'), 'utf8'), /refs\/pull\/1\/head/);
  assert.ok(!f.calls().some(c => c.args.some(a => a.includes('/collaborators/'))));
});
test('fork ref changes during fetch abort the stale review before execution', t => {
  const responses = repairResponses(); responses['repos/owner/repo/pulls/1'].head.repo.full_name = 'contributor/fork';
  const f = fixture(t, responses);
  const run = f.run('agent.mjs', 'prepare', { CODEX_MODE: 'review', FIXTURE_FETCHED_SHA: b });
  assert.notEqual(run.status, 0); assert.match(run.stderr, /head changed during fetch/);
  assert.equal(existsSync(path.join(f.work, 'task.json')), false);
});
test('repair does not fetch or modify an external contributor branch', t => {
  const responses = repairResponses(); responses['repos/owner/repo/actions/runs/123'].head_repository.full_name = 'contributor/fork';
  const f = fixture(t, responses);
  const run = f.run('agent.mjs', 'prepare', { CODEX_MODE: 'repair', CODEX_TARGET: '123' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(path.join(f.work, 'task.json')), false);
  assert.equal(existsSync(path.join(f.dir, 'git-calls.jsonl')), false);
});
test('completed issue records prevent another implementation run', t => {
  const f = fixture(t, {
    'repos/owner/repo': { visibility: 'private', default_branch: 'master' },
    'repos/owner/repo/actions/runs/50': { id: 50, created_at: '2026-11-02T00:00:00Z' },
    'repos/owner/repo/issues/1': { number: 1, state: 'open', user: { login: 'maintainer', type: 'User' } },
    'repos/owner/repo/commits/master': { sha: a },
    'repos/owner/repo/issues/1/comments?per_page=100': [{ user: { login: BOT, type: 'Bot' }, body: marker({ kind: 'issue', status: 'complete' }) }],
    'repos/owner/repo/collaborators/maintainer/permission': { permission: 'write' },
  });
  const run = f.run('agent.mjs', 'prepare');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(path.join(f.work, 'task.json')), false);
});
test('an issue with a previous infrastructure failure can be retried after recovery', t => {
  const f = fixture(t, {
    'repos/owner/repo': { visibility: 'public', default_branch: 'master' },
    'repos/owner/repo/actions/runs/50': { id: 50, created_at: '2026-11-02T00:00:00Z' },
    'repos/owner/repo/issues/1': { number: 1, state: 'open', title: 'Investigate', body: 'Steps', user: { login: 'creator', type: 'User' } },
    'repos/owner/repo/commits/master': { sha: a },
    'repos/owner/repo/issues/1/comments?per_page=100': [{ user: { login: BOT, type: 'Bot' }, body: marker({ kind: 'issue', status: 'complete', outcome: 'external_failure' }) }],
    'repos/owner/repo/pulls?state=all&head=owner%3Acodex%2Fissue-1&per_page=100': [],
  });
  const run = f.run('agent.mjs', 'prepare');
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(f.work, 'task.json'))).mode, 'issue');
});
test('a non-coding issue result publishes findings without Git operations or a PR', t => {
  const f = fixture(t, { 'repos/owner/repo/issues/comments/101': { id: 101 } });
  writeFileSync(path.join(f.work, 'task.json'), JSON.stringify({ mode: 'issue', repo: 'owner/repo', number: 1, run_id: 50,
    comment_id: 101, record: { kind: 'issue', status: 'started', run_id: 50 } }));
  mkdirSync(path.join(f.work, 'artifacts'));
  writeFileSync(path.join(f.work, 'artifacts/result.json'), JSON.stringify({ outcome: 'needs_info', review_status: 'not_applicable', finding_verifications: [], title: 'Clarify behavior',
    summary: 'Please provide reproduction steps.', investigated: ['README'], tests: [], unresolved: ['Expected behavior is unclear.'], findings: [] }));
  const run = f.run('agent.mjs', 'publish');
  assert.equal(run.status, 0, run.stderr);
  assert.match(JSON.parse(f.calls().at(-1).input).body, /Please provide reproduction steps/);
  assert.equal(existsSync(path.join(f.dir, 'git-calls.jsonl')), false);
  assert.ok(!f.calls().some(c => c.args.some(a => /\/pulls/.test(a))));
});
test('any repository-owned failed PR reserves repair automatically without metadata or provenance', t => {
  const f = fixture(t, repairResponses());
  const run = f.run('agent.mjs', 'prepare', { CODEX_MODE: 'repair', CODEX_TARGET: '123' });
  assert.equal(run.status, 0, run.stderr);
  const task = JSON.parse(readFileSync(path.join(f.work, 'task.json')));
  assert.equal(task.head_sha, a); assert.equal(task.ci_run_id, 123); assert.equal(task.budget.attempt, 1);
  assert.equal(task.context.ci.failed_jobs[0].steps[0], 'Run tests');
  assert.equal(f.run('agent.mjs', 'reserve').status, 0);
  const reserved = JSON.parse(readFileSync(path.join(f.work, 'task.json')));
  assert.equal(reserved.record.attempt, 1); assert.equal(reserved.record.input_sha, a); assert.equal(reserved.comment_id, 101);
});
test('protected branches never reserve a repair or fetch source', t => {
  for (const options of [{ protectedBranch: true }]) {
    const f = fixture(t, repairResponses([], options));
    const run = f.run('agent.mjs', 'prepare', { CODEX_MODE: 'repair', CODEX_TARGET: '123' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(existsSync(path.join(f.work, 'task.json')), false);
    assert.equal(existsSync(path.join(f.dir, 'git-calls.jsonl')), false);
  }
});
test('exhausted repair budget reports remaining checks and requests human intervention', t => {
  const history = [1, 2, 3].map(attempt => ({ kind: 'repair', cycle: 'cycle-1', attempt, input_sha: a, output_sha: b, status: 'complete' }));
  const f = fixture(t, repairResponses(history, { head: b }));
  const run = f.run('agent.mjs', 'prepare', { CODEX_MODE: 'repair', CODEX_TARGET: '123' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(path.join(f.work, 'task.json')), false);
  const text = JSON.parse(f.calls().at(-1).input).body;
  assert.match(text, /exhausted/); assert.match(text, /Human intervention/); assert.match(text, /Validate app/);
});
test('same failing CI attempt does not consume a second repair reservation', t => {
  const record = { kind: 'repair', cycle: 'cycle-1', attempt: 1, input_sha: a, ci_run_id: 123, ci_run_attempt: 1, status: 'reserved' };
  const f = fixture(t, repairResponses([record]));
  const run = f.run('agent.mjs', 'prepare', { CODEX_MODE: 'repair', CODEX_TARGET: '123' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(path.join(f.work, 'task.json')), false);
});
test('maintainer can explicitly open a new cycle for the same CI run', t => {
  const history = [1, 2, 3].map(attempt => ({ kind: 'repair', cycle: 'old-cycle', attempt, input_sha: a, ci_run_id: 123, ci_run_attempt: 1 }));
  const f = fixture(t, repairResponses(history));
  const run = f.run('agent.mjs', 'prepare', { CODEX_MODE: 'repair', CODEX_TARGET: '123', CODEX_NEW_CYCLE: 'true' });
  assert.equal(run.status, 0, run.stderr);
  const task = JSON.parse(readFileSync(path.join(f.work, 'task.json')));
  assert.equal(task.budget.cycle, 'manual-50'); assert.equal(task.budget.attempt, 1); assert.equal(task.cycle_request, 50);
});
test('a signed web-editor revision resets an exhausted prior repair cycle using the human author permission', t => {
  const history = [1, 2, 3].map(attempt => ({ kind: 'repair', cycle: 'old-cycle', attempt, input_sha: a, output_sha: b }));
  const head = 'c'.repeat(40), responses = repairResponses(history, { head });
  responses[`repos/owner/repo/commits/${head}`] = { author: { login: 'maintainer', type: 'User' },
    committer: { login: 'web-flow', type: 'User' }, commit: { verification: { verified: true } } };
  const f = fixture(t, responses);
  const run = f.run('agent.mjs', 'prepare', { CODEX_MODE: 'repair', CODEX_TARGET: '123' });
  assert.equal(run.status, 0, run.stderr);
  const task = JSON.parse(readFileSync(path.join(f.work, 'task.json')));
  assert.equal(task.budget.cycle, `head-${head}`); assert.equal(task.budget.attempt, 1);
  assert.ok(!f.calls().some(c => c.args.some(a => a.includes('/collaborators/web-flow/'))));
});
test('unverified web-flow attribution cannot reset an exhausted repair cycle', t => {
  const history = [1, 2, 3].map(attempt => ({ kind: 'repair', cycle: 'old-cycle', attempt, input_sha: a, output_sha: b }));
  const head = 'c'.repeat(40), responses = repairResponses(history, { head });
  responses[`repos/owner/repo/commits/${head}`] = { author: { login: 'maintainer', type: 'User' },
    committer: { login: 'web-flow', type: 'User' }, commit: { verification: { verified: false } } };
  const f = fixture(t, responses);
  const run = f.run('agent.mjs', 'prepare', { CODEX_MODE: 'repair', CODEX_TARGET: '123' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(existsSync(path.join(f.work, 'task.json')), false);
  assert.match(JSON.parse(f.calls().at(-1).input).body, /Unknown bot revision/);
});
test('conflicted PR metadata dispatches the exact head without using a merge-ref completion signal', t => {
  const responses = repairResponses([], { head: b });
  responses['repos/owner/repo/pulls/1'].mergeable = false;
  responses['repos/owner/repo/actions/workflows/codex-agent.yml/dispatches'] = null;
  const f = fixture(t, responses), payload = path.join(f.dir, 'event.json');
  writeFileSync(payload, JSON.stringify({ action: 'opened', repository: { full_name: 'owner/repo' },
    pull_request: { number: 1, head: { sha: b }, base: { repo: { full_name: 'owner/repo' } } } }));
  const run = f.run('agent.mjs', 'request', { GITHUB_EVENT_NAME: 'pull_request_target', GITHUB_EVENT_PATH: payload }, ['review']);
  assert.equal(run.status, 0, run.stderr);
  const dispatch = JSON.parse(f.calls().at(-1).input);
  assert.equal(dispatch.ref, 'master'); assert.equal(dispatch.inputs.mode, 'review');
  assert.equal(dispatch.inputs.target, '1'); assert.equal(dispatch.inputs.expected_sha, b);
  assert.equal(existsSync(path.join(f.dir, 'git-calls.jsonl')), false);
  assert.ok(!f.calls().some(c => c.args.some(a => a.includes('/secrets/') || a.includes('/actions/runs/'))));
});
test('a collaborator PR with merge conflicts reaches review execution on a public repository', t => {
  const responses = repairResponses();
  responses['repos/owner/repo'].visibility = 'public';
  responses['repos/owner/repo/pulls/1'].mergeable = false;
  const f = fixture(t, responses);
  const run = f.run('agent.mjs', 'prepare', { CODEX_MODE: 'review', CODEX_TARGET: '1', CODEX_EXPECTED_SHA: a });
  assert.equal(run.status, 0, run.stderr);
  const task = JSON.parse(readFileSync(path.join(f.work, 'task.json')));
  assert.equal(task.mode, 'review'); assert.equal(task.head_sha, a);
  assert.ok(!f.calls().some(c => c.args.some(a => a.includes('/checks') || a.includes('/actions/runs/123'))));
});
test('a bot-authored PR is reviewed without origin records or collaborator status', t => {
  const responses = repairResponses();
  responses['repos/owner/repo/pulls/1'].user = { login: BOT, type: 'Bot' };
  const f = fixture(t, responses);
  const run = f.run('agent.mjs', 'prepare', { CODEX_MODE: 'review', CODEX_TARGET: '1' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(readFileSync(path.join(f.work, 'task.json'))).mode, 'review');
  assert.ok(!f.calls().some(c => c.args.some(a => a.includes(`/collaborators/${BOT}/`))));
});
test('review publishes a COMMENT with validated lines and never approves', t => {
  const f = fixture(t, {
    'repos/owner/repo/pulls/1': { head: { sha: a }, state: 'open' },
    'repos/owner/repo/pulls/1/reviews?per_page=100': [],
    'repos/owner/repo/pulls/1/reviews': { id: 200 },
  });
  const task = { mode: 'review', repo: 'owner/repo', number: 1, run_id: 50, head_sha: a, default_branch: 'master', previous_findings: [],
    context: { pr: {} }, files: [{ filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-old\n+new' }] };
  writeFileSync(path.join(f.work, 'task.json'), JSON.stringify(task));
  mkdirSync(path.join(f.work, 'artifacts'));
  writeFileSync(path.join(f.work, 'artifacts/result.json'), JSON.stringify({ outcome: 'review', review_status: 'complete', finding_verifications: [], title: 'Review', summary: 'One correctness defect.', investigated: ['src/a.ts'], tests: [], unresolved: [],
    findings: [{ path: 'src/a.ts', line: 1, priority: 'P1', actionable: false, previous_key: null, title: 'Handle missing value', body: 'The new path dereferences undefined.' }] }));
  const run = f.run('agent.mjs', 'publish');
  assert.equal(run.status, 0, run.stderr);
  const review = JSON.parse(f.calls().at(-1).input);
  assert.equal(review.event, 'COMMENT'); assert.equal(review.comments[0].line, 1); assert.equal(review.commit_id, a);
});
test('review skips publishing when a human has updated the head concurrently', t => {
  const f = fixture(t, { 'repos/owner/repo/pulls/1': { head: { sha: b }, state: 'open' } });
  writeFileSync(path.join(f.work, 'task.json'), JSON.stringify({ mode: 'review', repo: 'owner/repo', number: 1, head_sha: a }));
  mkdirSync(path.join(f.work, 'artifacts'));
  writeFileSync(path.join(f.work, 'artifacts/result.json'), JSON.stringify({ outcome: 'review', review_status: 'complete', finding_verifications: [], title: 'Review', summary: 'No findings', investigated: [], tests: [], unresolved: [], findings: [] }));
  const run = f.run('agent.mjs', 'publish');
  assert.equal(run.status, 0, run.stderr); assert.equal(f.calls().length, 1);
});

function localRepo(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-git-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'trusted'), work = path.join(dir, 'work');
  mkdirSync(root); mkdirSync(path.join(work, 'workspace'), { recursive: true });
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git(['init', '-q']); git(['config', 'user.name', 'Fixture']); git(['config', 'user.email', 'fixture@example.invalid']);
  writeFileSync(path.join(root, 'source.txt'), 'before\n'); writeFileSync(path.join(root, 'package.json'), '{"scripts":{"test":"test-command"}}\n');
  git(['add', '.']); git(['commit', '-qm', 'Initial']);
  for (const file of ['source.txt', 'package.json']) writeFileSync(path.join(work, 'workspace', file), readFileSync(path.join(root, file)));
  return { dir, root, work, git, task: { mode: 'repair', repo: 'owner/repo', number: 1, head_sha: git(['rev-parse', 'HEAD']), branch: 'feature' } };
}
test('publishing uses a separate trusted Git index, adds new files, and never runs source hooks', t => {
  const f = localRepo(t), ws = path.join(f.work, 'workspace');
  mkdirSync(path.join(ws, '.git/hooks'), { recursive: true });
  writeFileSync(path.join(ws, '.git/hooks/pre-commit'), `#!/bin/sh\ntouch '${path.join(f.dir, 'pwned')}'`, { mode: 0o755 });
  writeFileSync(path.join(ws, '.git/config'), '[core]\n hooksPath = .git/hooks\n');
  writeFileSync(path.join(ws, 'source.txt'), 'after\n'); writeFileSync(path.join(ws, 'new.txt'), 'new\n');
  const commit = buildCommit(f.task, { title: 'Fix source', summary: 'Correct the value' }, f);
  assert.equal(f.git(['show', `${commit}:source.txt`]), 'after');
  assert.equal(f.git(['show', `${commit}:new.txt`]), 'new');
  assert.equal(f.git(['rev-parse', `${commit}^`]), f.task.head_sha);
  assert.equal(existsSync(path.join(f.dir, 'pwned')), false);
});
test('review repairs require a real regression test change in the published patch', t => {
  const f = localRepo(t); f.task.review_findings = [{ key: 'a'.repeat(20) }];
  writeFileSync(path.join(f.work, 'workspace/source.txt'), 'fixed\n');
  assert.throws(() => buildCommit(f.task, { title: 'Fix', summary: 'Focused fix' }, f), /regression coverage/);
  writeFileSync(path.join(f.work, 'workspace/source.spec.ts'), 'regression fixture\n');
  const commit = buildCommit(f.task, { title: 'Fix', summary: 'Focused fix' }, f);
  assert.equal(f.git(['show', commit + ':source.spec.ts']), 'regression fixture');
});
test('publishing rejects attempts to disable tests through package scripts', t => {
  const f = localRepo(t);
  writeFileSync(path.join(f.work, 'workspace/package.json'), '{"scripts":{"test":"true"}}');
  assert.throws(() => buildCommit(f.task, { title: 'Disable tests', summary: 'unsafe' }, f), /Package script changes/);
});
test('atomic push rejects a concurrent human commit, preserving the remote branch', t => {
  const f = localRepo(t), remote = path.join(f.dir, 'remote.git');
  f.git(['init', '--bare', '-q', remote]); f.git(['push', '-q', remote, `${f.task.head_sha}:refs/heads/feature`]);
  writeFileSync(path.join(f.work, 'workspace/source.txt'), 'bot fix\n');
  const bot = buildCommit(f.task, { title: 'Bot fix', summary: 'Repair' }, f);
  writeFileSync(path.join(f.root, 'source.txt'), 'human fix\n'); f.git(['commit', '-qam', 'Human update']);
  const human = f.git(['rev-parse', 'HEAD']); f.git(['push', '-q', remote, `${human}:refs/heads/feature`]);
  const pushed = spawnSync('git', pushArguments(f.task, bot, remote), { cwd: f.root, encoding: 'utf8' });
  assert.notEqual(pushed.status, 0);
  assert.equal(f.git(['--git-dir', remote, 'rev-parse', 'feature']), human);
});

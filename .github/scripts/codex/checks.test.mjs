import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startPublishedWorkflows, trustedWorkflowTree } from './checks.mjs';
import { nextRuns } from './agent.mjs';
import { command, BOT } from './lib.mjs';

const revision = 'a'.repeat(40), task = { repo: 'owner/repo', branch: 'codex/issue-1' };
const run = (id, workflow) => ({ id, path: `.github/workflows/${workflow}`, event: 'pull_request',
  repository: { full_name: task.repo }, head_repository: { full_name: task.repo },
  head_sha: revision, head_branch: task.branch, actor: { login: BOT },
  pull_requests: [{ number: 2, head: { sha: revision } }], conclusion: 'action_required', status: 'completed' });
const pr = () => ({ state: 'open', head: { sha: revision, ref: task.branch, repo: { full_name: task.repo } } });
function fake(runs, posts = []) {
  return (endpoint, request = {}) => {
    if (request.method === 'POST') { posts.push(endpoint); return {}; }
    if (endpoint.endsWith('/pulls/2')) return pr();
    if (endpoint.includes('/actions/runs?')) return { workflow_runs: runs };
    const result = runs.find(item => endpoint.endsWith(`/runs/${item.id}`));
    assert.ok(result, endpoint); return result;
  };
}
test('validated bot revisions start held CI and review events without approving the PR or dispatching duplicate CI', () => {
  const posts = [], reviews = [];
  nextRuns(task, 2, revision, fake([run(10, 'CI.yml'), run(11, 'codex-review.yml')], posts), (...args) => reviews.push(args), true);
  assert.deepEqual(posts, ['repos/owner/repo/actions/runs/10/approve', 'repos/owner/repo/actions/runs/11/approve']);
  assert.deepEqual(reviews, [['owner/repo', 'review', 2, revision]]);
});
test('held events can arrive after publication and are polled with a fixed bound', () => {
  const posts = []; let polls = 0, waits = 0;
  const api = fake([run(10, 'CI.yml'), run(11, 'codex-review.yml')], posts);
  assert.equal(startPublishedWorkflows(task, 2, revision, (endpoint, request) => {
    if (endpoint.includes('/actions/runs?') && ++polls === 1) return { workflow_runs: [] };
    return api(endpoint, request);
  }, () => waits++), true);
  assert.equal(waits, 1); assert.equal(posts.length, 2);
  waits = 0;
  assert.equal(startPublishedWorkflows(task, 2, revision, fake([]), () => waits++), false);
  assert.equal(waits, 7);
});
test('fork, stale, unrelated and nonbot runs are never authorized', () => {
  for (const change of [
    { head_repository: { full_name: 'fork/repo' } }, { repository: { full_name: 'fork/repo' } },
    { head_sha: 'b'.repeat(40) }, { head_branch: 'other' }, { actor: { login: 'other-bot' } },
    { event: 'pull_request_target' }, { path: '.github/workflows/unknown.yml' },
    { pull_requests: [{ number: 3, head: { sha: revision } }] },
  ]) {
    const posts = [];
    assert.equal(startPublishedWorkflows(task, 2, revision, fake([{ ...run(10, 'CI.yml'), ...change }], posts), () => {}), false);
    assert.deepEqual(posts, []);
  }
});
test('a concurrent PR update stops workflow authorization', () => {
  let reads = 0; const posts = [];
  const api = fake([], posts);
  assert.equal(startPublishedWorkflows(task, 2, revision, (endpoint, request) => {
    if (endpoint.endsWith('/pulls/2') && ++reads > 1) return { ...pr(), head: { ...pr().head, sha: 'b'.repeat(40) } };
    return api(endpoint, request);
  }, () => {}), false);
  assert.deepEqual(posts, []);
});
test('approval denial fails visibly without retrying or granting a PR review', () => {
  let posts = 0;
  const api = fake([run(10, 'CI.yml'), run(11, 'codex-review.yml')]);
  assert.throws(() => startPublishedWorkflows(task, 2, revision, (endpoint, request) => {
    if (request?.method === 'POST') { posts++; throw new Error('denied'); }
    return api(endpoint, request);
  }), /GitHub rejected starting/);
  assert.equal(posts, 1);
});
test('workflow authorization requires the trusted controller workflow tree', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'codex-workflow-tree-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => command('git', args, { cwd: root });
  git(['init', '-q']); mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  const file = path.join(root, '.github/workflows/CI.yml');
  writeFileSync(file, 'name: Trusted CI\n'); git(['add', '.']);
  const commit = () => git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  commit(); const first = git(['rev-parse', 'HEAD']).trim();
  assert.equal(trustedWorkflowTree(first, root), true);
  writeFileSync(file, 'name: Changed CI\n'); git(['add', '.']); commit();
  assert.equal(trustedWorkflowTree(first, root), false);
  assert.equal(trustedWorkflowTree(git(['rev-parse', 'HEAD']).trim(), root), true);
});

import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, WORK, ARTIFACTS, CI_WORKFLOW, WORKER_WORKFLOW, gh, pages, command, json, save,
  output, integer, sha, repository, branch, bounded, records, recordFrom, marker, comment, dispatch,
  publicText, redactor, validateChanges, validateResult, cleanEnvironment } from './lib.mjs';
import { repairBudget, humanRevisionAuthor, failureSignature, findingKey, changedLines } from './state.mjs';

const taskFile = path.join(WORK, 'task.json');
const event = () => json(process.env.GITHUB_EVENT_PATH);
const commentsFor = (repo, n) => pages(`repos/${repo}/issues/${n}/comments?per_page=100`);
const prFor = (repo, n) => gh(`repos/${repo}/pulls/${integer(n)}`);
const runUrl = task => `https://github.com/${task.repo}/actions/runs/${task.run_id}`;
function canWrite(repo, actor) {
  if (!actor) return false;
  try {
    const permission = gh(`repos/${repo}/collaborators/${encodeURIComponent(actor)}/permission`).permission;
    return ['write', 'maintain', 'admin'].includes(permission);
  } catch (error) {
    if (error.httpStatus === 404) return false;
    throw error;
  }
}
export function sameRepository(pr, repo) { return pr.head?.repo?.full_name === repo && pr.base?.repo?.full_name === repo; }
function infoSummary(result) {
  return `${result.summary}\n\nInvestigated: ${result.investigated.join('; ') || 'See summary.'}\n\nTests:\n${result.tests.map(t => `- ${t.status}: ${t.command} — ${t.details}`).join('\n') || '- No tests were run.'}` +
    (result.unresolved.length ? `\n\nUnresolved:\n${result.unresolved.map(s => `- ${s}`).join('\n')}` : '');
}
function notice(task, text, kind = 'notice') {
  const history = records(commentsFor(task.repo, task.number));
  if (!history.some(r => r.kind === kind && r.head_sha === task.head_sha && r.message === text)) {
    comment(task.repo, task.number, { kind, head_sha: task.head_sha, message: text, run_id: task.run_id }, `${text}\n\n[Workflow run](${runUrl(task)}).`);
  }
  output('proceed', 'false');
}
async function associatedPRs(repo, run) {
  let candidates = run.pull_requests || [];
  if (!candidates.length) candidates = pages(`repos/${repo}/commits/${sha(run.head_sha)}/pulls?per_page=100`);
  const result = [];
  for (const item of candidates) {
    const pr = prFor(repo, item.number);
    if (pr.state === 'open' && pr.head.sha === run.head_sha) result.push(pr);
  }
  return result;
}
function verifyRun(run, repo, workflow, name) {
  if (run.repository?.full_name !== repo || run.path !== `.github/workflows/${workflow}` || run.name !== name || run.status !== 'completed') throw new Error('Workflow run provenance does not match the configured workflow');
  sha(run.head_sha);
}
async function request(mode) {
  const repo = repository(process.env.GH_REPO), payload = event();
  const metadata = gh(`repos/${repo}`);
  process.env.CODEX_DEFAULT_BRANCH = metadata.default_branch;
  if (mode === 'issue') {
    if (process.env.GITHUB_EVENT_NAME !== 'issues' || payload.action !== 'opened' || payload.repository.full_name !== repo || payload.issue.pull_request) throw new Error('Invalid issue event');
    dispatch(repo, 'issue', integer(payload.issue.number));
  } else if (mode === 'review') {
    if (process.env.GITHUB_EVENT_NAME !== 'pull_request_target' ||
      !['opened', 'reopened', 'synchronize', 'ready_for_review'].includes(payload.action) ||
      payload.repository.full_name !== repo || payload.pull_request?.base?.repo?.full_name !== repo) throw new Error('Invalid trusted PR metadata event');
    const pr = prFor(repo, integer(payload.pull_request.number));
    if (pr.state !== 'open' || pr.base?.repo?.full_name !== repo || pr.head.sha !== sha(payload.pull_request.head.sha)) return;
    dispatch(repo, 'review', pr.number, pr.head.sha);
  } else if (mode === 'repair') {
    const run = gh(`repos/${repo}/actions/runs/${integer(payload.workflow_run.id)}`);
    verifyRun(run, repo, CI_WORKFLOW, 'CI');
    if (run.conclusion === 'failure') dispatch(repo, 'repair', run.id);
  } else throw new Error('Invalid request mode');
}
async function prepare() {
  output('proceed', 'false');
  const repo = repository(process.env.GH_REPO), metadata = gh(`repos/${repo}`);
  process.env.CODEX_DEFAULT_BRANCH = metadata.default_branch;
  const currentRun = gh(`repos/${repo}/actions/runs/${integer(process.env.GITHUB_RUN_ID)}`);
  const task = { repo, run_id: currentRun.id, created_at: currentRun.created_at, default_branch: branch(metadata.default_branch),
    mode: process.env.CODEX_MODE, target: integer(process.env.CODEX_TARGET), new_cycle: process.env.CODEX_NEW_CYCLE === 'true' };
  if (!['issue', 'review', 'repair'].includes(task.mode)) throw new Error('Unknown task mode');
  let issue, pr, ci;
  if (process.env.GITHUB_EVENT_NAME === 'workflow_run') {
    const source = gh(`repos/${repo}/actions/runs/${task.target}`);
    verifyRun(source, repo, 'codex-review.yml', 'Codex PR review request');
    if (source.event !== 'pull_request') throw new Error('Review request was not a PR event');
    const prs = await associatedPRs(repo, source);
    for (const extra of prs.slice(1)) dispatch(repo, 'review', extra.number, extra.head.sha);
    if (!prs.length) return;
    pr = prs[0]; task.target = pr.number;
  } else if (task.mode === 'repair') {
    ci = gh(`repos/${repo}/actions/runs/${task.target}`);
    verifyRun(ci, repo, CI_WORKFLOW, 'CI');
    if (ci.conclusion !== 'failure' || !['pull_request', 'workflow_dispatch', 'push'].includes(ci.event) || ci.head_repository?.full_name !== repo) return;
    const prs = await associatedPRs(repo, ci);
    if (prs.length !== 1) return; // ambiguous branch ownership requires a human
    pr = prs[0];
  } else if (task.mode === 'review') pr = prFor(repo, task.target);
  else {
    issue = gh(`repos/${repo}/issues/${task.target}`);
    if (issue.pull_request || issue.state !== 'open') return;
  }
  task.number = pr?.number || issue.number;
  task.head_sha = sha(pr?.head.sha || gh(`repos/${repo}/commits/${encodeURIComponent(metadata.default_branch)}`).sha);
  if (pr && process.env.CODEX_EXPECTED_SHA && sha(process.env.CODEX_EXPECTED_SHA) !== task.head_sha) return;
  if (pr && pr.state !== 'open') return;
  if (task.mode === 'repair' && pr && !sameRepository(pr, repo)) {
    notice(task, 'Automatic repair cannot push to an external fork branch. Apply the PR review findings in the contributor repository.');
    return;
  }
  if (process.env.CODEX_AUTOMATION_ENABLED === 'false') { notice(task, 'Codex automation is disabled by the repository CODEX_AUTOMATION_ENABLED variable.'); return; }
  const comments = commentsFor(repo, task.number), history = records(comments);
  task.history = history;
  task.context = { repository: repo, mode: task.mode, head_sha: task.head_sha,
    discussion: comments.slice(-6).map(c => ({ author: c.user?.login, body: bounded(c.body, 800) })),
    previous_attempts: history.filter(r => ['repair', 'issue'].includes(r.kind)).slice(-3) };
  if (issue) {
    if (history.some(r => r.kind === 'issue' && r.status === 'complete')) return;
    task.branch = `codex/issue-${issue.number}`;
    const existing = gh(`repos/${repo}/pulls?state=all&head=${encodeURIComponent(repo.split('/')[0] + ':' + task.branch)}&per_page=100`);
    if (existing.length) {
      comment(repo, issue.number, { kind: 'issue', status: 'complete', pr: existing[0].number, run_id: task.run_id }, `This issue already has a pull request: ${existing[0].html_url}`);
      return;
    }
    task.context.issue = { number: issue.number, title: bounded(issue.title, 500), body: bounded(issue.body, 16000), author: issue.user.login };
  } else {
    task.branch = branch(pr.head.ref); task.base_branch = branch(pr.base.ref);
    const reviews = pages(`repos/${repo}/pulls/${pr.number}/reviews?per_page=100`);
    if (task.mode === 'review' && reviews.some(r => recordFrom(r)?.kind === 'review' && recordFrom(r)?.head_sha === task.head_sha)) return;
    const files = pages(`repos/${repo}/pulls/${pr.number}/files?per_page=100`);
    const inlineDiscussion = pages(`repos/${repo}/pulls/${pr.number}/comments?per_page=100`);
    task.files = files.map(f => ({ filename: f.filename, patch: bounded(f.patch, 12000) }));
    task.previous_findings = reviews.map(recordFrom).filter(Boolean).flatMap(r => r.finding_keys || []);
    const commits = pages(`repos/${repo}/pulls/${pr.number}/commits?per_page=100`);
    const linked = [...new Set((pr.body || '').match(/(?<![\w/])#\d+/g) || [])].slice(0, 4);
    const linkedIssues = linked.flatMap(ref => {
      try { const i = gh(`repos/${repo}/issues/${integer(ref.slice(1))}`); return [{ number: i.number, title: bounded(i.title, 500), body: bounded(i.body, 2000) }]; }
      catch { return [{ reference: ref, unavailable: true }]; }
    });
    let remaining = 22000;
    task.context.pr = { number: pr.number, title: bounded(pr.title, 500), body: bounded(pr.body, 5000), author: pr.user.login,
      base_sha: pr.base.sha, linked_issues: linkedIssues, diff_is_partial: files.length > 40 || files.some(f => !f.patch),
      files: files.slice(0, 40).map(f => { const patch = bounded(f.patch, Math.max(0, Math.min(3000, remaining))); remaining -= patch.length; return { filename: f.filename, status: f.status, patch }; }),
      commits: commits.slice(-8).map(c => ({ sha: c.sha, message: bounded(c.commit.message, 400) })),
      previous_reviews: reviews.slice(-4).map(r => ({ author: r.user?.login, body: bounded(r.body, 1200) })),
      previous_inline_comments: inlineDiscussion.slice(-6).map(c => ({ author: c.user?.login, path: c.path, line: c.line, commit_id: c.commit_id, body: bounded(c.body, 800) })) };
    if (remaining <= 0 || files.some(f => (f.patch || '').length > 3000)) task.context.pr.diff_is_partial = true;
    if (task.mode === 'repair') {
      const branchInfo = gh(`repos/${repo}/branches/${encodeURIComponent(task.branch)}`);
      if (task.branch === metadata.default_branch || branchInfo.protected) { notice(task, 'Automatic repair will not push to a protected or default branch.', 'repair-policy'); return; }
      let resetId = '';
      if (task.new_cycle || process.env.CODEX_CYCLE_REQUEST) {
        const cycleRun = process.env.CODEX_CYCLE_REQUEST ? gh(`repos/${repo}/actions/runs/${integer(process.env.CODEX_CYCLE_REQUEST)}`) : currentRun;
        const actor = cycleRun.triggering_actor || cycleRun.actor;
        if (cycleRun.path !== `.github/workflows/${WORKER_WORKFLOW}` || cycleRun.event !== 'workflow_dispatch') throw new Error('Invalid manual repair-cycle provenance');
        if (actor?.type !== 'User' || !canWrite(repo, actor.login)) throw new Error('Only a repository maintainer can explicitly reset a repair cycle');
        task.cycle_request = cycleRun.id;
        resetId = `manual-${cycleRun.id}`;
      }
      const headCommit = gh(`repos/${repo}/commits/${task.head_sha}`);
      const revisionAuthor = humanRevisionAuthor(headCommit);
      const humanRevision = revisionAuthor ? canWrite(repo, revisionAuthor.login) : false;
      task.budget = repairBudget(history, task.head_sha, humanRevision, resetId);
      const jobs = pages(`repos/${repo}/actions/runs/${ci.id}/attempts/${ci.run_attempt}/jobs?per_page=100`).flatMap(p => p.jobs || []);
      const failed = jobs.filter(j => j.conclusion === 'failure');
      if (!task.budget.allowed) { notice(task, `${task.budget.reason}\n\nRemaining failures: ${failed.map(j => j.name).join(', ') || 'see CI run'}. ${ci.html_url}`, 'repair-limit'); return; }
      if (history.some(r => r.kind === 'repair' && r.cycle === task.budget.cycle && r.ci_run_id === ci.id && r.ci_run_attempt === ci.run_attempt)) return;
      let excerpt = 'Failure logs unavailable; inspect the failed steps and run URL.';
      try { excerpt = command('gh', ['run', 'view', String(ci.id), '--attempt', String(ci.run_attempt), '--repo', repo, '--log-failed'], { maxBuffer: 4 * 1024 * 1024 }).slice(-14000); } catch { /* step metadata still available */ }
      excerpt = redactor()(excerpt).replace(/\x1b\[[0-9;]*m/g, '');
      task.ci_run_id = ci.id; task.ci_run_attempt = ci.run_attempt;
      task.failure_signature = failureSignature(failed);
      task.context.ci = { id: ci.id, attempt: ci.run_attempt, head_sha: ci.head_sha, url: ci.html_url,
        failed_jobs: failed.map(j => ({ name: j.name, steps: j.steps?.filter(s => s.conclusion === 'failure').map(s => s.name) })), log_excerpt: excerpt };
      save(path.join(ARTIFACTS, 'ci-failures.json'), task.context.ci);
    }
  }
  // Fetch only through the trusted checkout with a step-scoped job token.
  const fetchRef = pr && !sameRepository(pr, repo) ? `refs/pull/${integer(pr.number)}/head` : task.head_sha;
  command('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'fetch', '--no-tags', '--depth=1', `https://github.com/${repo}.git`, fetchRef], { cwd: ROOT });
  if (fetchRef !== task.head_sha && command('git', ['rev-parse', 'FETCH_HEAD'], { cwd: ROOT }).trim() !== task.head_sha) throw new Error('PR head changed during fetch; this review request is stale');
  save(taskFile, task);
  save(path.join(ARTIFACTS, 'task.json'), { mode: task.mode, number: task.number, head_sha: task.head_sha, run_id: task.run_id, ci_run_id: task.ci_run_id });
  output('proceed', 'true');
}
function reserve() {
  const task = json(taskFile);
  if (task.mode === 'review') return;
  const record = task.mode === 'repair' ? {
    kind: 'repair', status: 'reserved', cycle: task.budget.cycle, attempt: task.budget.attempt,
    input_sha: task.head_sha, output_sha: null, ci_run_id: task.ci_run_id, ci_run_attempt: task.ci_run_attempt,
    failure_signature: task.failure_signature, run_id: task.run_id,
  } : { kind: 'issue', status: 'started', input_sha: task.head_sha, run_id: task.run_id };
  const created = comment(task.repo, task.number, record,
    `Codex is investigating ${task.mode === 'repair' ? `CI failure (attempt ${record.attempt}/3)` : 'this issue'}. [Workflow run](${runUrl(task)}).`);
  task.record = record; task.comment_id = created.id; save(taskFile, task);
}
function gitContext(task, root = ROOT, work = WORK) {
  // A separate index and trusted Git dir keep model-created .git/config, hooks,
  // attributes helpers, and index files out of host-side publishing.
  const env = cleanEnvironment({ GIT_INDEX_FILE: path.join(work, 'publish.index'), GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GH_TOKEN: process.env.GH_TOKEN,
    GIT_AUTHOR_NAME: 'github-actions[bot]', GIT_AUTHOR_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'github-actions[bot]', GIT_COMMITTER_EMAIL: '41898282+github-actions[bot]@users.noreply.github.com' });
  const args = ['--git-dir', path.join(root, '.git'), '--work-tree', path.join(work, 'workspace'), '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.attributesFile=/dev/null'];
  return (parameters, options = {}) => command('git', [...args, ...parameters], { cwd: path.join(work, 'workspace'), env, ...options });
}
export function buildCommit(task, result, { root = ROOT, work = WORK } = {}) {
  const git = gitContext(task, root, work);
  git(['read-tree', task.head_sha]);
  // Exclude Git metadata created by model tools. Other blocked paths are staged
  // and rejected below, rather than silently publishing only part of a change.
  git(['add', '--all', '--', '.', ':!.git']);
  const raw = git(['diff', '--cached', '--raw', '--no-renames', '-z', task.head_sha]).split('\0');
  const entries = [];
  for (let i = 0; i + 1 < raw.length && raw[i]; i += 2) entries.push({ mode: raw[i].split(' ')[1], file: raw[i + 1] });
  validateChanges(entries);
  if (!entries.length) return null;
  if (entries.some(e => e.file === 'package.json')) {
    const before = JSON.parse(git(['show', `${task.head_sha}:package.json`]));
    const after = JSON.parse(git(['show', ':package.json']));
    if (JSON.stringify(before.scripts) !== JSON.stringify(after.scripts)) throw new Error('Package script changes require human handling');
  }
  const diff = git(['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', task.head_sha]);
  if (Buffer.byteLength(diff) > 1024 * 1024) throw new Error('Patch exceeds 1 MiB limit');
  if (redactor()(diff) !== diff) throw new Error('Potential credential material found in patch; publishing blocked');
  const tree = git(['write-tree']).trim();
  const subject = bounded(result.title.replace(/[\r\n]/g, ' '), 100) || `Address ${task.mode} #${task.number}`;
  const message = `${subject}\n\n${bounded(result.summary, 1800)}\n\nRefs #${task.number}\nCodex-Automation: ${task.mode}\n${task.budget ? `Codex-Repair-Cycle: ${task.budget.cycle}\n` : ''}`;
  return git(['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', task.head_sha], { input: message }).trim();
}
export function nextRuns(task, prNumber, head, api = gh, queueReview = dispatch) {
  // GITHUB_TOKEN pushes cannot be relied upon to trigger downstream workflows.
  // Dispatch is supported with that token and a pinned branch/SHA check in CI.
  const endpoint = `repos/${task.repo}/actions/workflows/${CI_WORKFLOW}/dispatches`;
  try {
    api(endpoint, { method: 'POST', body: { ref: task.branch, inputs: { pr_number: String(prNumber), expected_sha: head } } });
  } catch (error) {
    // A feature branch may predate the new optional dispatch inputs. A 422
    // starts no run, so retrying without inputs cannot duplicate a dispatched CI.
    // Other errors, especially uncertain network failures, are never retried.
    if (error.httpStatus !== 422) throw error;
    api(endpoint, { method: 'POST', body: { ref: task.branch } });
  }
  queueReview(task.repo, 'review', prNumber, head);
}
export function pushArguments(task, commit, remote = `https://github.com/${task.repo}.git`) {
  return ['-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential',
    'push', '--porcelain', `--force-with-lease=refs/heads/${task.branch}:${task.mode === 'repair' ? task.head_sha : ''}`,
    remote, `${sha(commit)}:refs/heads/${branch(task.branch)}`];
}
async function publish() {
  const task = json(taskFile); process.env.CODEX_DEFAULT_BRANCH = task.default_branch;
  const resultFile = path.join(ARTIFACTS, 'result.json');
  if (!existsSync(resultFile)) {
    const message = 'Codex execution failed or timed out. No changes were published. Check subscription authentication, usage limits and the workflow artifacts.';
    if (task.record) comment(task.repo, task.number, { ...task.record, status: 'failed' }, `${message}\n\n[Workflow run](${runUrl(task)}).`, task.comment_id);
    else notice(task, message, 'execution-error');
    return;
  }
  const result = validateResult(json(resultFile), task.mode);
  const summary = publicText(infoSummary(result)) + `\n\n[Workflow run](${runUrl(task)}).`;
  if (task.mode === 'review') {
    const pr = prFor(task.repo, task.number);
    if (pr.head.sha !== task.head_sha || pr.state !== 'open') return;
    const prior = pages(`repos/${task.repo}/pulls/${task.number}/reviews?per_page=100`);
    if (prior.some(r => recordFrom(r)?.kind === 'review' && recordFrom(r)?.head_sha === task.head_sha)) return;
    const known = new Set(task.previous_findings), findings = result.findings.filter(f => !known.has(findingKey(f)));
    const lines = changedLines(task.files), fileNames = new Set(task.files.map(f => f.filename));
    const inline = findings.filter(f => fileNames.has(f.path) && lines.has(`${f.path}:${f.line}`));
    const rest = findings.filter(f => !inline.includes(f));
    const scope = task.context.pr.diff_is_partial ? '\n\nScope limitation: the supplied diff was partial; this review cannot establish full PR coverage.' : '';
    const body = `${marker({ kind: 'review', head_sha: task.head_sha, run_id: task.run_id, finding_keys: findings.map(findingKey) })}\n${summary}${scope}\n\n` +
      (findings.length ? rest.map(f => `[${f.priority}] ${publicText(f.title)} — ${publicText(f.path)}:${f.line}\n${publicText(f.body)}`).join('\n\n') : 'No new significant issues were found within the reviewed scope. Previously reported findings may still require attention.');
    gh(`repos/${task.repo}/pulls/${task.number}/reviews`, { method: 'POST', body: {
      commit_id: task.head_sha, event: 'COMMENT', body,
      comments: inline.map(f => ({ path: f.path, line: f.line, side: 'RIGHT', body: `[${f.priority}] ${publicText(f.title)}\n\n${publicText(f.body)}` })),
    } });
    return;
  }
  if (result.outcome !== 'changes') {
    const status = task.mode === 'repair' ? 'halted' : 'complete';
    comment(task.repo, task.number, { ...task.record, status, outcome: result.outcome, summary: bounded(result.summary, 1500) }, summary, task.comment_id);
    return;
  }
  if (task.mode === 'issue' && gh(`repos/${task.repo}/issues/${task.number}`).state !== 'open') {
    comment(task.repo, task.number, { ...task.record, status: 'complete', outcome: 'no_change' }, 'The issue was closed during investigation. No changes were published.', task.comment_id);
    return;
  }
  const commit = buildCommit(task, result);
  if (!commit) throw new Error('Codex reported changes but the validated patch was empty');
  sha(commit);
  if (task.mode === 'repair') {
    const pr = prFor(task.repo, task.number), info = gh(`repos/${task.repo}/branches/${encodeURIComponent(task.branch)}`);
    if (pr.state !== 'open' || !sameRepository(pr, task.repo) || pr.head.sha !== task.head_sha || pr.head.ref !== task.branch || info.protected || task.branch === task.default_branch) throw new Error('PR head or branch protection changed; stale changes will not be pushed');
  } else {
    const remote = command('git', ['ls-remote', `https://github.com/${task.repo}.git`, `refs/heads/${task.branch}`], {
      env: cleanEnvironment({ GH_TOKEN: process.env.GH_TOKEN, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '', GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '!gh auth git-credential' }),
    });
    if (remote.trim()) throw new Error('Issue branch already exists; human inspection is required before resuming');
  }
  // Save the output SHA before pushing. A crash after push still cannot reset a
  // repair cycle, and a human update wins because this is a normal fast-forward.
  task.record.output_sha = commit; task.record.status = 'publishing';
  comment(task.repo, task.number, task.record, summary, task.comment_id); save(taskFile, task);
  command('git', pushArguments(task, commit), { cwd: ROOT });
  let prNumber = task.number;
  if (task.mode === 'issue') {
    const issue = gh(`repos/${task.repo}/issues/${task.number}`);
    const pr = gh(`repos/${task.repo}/pulls`, { method: 'POST', body: {
      head: task.branch, base: task.default_branch, title: bounded(result.title || issue.title, 200),
      body: `Refs #${task.number}\n\n${summary}`, draft: result.tests.some(t => t.status === 'failed') || !result.tests.some(t => t.status === 'passed'),
    } });
    prNumber = pr.number;
    comment(task.repo, prNumber, { kind: 'origin', issue: task.number, branch: task.branch, initial_sha: commit, run_id: task.run_id },
      'Created by Codex automation. Failed CI automatically starts bounded repair on this repository-owned branch. A maintainer reviews and merges this PR.');
    comment(task.repo, task.number, { ...task.record, status: 'complete', pr: pr.number, summary: bounded(result.summary, 1500) }, `Prepared ${pr.html_url}\n\n${summary}`, task.comment_id);
  } else {
    comment(task.repo, task.number, { ...task.record, status: 'complete', summary: bounded(result.summary, 1500) }, `Pushed repair commit ${commit} (attempt ${task.record.attempt}/3).\n\n${summary}`, task.comment_id);
  }
  // A dispatch failure fails visibly; the reserved attempt and output SHA remain
  // durable. It never triggers another implementation merely to retry dispatch.
  nextRuns(task, prNumber, commit);
}
async function reportFailure() {
  if (!existsSync(taskFile)) return;
  const task = json(taskFile);
  const text = 'Automation could not complete. Check the workflow for authentication, credential persistence, stale-head, permission or publishing errors. Human intervention may be required.';
  // Preserve output SHA/cycle when a commit was already published.
  if (task.record) comment(task.repo, task.number, { ...task.record, status: 'failed' }, `${text}\n\n[Workflow run](${runUrl(task)}).`, task.comment_id);
  else notice(task, text, 'automation-error');
}
async function main() {
  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_SERVER_URL !== 'https://github.com') throw new Error('Only github.com is configured');
  const action = process.argv[2];
  if (action === 'request') return request(process.argv[3]);
  if (action === 'prepare') return prepare();
  if (action === 'reserve') return reserve();
  if (action === 'publish') return publish();
  if (action === 'report-failure') return reportFailure();
  throw new Error('Unknown coordinator action');
}
if (process.argv[1] === import.meta.filename) main().catch(error => { console.error(error.message); process.exitCode = 1; });

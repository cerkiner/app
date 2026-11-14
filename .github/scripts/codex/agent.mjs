import { existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, WORK, ARTIFACTS, CI_WORKFLOW, WORKER_WORKFLOW, gh, pages, command, json, save,
  output, integer, sha, repository, branch, bounded, records, recordFrom, marker, comment, dispatch,
  publicText, redactor, validateChanges, validateResult, cleanEnvironment } from './lib.mjs';
import { trustedWorkflowTree, startPublishedWorkflows } from './checks.mjs';
import { repairBudget, humanRevisionAuthor, failureSignature, findingKey, changedLines, canonicalFindings, actionableFindings, remainingFindings, repairRequestSeen, validateRepairVerification } from './state.mjs';
import { renderMessage, renderFinding, reviewStage } from './messages.mjs';
import { publishedReview, previousFindings, latestReview, validateReviewRequest, requestReviewRepair } from './reviews.mjs';

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
function message(task, stage, summary, options = {}) {
  return renderMessage({ task, stage, summary, ...options });
}
function notice(task, text, kind = 'notice', extra = '') {
  const history = records(commentsFor(task.repo, task.number));
  if (!history.some(r => r.kind === kind && r.head_sha === task.head_sha && r.message === text)) {
    const stage = task.mode === 'repair' ? kind === 'repair-limit' ? 'repair_limit' : 'repair_human' : task.mode === 'review' ? 'review_incomplete' : 'issue_findings';
    comment(task.repo, task.number, { kind, head_sha: task.head_sha, message: text, run_id: task.run_id },
      message(task, stage, text, { next: 'Review the explanation and provide the missing information or access.', extra }));
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
    mode: process.env.CODEX_MODE, target: integer(process.env.CODEX_TARGET), repair_source: process.env.CODEX_REPAIR_SOURCE || 'ci', new_cycle: process.env.CODEX_NEW_CYCLE === 'true' };
  if (!['issue', 'review', 'repair'].includes(task.mode)) throw new Error('Unknown task mode');
  if (task.mode === 'repair' && !['ci', 'review'].includes(task.repair_source)) throw new Error('Invalid repair source');
  let issue, pr, ci, sourceReview;
  if (process.env.GITHUB_EVENT_NAME === 'workflow_run') {
    const source = gh(`repos/${repo}/actions/runs/${task.target}`);
    verifyRun(source, repo, 'codex-review.yml', 'Codex PR review request');
    if (source.event !== 'pull_request') throw new Error('Review request was not a PR event');
    const prs = await associatedPRs(repo, source);
    for (const extra of prs.slice(1)) dispatch(repo, 'review', extra.number, extra.head.sha);
    if (!prs.length) return;
    pr = prs[0]; task.target = pr.number;
  } else if (task.mode === 'repair' && task.repair_source === 'review') {
    if (!process.env.CODEX_EXPECTED_SHA) throw new Error('Review repair requires the exact reviewed SHA');
    pr = prFor(repo, task.target);
    task.review_id = integer(process.env.CODEX_REVIEW_ID);
    sourceReview = gh(`repos/${repo}/pulls/${pr.number}/reviews/${task.review_id}`);
    task.requested_findings = validateReviewRequest(sourceReview, sha(process.env.CODEX_EXPECTED_SHA), process.env.CODEX_REVIEW_FINDINGS).findings;
    if (!task.requested_findings.length) return;
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
    discussion: comments.slice(-6).map(c => ({ author: c.user?.login, body: bounded(publicText(c.body), 800) })),
    previous_attempts: history.filter(r => ['repair', 'issue'].includes(r.kind)).slice(-3).map(r => ({ kind: r.kind, source: r.source, cycle: r.cycle, attempt: r.attempt, input_sha: r.input_sha, output_sha: r.output_sha, summary: r.summary, finding_verifications: (r.finding_verifications || []).map(v => ({ ...v, explanation: bounded(v.explanation, 300) })) })) };
  if (issue) {
    if (history.some(r => r.kind === 'issue' && r.status === 'complete' && r.outcome !== 'external_failure')) return;
    task.branch = `codex/issue-${issue.number}`;
    const existing = gh(`repos/${repo}/pulls?state=all&head=${encodeURIComponent(repo.split('/')[0] + ':' + task.branch)}&per_page=100`);
    if (existing.length) {
      comment(repo, issue.number, { kind: 'issue', status: 'complete', pr: existing[0].number, run_id: task.run_id }, message(task, 'issue_pr', 'This issue already has a prepared pull request.', { pr: existing[0].number, next: 'Continue review on the existing PR.' }));
      return;
    }
    task.context.issue = { number: issue.number, title: bounded(issue.title, 500), body: bounded(issue.body, 16000), author: issue.user.login };
  } else {
    task.branch = branch(pr.head.ref); task.base_branch = branch(pr.base.ref);
    const reviews = pages(`repos/${repo}/pulls/${pr.number}/reviews?per_page=100`);
    if (task.mode === 'review') {
      const existingReview = reviews.filter(r => recordFrom(r)?.kind === 'review' && recordFrom(r)?.head_sha === task.head_sha).at(-1);
      if (existingReview) {
        const record = publishedReview(existingReview, task.head_sha);
        if (record) requestReviewRepair(task, existingReview, record, dispatch, gh);
        return;
      }
    }
    const files = pages(`repos/${repo}/pulls/${pr.number}/files?per_page=100`);
    const inlineDiscussion = pages(`repos/${repo}/pulls/${pr.number}/comments?per_page=100`);
    task.files = files.map(f => ({ filename: f.filename, patch: bounded(f.patch, 12000) }));
    task.previous_findings = reviews.map(recordFrom).filter(Boolean).flatMap(r => r.finding_keys || []);
    task.previous_structured_findings = previousFindings(reviews);
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
      previous_structured_findings: task.previous_structured_findings,
      previous_reviews: reviews.slice(-4).map(r => ({ author: r.user?.login, body: bounded(publicText(r.body), 1200) })),
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
      const currentReview = latestReview(reviews, task.head_sha);
      if (sourceReview && currentReview && currentReview.id !== sourceReview.id) return;
      if (!ci && sourceReview) {
        const candidates = gh(`repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${task.head_sha}&status=failure&per_page=10`).workflow_runs || [];
        ci = candidates.find(run => run.head_sha === task.head_sha && run.repository?.full_name === repo && run.head_repository?.full_name === repo && run.path === `.github/workflows/${CI_WORKFLOW}` && run.name === 'CI' && run.status === 'completed' && run.conclusion === 'failure');
      }
      let failed = [];
      if (ci) {
        const jobs = pages(`repos/${repo}/actions/runs/${ci.id}/attempts/${ci.run_attempt}/jobs?per_page=100`).flatMap(p => p.jobs || []);
        failed = jobs.filter(j => j.conclusion === 'failure');
        task.ci_run_id = ci.id; task.ci_run_attempt = ci.run_attempt;
        task.failure_signature = failureSignature(failed);
      }
      task.budget = repairBudget(history, task.head_sha, humanRevision, resetId,
        { source: task.repair_source, failure_signature: task.failure_signature });
      if (!task.budget.allowed) {
        notice(task, task.budget.reason, task.budget.reason_code === 'exhausted' ? 'repair-limit' : 'repair-policy',
          'Remaining failures: ' + (failed.map(j => j.name).join(', ') || 'See current review findings.') + (ci ? '\n' + ci.html_url : ''));
        return;
      }
      const currentRecord = currentReview && publishedReview(currentReview, task.head_sha);
      const candidates = sourceReview ? task.requested_findings : actionableFindings(currentRecord?.findings || []);
      task.review_findings = remainingFindings(history, task.budget.cycle, candidates);
      if (sourceReview && !task.review_findings.length) return;
      task.review_ids = [...new Set([task.review_id, ...(currentRecord && task.review_findings.length ? [currentReview.id] : [])].filter(Boolean))];
      task.request_keys = [...task.review_ids.map(id => 'review:' + id), ...(ci ? ['ci:' + ci.id + ':' + ci.run_attempt] : [])];
      if (repairRequestSeen(history, task.budget.cycle, task.request_keys)) return;
      // A CI and review request for the same head share one verified context.
      // Following a fix, queued requests for the old head fail the SHA check.
      task.context.repair_source = task.repair_source;
      task.context.review_findings = task.review_findings;
      task.context.source_review_ids = task.review_ids;
      if (ci) {
        let excerpt = 'Failure logs unavailable; inspect the failed steps and run URL.';
        try { excerpt = command('gh', ['run', 'view', String(ci.id), '--attempt', String(ci.run_attempt), '--repo', repo, '--log-failed'], { maxBuffer: 4 * 1024 * 1024 }).slice(-14000); } catch { /* metadata is still useful */ }
        excerpt = redactor()(excerpt).replace(/\x1b\[[0-9;]*m/g, '');
        task.context.ci = { id: ci.id, attempt: ci.run_attempt, head_sha: ci.head_sha, url: ci.html_url,
          failed_jobs: failed.map(j => ({ name: j.name, steps: j.steps?.filter(s => s.conclusion === 'failure').map(s => s.name) })), log_excerpt: excerpt };
        save(path.join(ARTIFACTS, 'ci-failures.json'), task.context.ci);
      }
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
function recheck() {
  const task = json(taskFile);
  const current = task.mode === 'issue' ? gh(`repos/${task.repo}/issues/${task.number}`) : prFor(task.repo, task.number);
  const valid = current.state === 'open' && (task.mode === 'issue' || current.head.sha === task.head_sha);
  output('current', String(valid));
  if (!valid && task.record) comment(task.repo, task.number, { ...task.record, status: 'superseded' },
    message(task, task.mode === 'repair' ? 'repair_human' : 'issue_findings', 'The revision changed or the item was closed before execution.', { next: 'Use the latest revision; this attempt will not publish changes.' }), task.comment_id);
}
function reserve() {
  const task = json(taskFile);
  if (task.mode === 'review') return;
  const record = task.mode === 'repair' ? {
    kind: 'repair', source: task.repair_source, status: 'reserved', cycle: task.budget.cycle, attempt: task.budget.attempt,
    input_sha: task.head_sha, output_sha: null, ci_run_id: task.ci_run_id, ci_run_attempt: task.ci_run_attempt,
    review_ids: task.review_ids, finding_keys: (task.review_findings || []).map(f => f.key), request_keys: task.request_keys,
    failure_signature: task.failure_signature, run_id: task.run_id,
  } : { kind: 'issue', status: 'started', input_sha: task.head_sha, run_id: task.run_id };
  const previous = task.mode === 'issue' ? task.history?.filter(r => r.kind === 'issue').at(-1)?.comment_id : undefined;
  task.record = record;
  const created = comment(task.repo, task.number, record, message(task,
    task.mode === 'issue' ? 'issue_investigating' : task.repair_source === 'review' ? 'repair_review' : 'repair_ci',
    task.mode === 'issue' ? 'Investigating the issue and implementing an appropriate focused solution.' : 'Verifying the reported defect and checking the relevant code and tests.',
    { pending: true, next: 'Investigate, verify and run focused checks.' }), previous);
  task.comment_id = created.id; save(taskFile, task);
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
  if (task.review_findings?.length && !entries.some(e => /(?:\.(?:spec|test)\.|(?:^|\/)(?:tests?|__tests__)\/)/.test(e.file))) throw new Error('Review repairs must add or update regression coverage');
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
export function nextRuns(task, prNumber, head, api = gh, queueReview = dispatch, startEvents = false) {
  if (startEvents && startPublishedWorkflows(task, prNumber, head, api)) {
    queueReview(task.repo, 'review', prNumber, head);
    return;
  }
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
async function publishReview(task, result) {
  const pr = prFor(task.repo, task.number);
  if (pr.head.sha !== task.head_sha || pr.state !== 'open') return;
  const prior = pages(`repos/${task.repo}/pulls/${task.number}/reviews?per_page=100`);
  const existing = prior.filter(r => recordFrom(r)?.kind === 'review' && recordFrom(r)?.head_sha === task.head_sha).at(-1);
  if (existing) {
    const record = publishedReview(existing, task.head_sha);
    if (record) requestReviewRepair(task, existing, record, dispatch, gh);
    return;
  }
  if (task.context.pr.diff_is_partial) {
    result.review_status = 'incomplete';
    result.unresolved.push('The supplied diff was partial; complete PR coverage could not be established.');
    save(path.join(ARTIFACTS, 'result.json'), result);
  }
  const findings = canonicalFindings(result.findings, task.previous_structured_findings || []);
  const significant = findings.filter(f => f.priority !== 'P3');
  const known = new Set(task.previous_findings || []), fresh = findings.filter(f => !known.has(f.key));
  const lines = changedLines(task.files), fileNames = new Set(task.files.map(f => f.filename));
  const inline = fresh.filter(f => fileNames.has(f.path) && lines.has(`${f.path}:${f.line}`));
  const record = { kind: 'review', head_sha: task.head_sha, run_id: task.run_id, review_status: result.review_status,
    finding_keys: findings.map(f => f.key), findings, repair_requested: false };
  const linkedCycle = (task.history || []).filter(r => r.kind === 'repair' && (r.input_sha === task.head_sha || r.output_sha === task.head_sha)).at(-1)?.cycle || 'head-' + task.head_sha;
  const needsRepair = remainingFindings(task.history || [], linkedCycle, actionableFindings(findings)).length > 0;
  if (!needsRepair) record.repair_requested = true;
  const summary = result.review_status === 'incomplete' ? 'Review incomplete. ' + (result.unresolved[0] || 'Some relevant evidence was unavailable.') :
    significant.length ? (fresh.some(f => f.priority !== 'P3') ? significant.slice(0, 2).map(f => f.title).join('; ') : significant.length + ' previously reported significant finding(s) remain unresolved.') :
      'No significant defects were found in the reviewed changes.';
  const next = needsRepair ? 'Repair Agent will independently verify the actionable findings.' : result.review_status === 'incomplete' ?
    'Resolve the review limits and request another review.' : significant.length ? 'Review the feedback and prior repair explanations before merging.' : 'Human review and merge when ready.';
  const details = 'Current findings:\n' + findings.map(f => '[' + f.priority + '] ' + f.key + ' ' + f.path + ':' + f.line + ' ' + f.title + '\n' + f.body + '\nActionable: ' + f.actionable).join('\n\n');
  const body = marker(record) + '\n' + message(task, reviewStage(result, significant), summary, { result, next, extra: details });
  if (Buffer.byteLength(body) > 63000) throw new Error('Published review exceeds the safe comment limit');
  const created = gh(`repos/${task.repo}/pulls/${task.number}/reviews`, { method: 'POST', body: {
    commit_id: task.head_sha, event: 'COMMENT', body,
    comments: inline.map(f => ({ path: f.path, line: f.line, side: 'RIGHT', body: renderFinding(f) })),
  } });
  requestReviewRepair(task, { ...created, body }, record, dispatch, gh);
}
async function publish() {
  const task = json(taskFile); process.env.CODEX_DEFAULT_BRANCH = task.default_branch;
  const resultFile = path.join(ARTIFACTS, 'result.json');
  if (!existsSync(resultFile)) {
    const reason = existsSync(path.join(ARTIFACTS, 'error.json')) ? json(path.join(ARTIFACTS, 'error.json')).message : 'Execution failed or timed out.';
    const stage = task.mode === 'review' ? 'review_incomplete' : task.mode === 'repair' ? 'repair_human' : 'issue_findings';
    const body = message(task, stage, 'Execution could not finish. ' + reason,
      { next: 'Resolve the reported execution problem before retrying.', extra: reason });
    if (task.record) comment(task.repo, task.number, { ...task.record, status: 'failed' }, body, task.comment_id);
    else comment(task.repo, task.number, { kind: 'execution-error', head_sha: task.head_sha, run_id: task.run_id }, body);
    return;
  }
  const result = validateResult(json(resultFile), task.mode);
  if (task.mode === 'review') return publishReview(task, result);
  if (task.mode === 'repair') validateRepairVerification(result, task.review_findings || []);
  if (task.mode === 'repair') {
    task.record.finding_verifications = result.finding_verifications;
    // Recheck again before publishing even a no-change explanation.
    const pr = prFor(task.repo, task.number);
    if (pr.state !== 'open' || pr.head.sha !== task.head_sha) {
      comment(task.repo, task.number, { ...task.record, status: 'superseded' }, message(task, 'repair_human',
        'The PR changed during this attempt. The older revision will not be updated.', { next: 'Review the latest revision.', result }), task.comment_id);
      return;
    }
  }
  if (result.outcome !== 'changes') {
    const disputed = result.finding_verifications.length && result.finding_verifications.every(v => ['incorrect', 'not_reproduced', 'already_resolved'].includes(v.status));
    const status = task.mode === 'repair' ? result.finding_verifications.length ? 'complete' : 'halted' : result.outcome === 'external_failure' ? 'failed' : 'complete';
    comment(task.repo, task.number, { ...task.record, status, outcome: result.outcome, summary: bounded(result.summary, 1500) },
      message(task, task.mode === 'repair' ? 'repair_human' : 'issue_findings', result.summary, { result,
        next: disputed ? 'Review the explanation. This finding will not be retried in this cycle.' : task.mode === 'repair' ? 'Resolve the reported blocker before retrying.' : 'Follow the findings or provide the requested information.' }), task.comment_id);
    return;
  }
  if (task.mode === 'issue' && gh(`repos/${task.repo}/issues/${task.number}`).state !== 'open') {
    comment(task.repo, task.number, { ...task.record, status: 'complete', outcome: 'no_change' },
      message(task, 'issue_findings', 'The issue was closed during investigation.', { result, next: 'No further action.' }), task.comment_id);
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
  task.record.output_sha = commit; task.record.status = 'publishing';
  comment(task.repo, task.number, task.record, message(task, task.mode === 'repair' ? task.repair_source === 'review' ? 'repair_review' : 'repair_ci' : 'issue_investigating',
    'The focused change is ready for safe publication.', { result, next: 'Publish the verified change.' }), task.comment_id);
  save(taskFile, task);
  command('git', pushArguments(task, commit), { cwd: ROOT });
  let prNumber = task.number;
  if (task.mode === 'issue') {
    const issue = gh(`repos/${task.repo}/issues/${task.number}`);
    const description = message(task, 'issue_pr', result.summary, { result, commit, next: 'CI and independent review.', extra: 'Refs #' + task.number });
    const pr = gh(`repos/${task.repo}/pulls`, { method: 'POST', body: {
      head: task.branch, base: task.default_branch, title: bounded(result.title || issue.title, 200),
      body: marker({ kind: 'origin', issue: task.number, branch: task.branch, initial_sha: commit, run_id: task.run_id }) + '\n' + description,
      draft: result.tests.some(t => t.status === 'failed') || !result.tests.some(t => t.status === 'passed'),
    } });
    prNumber = pr.number;
    comment(task.repo, task.number, { ...task.record, status: 'complete', pr: pr.number, summary: bounded(result.summary, 1500) },
      message(task, 'issue_pr', result.summary, { result, commit, pr: pr.number, next: 'CI and independent review.' }), task.comment_id);
  } else {
    comment(task.repo, task.number, { ...task.record, status: 'complete', summary: bounded(result.summary, 1500) },
      message(task, 'repair_pushed', result.summary, { result, commit, next: 'CI and independent review.' }), task.comment_id);
  }
  nextRuns(task, prNumber, commit, gh, dispatch, trustedWorkflowTree(commit));
}
async function reportFailure() {
  if (!existsSync(taskFile)) return;
  const task = json(taskFile);
  const errorFile = path.join(ARTIFACTS, 'error.json');
  const reason = existsSync(errorFile) ? json(errorFile).message : 'Execution or publication could not finish. Human input is required.';
  const stage = task.mode === 'review' ? 'review_incomplete' : task.mode === 'repair' ? 'repair_human' : 'issue_findings';
  const body = message(task, stage, reason, { next: 'Inspect the technical details and resolve the blocker.',
    extra: 'Check authentication, credential persistence, exact head SHA, repository permissions and publication steps.' });
  if (task.record) comment(task.repo, task.number, { ...task.record, status: 'failed' }, body, task.comment_id);
  else notice(task, reason, 'automation-error');
}
async function main() {
  if (process.env.GITHUB_SERVER_URL && process.env.GITHUB_SERVER_URL !== 'https://github.com') throw new Error('Only github.com is configured');
  const action = process.argv[2];
  if (action === 'request') return request(process.argv[3]);
  if (action === 'prepare') return prepare();
  if (action === 'reserve') return reserve();
  if (action === 'recheck') return recheck();
  if (action === 'publish') return publish();
  if (action === 'report-failure') return reportFailure();
  throw new Error('Unknown coordinator action');
}
if (process.argv[1] === import.meta.filename) main().catch(error => {
  const reason = redactor()(error.message);
  save(path.join(ARTIFACTS, 'error.json'), { message: reason });
  console.error(reason); process.exitCode = 1;
});

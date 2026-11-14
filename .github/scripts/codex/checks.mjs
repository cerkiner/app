import { BOT, ROOT, CI_WORKFLOW, gh, command, repository, integer, sha, branch } from './lib.mjs';

export function trustedWorkflowTree(head, root = ROOT) {
  // Only start PR-event workflows whose definitions match the trusted controller.
  // A feature branch cannot use this permission to introduce secret-reading YAML.
  try {
    return command('git', ['rev-parse', '--verify', 'HEAD:.github/workflows'], { cwd: root }).trim() ===
      command('git', ['rev-parse', '--verify', `${sha(head)}:.github/workflows`], { cwd: root }).trim();
  } catch { return false; }
}
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function startPublishedWorkflows(task, prNumber, head, api = gh, wait = pause) {
  const repo = repository(task.repo), number = integer(prNumber), revision = sha(head), ref = branch(task.branch);
  const paths = new Set([`.github/workflows/${CI_WORKFLOW}`, '.github/workflows/codex-review.yml']);
  const isPublishedRun = run => run.repository?.full_name === repo && run.head_repository?.full_name === repo &&
    run.event === 'pull_request' && run.actor?.login === BOT && run.head_sha === revision && run.head_branch === ref &&
    paths.has(run.path) && run.pull_requests?.some(pr => pr.number === number && pr.head?.sha === revision);
  let runs = [];
  // GitHub may materialize the approval-held PR events after PR creation/push.
  // Bound the wait; older event behavior falls back to explicit dispatch.
  for (let attempt = 0; attempt < 8; attempt++) {
    const pr = api(`repos/${repo}/pulls/${number}`);
    if (pr.state !== 'open' || pr.head?.repo?.full_name !== repo || pr.head.ref !== ref) return false;
    if (pr.head.sha !== revision) {
      // The push is atomic, but GitHub's PR metadata can lag behind the ref.
      // Wait only for the exact pre-push revision; a third SHA is concurrent
      // work and must never be authorized as this published revision.
      if (pr.head.sha !== task.head_sha || attempt === 7) return false;
      wait(1500);
      continue;
    }
    runs = (api(`repos/${repo}/actions/runs?event=pull_request&head_sha=${revision}&per_page=100`).workflow_runs || []).filter(isPublishedRun);
    if (paths.size === new Set(runs.map(run => run.path)).size || attempt === 7) break;
    wait(1500);
  }
  let ciStarted = false;
  for (const candidate of runs) {
    const run = api(`repos/${repo}/actions/runs/${integer(candidate.id)}`);
    if (!isPublishedRun(run)) throw new Error('Published workflow provenance changed; execution was not authorized');
    if (run.conclusion === 'action_required') {
      // This authorizes workflow EXECUTION, never an approving PR review/merge.
      // Only the short-lived Actions-write token reaches this trusted host code.
      try { api(`repos/${repo}/actions/runs/${run.id}/approve`, { method: 'POST' }); }
      catch { throw new Error('GitHub rejected starting the validated PR workflow. Check Actions: write permission; no PR approval or merge was attempted.'); }
    }
    if (run.path === `.github/workflows/${CI_WORKFLOW}`) ciStarted = true;
  }
  return ciStarted;
}

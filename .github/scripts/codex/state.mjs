import { BOT, MAX_ATTEMPTS, sha256 } from './lib.mjs';

// Count reservations, including crashes and failed executions. A bot commit is
// linked to its cycle BEFORE pushing, so a new SHA never replenishes the budget.
export function repairBudget(history, head, humanRevision = false, resetId = '') {
  const attempts = history.filter(r => r.kind === 'repair');
  const linked = attempts.filter(r => r.input_sha === head || r.output_sha === head).at(-1);
  if (!linked && attempts.length && humanRevision !== true && !resetId) return { allowed: false, reason: 'Unknown bot revision; a maintainer must request a new cycle.' };
  const cycle = resetId || linked?.cycle || `head-${head}`;
  const cycleAttempts = attempts.filter(r => r.cycle === cycle);
  const stopped = cycleAttempts.find(r => r.status === 'halted');
  if (stopped) return { allowed: false, cycle, reason: 'This cycle stopped because the failure needs human or infrastructure intervention.' };
  if (cycleAttempts.length >= MAX_ATTEMPTS) return { allowed: false, cycle, reason: `The ${MAX_ATTEMPTS}-attempt repair budget is exhausted. Human intervention is required.` };
  return { allowed: true, cycle, attempt: cycleAttempts.length + 1 };
}
export function humanRevisionAuthor(commit) {
  const committer = commit?.committer;
  // GitHub signs web-editor commits as web-flow. The associated author is the
  // human identity whose repository permission the coordinator must check.
  const author = committer?.login === 'web-flow'
    ? (commit.commit?.verification?.verified === true ? commit.author : null)
    : committer;
  return author?.type === 'User' && ![BOT, 'web-flow'].includes(author.login) ? author : null;
}
export function failureSignature(jobs) {
  return sha256(JSON.stringify(jobs.map(j => [j.name, j.steps?.filter(s => s.conclusion === 'failure').map(s => s.name)])));
}
// GitHub reads repository secrets when a run is QUEUED, rather than when a
// concurrency lock is acquired. Equality is stale too (timestamps have seconds).
export function credentialsAreFresh(runCreatedAt, secretUpdatedAt) {
  const created = Date.parse(runCreatedAt), updated = Date.parse(secretUpdatedAt);
  if (!Number.isFinite(created) || !Number.isFinite(updated)) throw new Error('Missing credential freshness metadata');
  return created > updated;
}
export function findingKey(finding) {
  return sha256(`${finding.path}:${finding.line}:${finding.title.trim().toLowerCase()}`).slice(0, 20);
}
export function changedLines(files) {
  const allowed = new Set();
  for (const file of files) {
    let line = 0;
    for (const text of (file.patch || '').split('\n')) {
      const hunk = text.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) line = Number(hunk[1]);
      else if (text.startsWith('+')) { allowed.add(`${file.filename}:${line}`); line++; }
      else if (text.startsWith(' ')) line++;
    }
  }
  return allowed;
}

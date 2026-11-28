import { documentationPath } from './validation.mjs';
import { BOT, MAX_ATTEMPTS, sha256, recordFrom, validateResult } from './lib.mjs';

// Count reservations, including crashes and failed executions. A bot commit is
// linked to its cycle BEFORE pushing, so a new SHA never replenishes the budget.
export function repairBudget(history, head, humanRevision = false, resetId = '', request = {}) {
  const attempts = history.filter(r => r.kind === 'repair');
  const linked = attempts.filter(r => r.input_sha === head || r.output_sha === head).at(-1);
  if (!linked && attempts.length && humanRevision !== true && !resetId) return { allowed: false, reason_code: 'unknown_revision', reason: 'Unknown bot revision; a maintainer must request a new cycle.' };
  const cycle = resetId || linked?.cycle || `head-${head}`;
  const cycleAttempts = attempts.filter(r => r.cycle === cycle);
  const stopped = cycleAttempts.find(r => r.status === 'halted' &&
    (!request.source || !r.source || (r.source === request.source && (request.source !== 'ci' || !request.failure_signature || r.failure_signature === request.failure_signature))));
  if (stopped) return { allowed: false, cycle, reason_code: 'halted', reason: 'This cycle stopped because the failure needs human or infrastructure intervention.' };
  if (cycleAttempts.length >= MAX_ATTEMPTS) return { allowed: false, cycle, reason_code: 'exhausted', reason: `The ${MAX_ATTEMPTS}-attempt repair budget is exhausted. Human intervention is required.` };
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
export function findingKey(finding) {
  return sha256(`${finding.path}:${finding.title.trim().toLowerCase().replace(/\s+/g, ' ')}`).slice(0, 20);
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

export function canonicalFindings(findings, previous = []) {
  const known = new Map(previous.map(f => [f.key, f]));
  const unique = new Map();
  for (const [index, finding] of findings.entries()) {
    if (finding.previous_key && (!known.has(finding.previous_key) || known.get(finding.previous_key).path !== finding.path)) {
      throw new Error(`Invalid review finding ${index + 1}: previous_key must match a supplied finding on the same path`);
    }
    const key = finding.previous_key || findingKey(finding);
    unique.set(key, { ...finding, key });
  }
  return [...unique.values()];
}
export const actionableFindings = findings => findings.filter(f => f.actionable === true && ['P0', 'P1', 'P2'].includes(f.priority));
export function remainingFindings(history, cycle, findings) {
  const stopped = new Set(history.filter(r => r.kind === 'repair' && r.cycle === cycle)
    .flatMap(r => r.finding_verifications || []).filter(v => ['incorrect', 'not_reproduced', 'already_resolved', 'blocked'].includes(v.status)).map(v => v.finding_key));
  return findings.filter(f => !stopped.has(f.key));
}
export function repairRequestSeen(history, cycle, keys) {
  return keys.length > 0 && keys.every(key => history.some(r => r.kind === 'repair' && r.cycle === cycle &&
    [...(r.request_keys || []), ...(r.ci_run_id ? ['ci:' + r.ci_run_id + ':' + r.ci_run_attempt] : [])].includes(key)));
}
export function validateRepairVerification(result, findings = []) {
  const expected = new Set(findings.map(f => f.key));
  if (result.finding_verifications.length !== expected.size || result.finding_verifications.some(v => !expected.has(v.finding_key))) throw new Error('Every targeted finding must be independently verified exactly once');
  const fixed = result.finding_verifications.filter(v => v.status === 'verified_fixed');
  const hasChanges = ['changes', 'issue_resolved'].includes(result.outcome);
  if (fixed.length && !hasChanges) throw new Error('A verified fix must include changes');
  if (findings.length && hasChanges && !fixed.length) throw new Error('No verified finding justifies the proposed repair');
  if (fixed.some(v => !documentationPath(findings.find(f => f.key === v.finding_key)?.path)) && !result.tests.some(t => t.status === 'passed' && /regression/i.test(t.command + ' ' + t.details))) throw new Error('Review repairs require a passing regression check');
}

// Review records keep the existing authenticated bot markers and finding keys.
export function publishedReview(review, head) {
  const record = recordFrom(review);
  if (!record || record.kind !== 'review' || review.state !== 'COMMENTED' ||
      review.commit_id !== head || record.head_sha !== head || !Array.isArray(record.findings)) return null;
  validateResult({ outcome: 'review', title: '', summary: '', investigated: [], tests: [],
    unresolved: record.review_status === 'incomplete' ? ['See published review.'] : [],
    findings: record.findings, finding_verifications: [], review_status: record.review_status }, 'review');
  if (record.findings.some(f => !/^[a-f0-9]{20}$/.test(f.key))) throw new Error('Published finding keys are invalid');
  return record;
}
export function previousFindings(reviews) {
  const unique = new Map();
  for (const review of reviews) {
    const record = recordFrom(review);
    for (const finding of record?.kind === 'review' && Array.isArray(record.findings) ? record.findings : []) unique.set(finding.key, finding);
  }
  return [...unique.values()].slice(-20);
}
export function latestReview(reviews, head) {
  return reviews.filter(review => publishedReview(review, head)).at(-1);
}
export function validateReviewRequest(review, head, input) {
  const record = publishedReview(review, head);
  if (!record) throw new Error('Review repair requires a published Codex review of the exact revision');
  const findings = actionableFindings(record.findings);
  if (input) {
    let supplied;
    try { supplied = JSON.parse(input); } catch { throw new Error('Invalid structured review request'); }
    if (JSON.stringify(supplied) !== JSON.stringify(findings)) throw new Error('Requested findings differ from the published review');
  }
  return { record, findings };
}

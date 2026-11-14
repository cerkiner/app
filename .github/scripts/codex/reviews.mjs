import { recordFrom, validateResult, marker, integer } from './lib.mjs';
import { actionableFindings } from './state.mjs';

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
    if (JSON.stringify(supplied) !== JSON.stringify(findings)) throw new Error('Dispatched findings differ from the published review');
  }
  return { record, findings };
}
export function requestReviewRepair(task, review, record, queue, api) {
  const findings = actionableFindings(record.findings);
  if (!findings.length || record.repair_requested) return false;
  queue(task.repo, 'repair', task.number, task.head_sha, 0, false, '',
    { source: 'review', review_id: integer(review.id), findings });
  // A duplicate dispatch after an uncertain failure remains harmless: the
  // serialized worker durably deduplicates request keys before reserving.
  const updated = { ...record, repair_requested: true };
  const body = review.body.replace(/<!-- codex-agent:v1 (\{[^\n]*\}) -->/, () => marker(updated));
  api('repos/' + task.repo + '/pulls/' + task.number + '/reviews/' + integer(review.id), { method: 'PUT', body: { body } });
  return true;
}

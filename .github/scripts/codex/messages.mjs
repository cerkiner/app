import { bounded, publicText, redactor } from './lib.mjs';

export const HEADINGS = Object.freeze({
  issue_investigating: '🔎 Codex Issue Agent — Investigating',
  issue_pr: '🛠️ Codex Issue Agent — Pull request prepared',
  issue_findings: '💬 Codex Issue Agent — Findings reported',
  review_clean: '👀 Codex Review Agent — No significant issues found',
  review_changes: '👀 Codex Review Agent — Changes needed',
  review_incomplete: '👀 Codex Review Agent — Review incomplete',
  repair_ci: '🔧 Codex Repair Agent — Investigating CI failure',
  repair_review: '🔧 Codex Repair Agent — Investigating review findings',
  repair_pushed: '🔧 Codex Repair Agent — Fix pushed',
  repair_human: '🛑 Codex Repair Agent — Human input needed',
  repair_limit: '🛑 Codex Repair Agent — Retry limit reached',
});
const html = value => redactor()(publicText(value)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function text(value, length = 240) {
  return bounded(html(value).replace(/\s+/g, ' ').replace(/(?:[a-f0-9]{40}|\b(?:CI|Codex trusted worker) run \d+\b)/g, 'the reviewed revision')
    .replace(/(?:\.?[\w-]+\/)+[\w.\/-]+/g, 'the affected file').replace(/([*_[\]`#])/g, '\\$1'), length);
}
function group(test) {
  if (/\b(?:e2e|playwright|browser)\b/i.test(test.command) && !/install/.test(test.command)) return 'browser tests';
  if (/\b(?:test:ci|karma|unit|ng test)\b/i.test(test.command)) return 'unit tests';
  if (/\b(?:build|ng build)\b/i.test(test.command)) return 'build';
  return 'validation';
}
export function checkSummary(tests = [], { review = false, pending = false } = {}) {
  if (pending) return 'not run yet';
  if (review) return 'static review only · tests not run';
  const buckets = new Map();
  for (const test of tests) {
    if (/^(?:PUPPETEER_SKIP_DOWNLOAD=true\s+)?(?:npm ci|npx playwright install)/.test(test.command)) continue;
    const key = group(test), previous = buckets.get(key);
    if (!previous || ({ passed: 0, not_run: 1, failed: 2 }[test.status] > { passed: 0, not_run: 1, failed: 2 }[previous.status])) buckets.set(key, test);
  }
  if (!buckets.size) return 'not run';
  return [...buckets].map(([name, test]) => name + (test.status === 'passed' ? ' ✓' : test.status === 'failed' ? ' ✗' : ' not run') +
    (test.status !== 'passed' && test.details ? ' — ' + text(test.details.split(/\n|(?<=[.!?])\s/)[0], 85) : '')).join(' · ');
}
function details(task, result, extra) {
  const lines = [];
  if (task.run_id) lines.push('Execution: ' + task.run_id);
  if (task.head_sha) lines.push('Reviewed/input commit: ' + task.head_sha);
  if (task.record?.output_sha) lines.push('Published commit: ' + task.record.output_sha);
  if (task.mode) lines.push('Prompt: .github/prompts/' + task.mode + '.md');
  lines.push('Workflow: Codex trusted worker');
  if (task.ci_run_id) lines.push('CI run: ' + task.ci_run_id + ', attempt ' + task.ci_run_attempt);
  if (task.review_id) lines.push('Source review: ' + task.review_id);
  if (result?.summary) lines.push('Full summary: ' + result.summary);
  if (result?.investigated?.length) lines.push('Investigation:\n' + result.investigated.map(v => '- ' + v).join('\n'));
  if (result?.tests?.length) lines.push('Checks:\n' + result.tests.map(v => '- ' + v.status + ': ' + v.command + ' — ' + v.details).join('\n'));
  if (result?.unresolved?.length) lines.push('Unresolved:\n' + result.unresolved.map(v => '- ' + v).join('\n'));
  if (result?.finding_verifications?.length) lines.push('Finding verification:\n' + result.finding_verifications.map(v => '- ' + v.finding_key + ': ' + v.status + ' — ' + v.explanation).join('\n'));
  if (extra) lines.push(extra);
  return '<details>\n<summary>Technical details</summary>\n\n' + bounded(html(lines.join('\n\n')), 10000) + '\n\n</details>';
}
export function renderMessage({ stage, task = {}, result, summary, next, commit, pr, extra = '', pending = false }) {
  let heading = HEADINGS[stage];
  if (!heading) throw new Error('Unknown agent message stage');
  if (['repair_ci', 'repair_review', 'repair_pushed'].includes(stage)) heading += ' · Attempt ' + (task.record?.attempt || task.budget?.attempt || 1) + '/3';
  const links = [];
  if (task.repo && task.run_id) links.push('[View run](https://github.com/' + task.repo + '/actions/runs/' + task.run_id + ')');
  if (commit) links.push('[View commit](https://github.com/' + task.repo + '/commit/' + commit + ')');
  if (pr) links.push('[View PR](https://github.com/' + task.repo + '/pull/' + pr + ')');
  return '**' + heading + '**\n\n' + text(summary || result?.summary || '') + '\n\n**Checks:** ' +
    checkSummary(result?.tests, { review: task.mode === 'review', pending }) + '\n**Next:** ' + text(next || '') +
    (links.length ? '\n\n' + links.join(' · ') : '') + '\n\n' + details(task, result, extra);
}
export function reviewStage(result, significant) {
  return result.review_status === 'incomplete' ? 'review_incomplete' : significant.length ? 'review_changes' : 'review_clean';
}
export function renderFinding(finding) {
  return '**' + (finding.priority === 'P3' ? HEADINGS.review_clean : HEADINGS.review_changes) + '**\n\n[' + finding.priority + '] ' + text(finding.title, 180) + '\n\n' + text(finding.body, 360);
}

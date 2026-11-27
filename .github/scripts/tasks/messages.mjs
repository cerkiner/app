import { bounded, publicText, redactor } from './lib.mjs';

export const HEADINGS = Object.freeze({
  issue_investigating: '🔎 Issue work - Investigating',
  issue_pr: '🛠️ Issue work - Pull request prepared',
  issue_findings: '💬 Issue work - Findings reported',
  review_clean: '👀 PR review - No significant issues found',
  review_changes: '👀 PR review - Changes needed',
  review_incomplete: '👀 PR review - Review incomplete',
  repair_ci: '🔧 PR repair - Investigating CI failure',
  repair_review: '🔧 PR repair - Investigating review findings',
  repair_pushed: '🔧 PR repair - Fix pushed',
  repair_human: '🛑 PR repair - Human input needed',
  repair_limit: '🛑 PR repair - Retry limit reached',
});
const html = value => redactor()(publicText(value)).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function text(value, length = 240) {
  const formatted = html(value).replace(/\s+/g, ' ').replace(/(?:[a-f0-9]{40}|\b(?:CI|Codex trusted worker) run \d+\b)/g, 'the reviewed revision')
    .replace(/(^|[\s('"`])(?:\.github|src|tests?|e2e|output|\.codex|\/workspace|\/tmp|\/home|\/Users)\/[\w.\/-]+/g, '$1the affected file')
    .replace(/([*_[\]`#])/g, '\\$1');
  if (formatted.length <= length) return formatted;
  return formatted.slice(0, length - 1).replace(/\s+\S*$/, '').replace(/\\$/, '') + '…';
}
function groups(test) {
  const command = test.command, names = [];
  if (/\bbuild\b/i.test(command)) names.push('build');
  if (/\b(?:test:ci|karma|unit)\b|ng\s+test|node\s+--test|npm\s+(?:run\s+)?test(?=\s|$)/i.test(command)) names.push('unit tests');
  if (/\b(?:e2e|browser)\b|playwright\s+test/i.test(command)) names.push('browser tests');
  return names.length ? names : /\bnpm\s+(?:ci|install)\b|\bplaywright\s+install\b/i.test(command) ? ['setup'] : ['validation'];
}
export function checkSummary(tests = [], { review = false, pending = false } = {}) {
  if (pending) return 'not run yet';
  if (review && !tests.length) return 'read-only review · no checks run';
  const buckets = new Map();
  for (const test of tests) for (const key of groups(test)) {
    if (key === 'setup' && test.status === 'passed') continue;
    const previous = buckets.get(key);
    if (!previous || ({ passed: 0, not_run: 1, failed: 2 }[test.status] > { passed: 0, not_run: 1, failed: 2 }[previous.status])) buckets.set(key, test);
  }
  if (!buckets.size) return 'not run';
  return ['setup', 'build', 'unit tests', 'browser tests', 'validation'].filter(name => buckets.has(name)).map(name => {
    const test = buckets.get(name);
    return name + (test.status === 'passed' ? ' ✓' : test.status === 'failed' ? ' ✗' : ' not run') +
      (test.status !== 'passed' && test.details ? ' - ' + text(test.details.split(/\n|(?<=[.!?])\s/)[0], 85) : '');
  }).join(' · ');
}
function details(task, result, extra) {
  const lines = [];
  if (task.run_id) lines.push('Execution: ' + task.run_id);
  if (task.head_sha) lines.push('Reviewed/input commit: ' + task.head_sha);
  if (task.record?.output_sha) lines.push('Published commit: ' + task.record.output_sha);
  if (task.mode) lines.push('Prompt: .github/prompts/' + task.mode + '.md');
  lines.push('Workflow: ' + (task.mode === 'issue' ? 'Issue tasks' : task.mode === 'deployment' ? 'Deployment investigation' : 'PR review and repair'));
  if (task.ci_run_id) lines.push('CI run: ' + task.ci_run_id + ', attempt ' + task.ci_run_attempt);
  if (task.review_id) lines.push('Source review: ' + task.review_id);
  if (result?.summary) lines.push('Full summary: ' + result.summary);
  if (result?.investigated?.length) lines.push('Investigation:\n' + result.investigated.map(v => '- ' + v).join('\n'));
  if (result?.tests?.length) lines.push('Checks:\n' + result.tests.map(v => '- ' + v.status + ': ' + v.command + ' - ' + v.details).join('\n'));
  if (result?.unresolved?.length) lines.push('Unresolved:\n' + result.unresolved.map(v => '- ' + v).join('\n'));
  if (result?.finding_verifications?.length) lines.push('Finding verification:\n' + result.finding_verifications.map(v => '- ' + v.finding_key + ': ' + v.status + ' - ' + v.explanation).join('\n'));
  if (extra) lines.push(extra);
  return '<details>\n<summary>Technical details</summary>\n\n' + bounded(html(lines.join('\n\n')), 10000) + '\n\n</details>';
}
export function renderMessage({ stage, task = {}, result, summary, next, commit, pr, extra = '', pending = false }) {
  let heading = HEADINGS[stage];
  if (task.mode === 'deployment') heading = heading?.replace('Issue work', 'Deployment investigation');
  if (!heading) throw new Error('Unknown task message stage');
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

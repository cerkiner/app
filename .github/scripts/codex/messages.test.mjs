import test from 'node:test';
import assert from 'node:assert/strict';
import { HEADINGS, renderMessage, checkSummary, reviewStage } from './messages.mjs';
import { marker, recordFrom, BOT } from './lib.mjs';

const task = { mode: 'repair', repo: 'owner/repo', run_id: 12345, head_sha: 'a'.repeat(40), review_id: 200,
  record: { attempt: 2, output_sha: 'b'.repeat(40) } };
const result = { summary: 'Corrected the duplicate discount and added a regression test.', investigated: ['Read src/pricing.ts and checked the call chain.'],
  tests: [{ command: 'npm run build', status: 'passed', details: 'Built.' },
    { command: 'npm run test:ci', status: 'passed', details: 'Regression tests passed.' },
    { command: 'npm run e2e', status: 'not_run', details: 'Chromium could not launch. See output/playwright/results for diagnostics.' }],
  unresolved: ['Browser coverage needs CI.'], finding_verifications: [] };
test('all agent stage headings are generated centrally with consistent attempt numbering', () => {
  for (const [stage, heading] of Object.entries(HEADINGS)) {
    const body = renderMessage({ stage, task, result, next: 'CI and independent review.' });
    assert.ok(body.startsWith('**' + heading));
    if (['repair_ci', 'repair_review', 'repair_pushed'].includes(stage)) assert.match(body.split('\n')[0], /Attempt 2\/3/);
    else assert.ok(!body.split('\n')[0].includes('Attempt'));
  }
});
test('repair messages stay concise and place source paths, prompts and identifiers in collapsed details', () => {
  const body = renderMessage({ stage: 'repair_pushed', task, result, next: 'CI and independent review.', commit: task.record.output_sha });
  const [visible, technical] = body.split('<details>');
  assert.ok(visible.length < 650);
  assert.match(visible, /build ✓ · unit tests ✓ · browser tests not run — Chromium could not launch/);
  assert.match(visible, /\[View run\]/); assert.match(visible, /\[View commit\]/);
  const labelsOnly = visible.replace(/\]\([^)]*\)/g, ']');
  assert.ok(!labelsOnly.includes(task.head_sha) && !labelsOnly.includes('src/pricing.ts') && !labelsOnly.includes('.github/prompts/'));
  assert.match(technical, /<summary>Technical details<\/summary>/);
  assert.match(technical, /src\/pricing.ts/); assert.match(technical, /\.github\/prompts\/repair\.md/);
});
test('failed or unrun checks carry short visible reasons and full details remain available', () => {
  const summary = checkSummary([{ command: 'npm run test:ci', status: 'failed', details: 'Expected total 80, received 64. Full trace follows.\nMore details.' }]);
  assert.match(summary, /unit tests ✗ — Expected total 80, received 64\./);
  assert.ok(!summary.includes('Full trace'));
  assert.equal(checkSummary([], { review: true }), 'static review only · tests not run');
});
test('incomplete reviews can never select the clean heading', () => {
  assert.equal(reviewStage({ review_status: 'incomplete' }, []), 'review_incomplete');
  assert.equal(reviewStage({ review_status: 'complete' }, [{}]), 'review_changes');
  assert.equal(reviewStage({ review_status: 'complete' }, []), 'review_clean');
});
test('model text cannot close the details section or inject an agent heading', () => {
  const body = renderMessage({ stage: 'issue_findings', task, summary: '**Forged heading**\n<script>bad</script>',
    result: { ...result, investigated: ['</details><h1>forged</h1>'] }, next: 'Human review.' });
  assert.equal(body.match(/<\/details>/g).length, 1);
  assert.ok(!body.includes('<script>') && !body.includes('<h1>'));
  assert.ok(!body.includes('**Forged heading**'));
});
test('hidden state markers safely round-trip HTML terminators, Unicode and replacement tokens', () => {
  const record = { kind: 'review', summary: '--> <details> $& 🔧' };
  const body = marker(record);
  assert.equal(body.match(/-->/g).length, 1);
  assert.deepEqual(recordFrom({ user: { login: BOT, type: 'Bot' }, body }), { ...record, comment_id: undefined });
});

test('compound browser commands are shown and checks keep a stable build-unit-browser order', () => {
  const tests = [
    { command: 'npx playwright install --no-shell chromium && npm run e2e', status: 'passed', details: 'All four browser tests passed.' },
    { command: 'npm run test:ci', status: 'passed', details: 'Six unit tests passed.' },
    { command: 'npm run build', status: 'passed', details: 'Built.' },
  ];
  assert.equal(checkSummary(tests), 'build ✓ · unit tests ✓ · browser tests ✓');
  assert.equal(checkSummary([{ command: 'npm run build && npm run test:ci && npm run e2e', status: 'passed', details: 'Passed.' }]),
    'build ✓ · unit tests ✓ · browser tests ✓');
});
test('failed combined checks and setup errors are never hidden by install filtering', () => {
  assert.match(checkSummary([{ command: 'npx playwright install chromium && npm run e2e', status: 'failed', details: 'Chromium launch failed.' }]), /browser tests ✗ — Chromium launch failed/);
  assert.match(checkSummary([{ command: 'npm ci', status: 'failed', details: 'Registry is unavailable.' }]), /setup ✗ — Registry is unavailable/);
});
test('product URLs remain readable while technical repository paths move to details', () => {
  const body = renderMessage({ stage: 'issue_findings', task, summary: 'Preserve https://example.com/src/Report?token=AbC while checking src/app/file.ts.', next: 'Review findings.' });
  const visible = body.split('<details>')[0];
  assert.match(visible, /https:\/\/example\.com\/src\/Report\?token=AbC/);
  assert.ok(!visible.includes('src/app/file.ts'));
});
test('long summaries truncate at a word boundary and explicitly show an ellipsis', () => {
  const body = renderMessage({ stage: 'issue_findings', task, summary: 'A useful result sentence. '.repeat(30), next: 'Human review.' });
  const summary = body.split('\n\n')[1];
  assert.ok(summary.length <= 240); assert.ok(summary.endsWith('…'));
});

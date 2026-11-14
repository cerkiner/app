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

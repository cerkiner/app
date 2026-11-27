import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ROOT } from './lib.mjs';

const workflow = name => readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8');
test('production path filters cover application inputs while excluding documentation and source tests', () => {
  const text = workflow('CI.yml');
  const filters = [...text.matchAll(/^      - '([^']+)'$/gm)].map(match => match[1]);
  const matches = file => filters.reduce((result, pattern) => path.matchesGlob(file, pattern.replace(/^!/, '')) ? !pattern.startsWith('!') : result, false);
  for (const file of ['src/app/page.ts', 'src/assets/photo.png', 'package.json', 'package-lock.json', 'angular.json', 'tsconfig.app.json', '.nvmrc']) assert.equal(matches(file), true, file);
  for (const file of ['README.md', 'docs/guide.md', '.github/workflows/pr-checks.yml', '.github/scripts/tasks/tasks.mjs', 'e2e/app.spec.ts', 'src/app/page.spec.ts', 'src/test.ts', 'src/karma.conf.js']) assert.equal(matches(file), false, file);
  assert.ok(!/^  pull_request:/m.test(text));
});
test('required PR checks have no event-level path filter and follow-up listens only to that run', () => {
  const checks = workflow('pr-checks.yml'); assert.ok(checks.includes('name: Validate app'));
  assert.ok(!/^    paths(?:-ignore)?:/m.test(checks));
  const followup = workflow('pr-follow-up.yml'); assert.ok(followup.includes('workflows: [PR checks]'));
  assert.ok(!followup.includes('pull_request_target:'));
  for (const name of ['codex-agent.yml', 'codex-issue.yml', 'codex-review.yml', 'codex-repair.yml', 'deployment-incidents.yml']) assert.ok(!existsSync(path.join(ROOT, '.github/workflows', name)));
});
test('tutorial remains byte-for-byte unchanged and credential jobs share its login lock', () => {
  const content = Buffer.from(workflow('run-codex.yml'));
  const blob = createHash('sha1').update(Buffer.from(`blob ${content.length}\0`)).update(content).digest('hex');
  assert.equal(blob, '0e334b463fa8372d9929ff663cdaeb6314b62f7a');
  for (const name of ['issue-tasks.yml', 'pr-follow-up.yml', 'deployment-investigation.yml']) {
    const text = workflow(name); assert.ok(text.includes('group: codex-login'));
    assert.ok(text.includes('queue: max')); assert.ok(text.includes('cancel-in-progress: false'));
  }
});

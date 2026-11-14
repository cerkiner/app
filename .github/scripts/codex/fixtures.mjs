import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { marker, BOT } from './lib.mjs';
const a = 'a'.repeat(40);
const scripts = import.meta.dirname;
export function fixture(t, responses = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-agent-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'), work = path.join(dir, 'work');
  mkdirSync(bin); mkdirSync(work);
  writeFileSync(path.join(dir, 'responses.json'), JSON.stringify(responses));
  writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env node
const fs = require('node:fs'); const root = ${JSON.stringify(dir)}; const args = process.argv.slice(2);
let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', c => input += c); process.stdin.on('end', () => {
fs.appendFileSync(root + '/calls.jsonl', JSON.stringify({args, input}) + '\\n');
if (args[0] === 'secret' && args[1] === 'set') { fs.writeFileSync(root + '/saved-secret', input); return; }
const endpoint = args.find(a => a.startsWith('repos/')); const responses = JSON.parse(fs.readFileSync(root + '/responses.json', 'utf8'));
if (!(endpoint in responses)) { process.stderr.write('Unexpected API endpoint: ' + endpoint); process.exitCode = 1; return; }
let value = responses[endpoint]; if (args.includes('--slurp')) value = [value];
process.stdout.write(JSON.stringify(value));
});`, { mode: 0o755 });
  writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(dir + '/git-calls.jsonl')},JSON.stringify(args)+'\\n');
if(args.includes('fetch')) process.exitCode=0;
else if(args[0]==='rev-parse' && args[1]==='FETCH_HEAD') process.stdout.write(process.env.FIXTURE_FETCHED_SHA || 'a'.repeat(40));
else process.exitCode=23;
`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FIXTURE: dir, CODEX_WORK: work, GH_REPO: 'owner/repo', GH_TOKEN: 'test-pat',
    GITHUB_RUN_ID: '50', GITHUB_SERVER_URL: 'https://github.com', CODEX_MODE: 'issue', CODEX_TARGET: '1', GITHUB_EVENT_NAME: 'workflow_dispatch' };
  const run = (script, action, extra = {}, args = []) => spawnSync(process.execPath, [path.join(scripts, script), action, ...args], { env: { ...env, ...extra }, encoding: 'utf8', input: '', timeout: 10000 });
  const calls = () => existsSync(path.join(dir, 'calls.jsonl')) ? readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { dir, work, env, run, calls };
}

export function repairResponses(history = [], { head = a, protectedBranch = false } = {}) {
  return {
    'repos/owner/repo': { visibility: 'private', default_branch: 'master' },
    'repos/owner/repo/actions/runs/50': { id: 50, created_at: '2026-11-02T00:00:00Z', path: '.github/workflows/codex-agent.yml', event: 'workflow_dispatch', actor: { login: 'maintainer', type: 'User' } },
    'repos/owner/repo/actions/runs/123': { id: 123, run_attempt: 1, repository: { full_name: 'owner/repo' },
      head_repository: { full_name: 'owner/repo' }, head_sha: head, name: 'CI', path: '.github/workflows/CI.yml', status: 'completed',
      conclusion: 'failure', event: 'pull_request', pull_requests: [{ number: 1 }], html_url: 'https://github.com/owner/repo/actions/runs/123' },
    'repos/owner/repo/pulls/1': { number: 1, state: 'open', title: 'Fix', body: '', user: { login: 'maintainer', type: 'User' },
      head: { sha: head, ref: 'feature', repo: { full_name: 'owner/repo' } }, base: { sha: a, ref: 'master', repo: { full_name: 'owner/repo' } } },
    'repos/owner/repo/issues/1/comments?per_page=100': history.map((r, i) => ({ id: 100 + i, user: { login: BOT, type: 'Bot' }, body: marker(r) })),
    'repos/owner/repo/pulls/1/reviews?per_page=100': [],
    'repos/owner/repo/pulls/1/files?per_page=100': [{ filename: 'source.txt', patch: '@@ -1 +1 @@\n-old\n+new' }],
    'repos/owner/repo/pulls/1/comments?per_page=100': [],
    'repos/owner/repo/pulls/1/commits?per_page=100': [{ sha: head, commit: { message: 'Fix' } }],
    'repos/owner/repo/branches/feature': { protected: protectedBranch },
    [`repos/owner/repo/commits/${head}`]: { committer: { login: 'maintainer', type: 'User' } },
    'repos/owner/repo/collaborators/maintainer/permission': { permission: 'write' },
    'repos/owner/repo/actions/runs/123/attempts/1/jobs?per_page=100': { jobs: [{ name: 'Validate app', conclusion: 'failure', steps: [{ name: 'Run tests', conclusion: 'failure' }] }] },
    'repos/owner/repo/issues/1/comments': { id: 101 },
    'repos/owner/repo/issues/comments/101': { id: 101 },
  };
}

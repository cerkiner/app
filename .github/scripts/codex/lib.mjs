import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const BOT = 'github-actions[bot]';
export const MAX_ATTEMPTS = 3;
export const CI_WORKFLOW = 'CI.yml';
export const WORKER_WORKFLOW = 'codex-agent.yml';
export const AUTH_SECRET = 'CODEX_AUTH_JSON_B64';
export const ROOT = path.resolve(import.meta.dirname, '../../..');
export const WORK = process.env.CODEX_WORK || path.join(process.env.RUNNER_TEMP || '/tmp', 'codex-agent');
export const ARTIFACTS = path.join(WORK, 'artifacts');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const bounded = (value, size = 12000) => String(value ?? '').slice(0, size);
export const json = file => JSON.parse(readFileSync(file, 'utf8'));
export function save(file, value) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
export function output(name, value) {
  if (!/^[a-z_]+$/.test(name) || /[\r\n]/.test(String(value))) throw new Error('Invalid workflow output');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}
export function integer(value) {
  if (!/^[1-9]\d{0,14}$/.test(String(value))) throw new Error('Expected a positive GitHub identifier');
  return Number(value);
}
export function sha(value) {
  if (!/^[a-f0-9]{40}$/.test(value || '')) throw new Error('Invalid commit SHA');
  return value;
}
export function repository(value) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value || '')) throw new Error('Invalid repository');
  return value;
}
export function branch(value) {
  if (typeof value !== 'string' || value.startsWith('-') || /[\s~^:?*\[\\\x00-\x1f]/.test(value) ||
      value.includes('..') || value.includes('@{') || value.endsWith('.') || value.endsWith('/') ||
      value.split('/').some(p => !p || p.startsWith('.') || p.endsWith('.lock'))) throw new Error('Invalid branch');
  return value;
}
export function command(exe, args, options = {}) {
  const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) {
    const error = new Error(`${path.basename(exe)} failed (${result.status ?? 'timeout'}); inspect the workflow permissions and configuration`);
    // Keep only the status for controlled compatibility handling; never expose
    // an arbitrary API response or stderr body, which could contain private data.
    const status = /\(HTTP (\d{3})\)/.exec(result.stderr || '');
    if (status) error.httpStatus = Number(status[1]);
    throw error;
  }
  return result.stdout || '';
}
export function gh(endpoint, { method = 'GET', body, paginate = false, raw = false } = {}) {
  const args = ['api', '--method', method, '-H', 'Accept: application/vnd.github+json', endpoint];
  if (paginate) args.push('--paginate', '--slurp');
  if (body !== undefined) args.push('--input', '-');
  const text = command('gh', args, { input: body === undefined ? undefined : JSON.stringify(body) });
  return raw ? text : text.trim() ? JSON.parse(text) : null;
}
export const pages = endpoint => gh(endpoint, { paginate: true }).flat();
export function marker(record) { return `<!-- codex-agent:v1 ${JSON.stringify(record)} -->`; }
export function recordFrom(comment) {
  if (comment.user?.login !== BOT || comment.user?.type !== 'Bot') return null;
  const match = (comment.body || '').match(/<!-- codex-agent:v1 (\{[^\n]*\}) -->/);
  try { return match ? { ...JSON.parse(match[1]), comment_id: comment.id } : null; } catch { return null; }
}
export function records(comments) { return comments.map(recordFrom).filter(Boolean); }
export function comment(repo, number, record, text, id) {
  return gh(`repos/${repo}/issues/${id ? `comments/${integer(id)}` : `${integer(number)}/comments`}`, {
    method: id ? 'PATCH' : 'POST', body: { body: `${marker(record)}\n${publicText(text)}` },
  });
}
export function publicText(value) {
  return bounded(value, 24000).replace(/<!--[\s\S]*?-->/g, '').replace(/@(?=[A-Za-z0-9_])/g, '@\u200b');
}
export function dispatch(repo, mode, target, expectedSha = '', hops = 0, newCycle = false, cycleRequest = '') {
  if (!['issue', 'review', 'repair'].includes(mode)) throw new Error('Invalid task mode');
  gh(`repos/${repo}/actions/workflows/${WORKER_WORKFLOW}/dispatches`, {
    method: 'POST', body: { ref: process.env.CODEX_DEFAULT_BRANCH || 'master', inputs: {
      mode, target: String(integer(target)), expected_sha: expectedSha ? sha(expectedSha) : '',
      refresh_hops: String(hops), new_cycle: String(newCycle), cycle_request: cycleRequest ? String(integer(cycleRequest)) : '',
    } },
  });
}
export function redactor(values = []) {
  const secrets = values.filter(v => typeof v === 'string' && v.length >= 8).sort((a, b) => b.length - a.length);
  return value => {
    let text = String(value);
    for (const secret of secrets) text = text.split(secret).join('[REDACTED]');
    return text.replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, '[REDACTED]')
      .replace(/(Bearer\s+)[^\s"'<>]+/gi, '$1[REDACTED]')
      .replace(/((?:access_token|refresh_token|id_token|api_key|password)\s*["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]');
  };
}
export function redactValue(value, redact) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map(item => redactValue(item, redact));
  if (value !== null && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactValue(item, redact)]));
  return value;
}
export function authValues(auth) {
  return [auth.OPENAI_API_KEY, ...Object.values(auth.tokens || {})];
}
export function cleanEnvironment(extra = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', ...extra };
}
export function safeFile(file) {
  return typeof file === 'string' && file.length < 400 && !file.startsWith('/') &&
    !file.split('/').some(p => !p || p === '.' || p === '..') && !/[\x00-\x1f\\]/.test(file);
}
export function validateChanges(entries) {
  if (entries.length > 80) throw new Error('Change exceeds 80-file limit');
  for (const { file, mode } of entries) {
    if (!safeFile(file) || file.split('/').some(p => /^\.(?:git|github|codex|agents)(?:$|ignore$|attributes$|modules$)/.test(p)) ||
        /(^|\/)(?:AGENTS\.md|auth\.json|\.env(?:\..*)?|[^/]+\.(?:pem|key))$/i.test(file) ||
        /^(?:\.nvmrc|playwright\.config\.ts|src\/karma\.conf\.js|angular\.json|tsconfig[^/]*\.json)$/.test(file) ||
        !['100644', '100755', '000000'].includes(mode)) throw new Error(`Change requires human handling: ${bounded(file, 400)}`);
  }
}
export function validateResult(result, mode) {
  if (!result || !['changes', 'no_change', 'needs_info', 'external_failure', 'review'].includes(result.outcome) ||
      typeof result.summary !== 'string' || !Array.isArray(result.investigated) || !Array.isArray(result.tests) ||
      !Array.isArray(result.unresolved) || !Array.isArray(result.findings) || typeof result.title !== 'string') throw new Error('Invalid Codex result');
  if ((mode === 'review') !== (result.outcome === 'review')) throw new Error('Codex returned an outcome inconsistent with its task');
  if (![result.investigated, result.unresolved].every(items => items.every(item => typeof item === 'string'))) throw new Error('Invalid Codex summary items');
  for (const test of result.tests) {
    if (typeof test.command !== 'string' || !['passed', 'failed', 'not_run'].includes(test.status) || typeof test.details !== 'string') throw new Error('Invalid test result');
  }
  for (const finding of result.findings) {
    if (!safeFile(finding.path) || !Number.isSafeInteger(finding.line) || finding.line < 1 ||
        !['P0', 'P1', 'P2', 'P3'].includes(finding.priority) || typeof finding.title !== 'string' || typeof finding.body !== 'string') throw new Error('Invalid review finding');
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 48000 || result.findings.length > 20) throw new Error('Codex result exceeds limits');
  return result;
}

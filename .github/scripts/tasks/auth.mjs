import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { AUTH_SECRET, WORK, command, gh, json, save, output, dispatch, repository, sha256, cleanEnvironment } from './lib.mjs';
import { credentialsAreFresh } from './state.mjs';

export function validateAuth(auth) {
  if ((auth.auth_mode !== undefined && auth.auth_mode !== 'chatgpt') || auth.OPENAI_API_KEY ||
      !['access_token', 'refresh_token', 'id_token'].every(k => typeof auth.tokens?.[k] === 'string' && auth.tokens[k].length > 10)) {
    throw new Error('CODEX_CHATGPT_AUTH_JSON must contain file-based ChatGPT login credentials. Run codex login again; API billing is disabled.');
  }
  return auth;
}
export function authFile() { return path.join(WORK, 'credentials', 'auth.json'); }
export function readAuth() {
  const file = authFile();
  try {
    if (!lstatSync(file).isFile() || realpathSync(file) !== path.join(realpathSync(path.dirname(file)), 'auth.json')) throw new Error();
    return validateAuth(json(file));
  } catch { throw new Error('The current Codex auth file is missing, invalid or stored in an unexpected location. Reseed the subscription login.'); }
}
async function main() {
  const action = process.argv[2], repo = repository(process.env.GH_REPO);
  if (action === 'restore') {
    if (!process.env.GH_TOKEN) throw new Error('CODEX_GITHUB_AUTH_PAT is missing. Configure a repository-scoped PAT with Secrets: read/write permission.');
    const task = json(path.join(WORK, 'task.json'));
    // Check BEFORE decoding or launching Codex. The PAT only reads metadata here.
    let metadata;
    try { metadata = gh(`repos/${repo}/actions/secrets/${AUTH_SECRET}`); }
    catch { throw new Error('Cannot read Codex secret metadata. Check CODEX_GITHUB_AUTH_PAT expiry, repository access and Secrets: read/write permission.'); }
    if (!credentialsAreFresh(task.created_at, metadata.updated_at)) {
      const hops = Number(process.env.CODEX_REFRESH_HOPS || 0);
      if (!Number.isInteger(hops) || hops < 0 || hops >= 12) throw new Error('Credentials changed while queued repeatedly. Redispatch this task after the queue drains.');
      // Use the separate job token for workflow dispatch; CODEX_GITHUB_AUTH_PAT needs Secrets only.
      const previous = process.env.GH_TOKEN;
      process.env.GH_TOKEN = process.env.CODEX_DISPATCH_TOKEN;
      try { dispatch(repo, task.mode, task.target, task.mode === 'issue' ? '' : task.head_sha, hops + 1, task.new_cycle, task.cycle_request, { source: task.repair_source, review_id: task.review_id, source_run: task.source_run_id, source_attempt: task.source_attempt, source_build: task.deployment?.source_build }); }
      finally { process.env.GH_TOKEN = previous; }
      save(path.join(WORK, 'artifacts/authentication.json'), { persistence: 'not_attempted', reason: 'Redispatched this task because its queued login snapshot was stale.' });
      output('ready', 'false');
      console.log('Auth changed after this run was queued; redispatched this task without using stale credentials.');
      return;
    }
    const raw = process.env.CODEX_CHATGPT_AUTH_JSON;
    if (!raw || Buffer.byteLength(raw) > 48 * 1024) throw new Error('Missing or oversized CODEX_CHATGPT_AUTH_JSON repository secret');
    try { validateAuth(JSON.parse(raw)); }
    catch { throw new Error('Invalid ChatGPT auth secret. Reseed CODEX_CHATGPT_AUTH_JSON using a fresh file-based login.'); }
    mkdirSync(path.dirname(authFile()), { recursive: true, mode: 0o700 });
    writeFileSync(authFile(), raw, { mode: 0o600 });
    chmodSync(authFile(), 0o600);
    save(path.join(WORK, 'artifacts/authentication.json'), { persistence: 'not_attempted' });
    save(path.join(WORK, 'auth-restored.json'), { restored: true, digest: sha256(readFileSync(authFile())) });
    output('ready', 'true');
    output('restored', 'true');
  } else if (action === 'persist') {
    if (!existsSync(path.join(WORK, 'auth-restored.json')) || !existsSync(authFile())) throw new Error('Restored authentication file is missing; credential persistence cannot continue');
    readAuth();
    if (sha256(readFileSync(authFile())) === json(path.join(WORK, 'auth-restored.json')).digest) {
      const status = path.join(WORK, 'artifacts/authentication.json');
      const saved = existsSync(status) && json(status).persistence === 'saved';
      save(status, { persistence: saved ? 'saved' : 'unchanged' });
      console.log('Codex credentials are unchanged; the stored secret is already current.');
      return;
    }
    // stdin avoids putting auth in process arguments. No transcript or error body
    // is printed. This is the exact CODEX_HOME used by the direct CLI executor.
    const raw = readFileSync(authFile());
    try {
      command('gh', ['secret', 'set', AUTH_SECRET, '--repo', repo], {
        input: raw, env: cleanEnvironment({ GH_TOKEN: process.env.GH_TOKEN, GH_REPO: repo }),
      });
    } catch { save(path.join(WORK, 'artifacts/authentication.json'), { persistence: 'failed' }); throw new Error('Could not persist Codex credentials. Check CODEX_GITHUB_AUTH_PAT expiry and repository Secrets: read/write permission. Reseed auth before another run if refresh occurred.'); }
    save(path.join(WORK, 'auth-restored.json'), { restored: true, digest: sha256(raw) });
    save(path.join(WORK, 'artifacts/authentication.json'), { persistence: 'saved' });
    console.log('Persisted the current file-based Codex credentials securely.');
  } else if (action === 'cleanup') {
    rmSync(path.join(WORK, 'credentials'), { recursive: true, force: true });
    rmSync(path.join(WORK, 'session'), { recursive: true, force: true });
  } else throw new Error('Unknown auth action');
}
if (process.argv[1] === import.meta.filename) main().catch(error => { save(path.join(WORK, 'artifacts/error.json'), { message: error.message, category: 'authentication_' + process.argv[2] }); if (process.argv[2] === 'persist') save(path.join(WORK, 'artifacts/authentication.json'), { persistence: 'failed' }); console.error(error.message); process.exitCode = 1; });

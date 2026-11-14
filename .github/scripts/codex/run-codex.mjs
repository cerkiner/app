import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { ROOT, WORK, ARTIFACTS, json, save, command, cleanEnvironment, redactor, redactValue, authValues, validateResult } from './lib.mjs';
import { authFile, readAuth } from './auth.mjs';

export const CODEX_VERSION = '0.169.0';
export function parseResult(text, mode, redact = redactor()) {
  let result;
  try { result = JSON.parse(text); }
  catch { throw new Error('Codex returned invalid JSON; result contents were withheld from logs.'); }
  return validateResult(redactValue(result, redact), mode);
}
export function reviewCoverage(audit, files = []) {
  const normalized = value => (value || '').replace(/^\/workspace\//, '').replace(/^\.\//, '');
  const sameOperation = (a, b) => a.tool === b.tool && (a.tool === 'read_file' ? normalized(a.path) === normalized(b.path) :
    a.tool === 'search' ? a.pattern === b.pattern : a.tool === 'list_files');
  const failures = audit.filter((item, index) => !item.success && !item.optional_instruction &&
    !audit.slice(index + 1).some(later => later.success && sameOperation(item, later)));
  return { reads: audit.filter(item => item.tool === 'read_file' && item.success).length,
    source_read: audit.some(item => item.tool === 'read_file' && item.success && !item.optional_instruction &&
      (!files.length || files.includes(normalized(item.path)))), failed_operations: failures.length };
}
export function enforceReviewCompletion(result, mode, audit, files = []) {
  if (mode !== 'review') return result;
  const coverage = reviewCoverage(audit, files);
  if (!coverage.source_read || coverage.failed_operations) {
    result.review_status = 'incomplete';
    result.unresolved.push(!coverage.source_read ? 'Relevant repository source could not be read through the isolated tools.' : 'A repository tool operation could not be recovered; complete review coverage was not established.');
  }
  return validateResult(result, mode);
}
function toml(value) {
  if (Array.isArray(value)) return `[${value.map(toml).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function containerArgs(name, workspace, review) {
  return ['run', '-d', '--name', name, '--cap-drop=ALL', '--security-opt=no-new-privileges',
    '--pids-limit=256', '--memory=6g', '--cpus=2', '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=1g',
    '--user', `${process.getuid()}:${process.getgid()}`, '--network', review ? 'none' : 'bridge',
    '--mount', `type=bind,source=${workspace},target=/workspace${review ? ',readonly' : ''}`, 'codex-workspace:local'];
}
export function cliArgs(controller, container, mode, model = '') {
  const config = {
    cli_auth_credentials_store: 'file', forced_login_method: 'chatgpt', approval_policy: 'never',
    default_permissions: 'controller',
    permissions: { controller: { filesystem: {
      ':minimal': 'read', [controller]: 'read', [path.join(ROOT, '.github/scripts/codex')]: 'read',
      [path.dirname(authFile())]: 'deny', '/proc': 'deny', '/run/docker.sock': 'deny', '/var/run/docker.sock': 'deny',
    }, network: { enabled: false } } },
    web_search: 'disabled', check_for_update_on_startup: false, 'features.shell_tool': false,
    'features.view_image': false, 'features.shell_snapshot': false, 'features.multi_agent': false,
    'features.multi_agent_v2': false, 'features.hooks': false, 'features.plugins': false,
    'features.apps': false,
    'features.code_mode': { enabled: false, direct_only_tool_namespaces: ['mcp__workspace'] },
    'features.code_mode_only_strict_3p_tools': false, 'features.code_mode_host': false,
    'features.computer_use': false, 'features.browser_use': false, 'features.in_app_browser': false,
    'features.image_generation': false, 'features.skill_mcp_dependency_install': false,
    'features.goals': false,
    'features.skill_search': false, 'features.tool_suggest': false, 'features.workspace_dependencies': false,
    'skills.bundled.enabled': false, 'skills.include_instructions': false,
    'mcp_servers.workspace.command': process.execPath,
    'mcp_servers.workspace.args': [path.join(ROOT, '.github/scripts/codex/sandbox-mcp.mjs'), '--serve', container, mode, path.join(controller, 'tool-audit.jsonl')],
    'mcp_servers.workspace.env_vars': [], 'mcp_servers.workspace.required': true,
    'mcp_servers.workspace.tool_timeout_sec': 190,
    // Codex's auto mode still prompts for unannotated tools. Only these trusted
    // container-bound tools are preapproved; host capabilities remain disabled.
    'mcp_servers.workspace.tools.workspace.approval_mode': 'approve',
    'mcp_servers.workspace.tools.list_files.approval_mode': 'approve',
    'mcp_servers.workspace.tools.read_file.approval_mode': 'approve',
    'mcp_servers.workspace.tools.search.approval_mode': 'approve',
  };
  const args = ['exec', '--strict-config', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check',
    '--cd', controller, '--json', '--color', 'never',
    '--output-schema', path.join(ROOT, '.github/scripts/codex/result.schema.json'),
    '--output-last-message', path.join(controller, 'result.json')];
  for (const [key, value] of Object.entries(config)) args.push('-c', `${key}=${toml(value)}`);
  if (model) {
    if (!/^[a-zA-Z0-9._-]{1,80}$/.test(model)) throw new Error('Invalid Codex model setting');
    args.push('--model', model);
  }
  return [...args, '-'];
}
export function execute(args, prompt, env, timeoutMs = 12 * 60 * 1000) {
  return new Promise(resolve => {
    const child = spawn('codex', args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ } }, 5000).unref();
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout = (stdout + chunk).slice(-2 * 1024 * 1024); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-24000); });
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: 'Codex CLI could not start', timedOut }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.stdin.end(prompt);
  });
}
async function main() {
  const task = json(path.join(WORK, 'task.json'));
  const workspace = path.join(WORK, 'workspace'), controller = path.join(WORK, 'controller');
  const container = `codex-${task.run_id}-${process.env.GITHUB_RUN_ATTEMPT || '1'}`;
  mkdirSync(controller, { recursive: true, mode: 0o700 });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(ARTIFACTS, { recursive: true });
  const original = readAuth();
  let execution;
  try {
    if (command('codex', ['--version']).trim() !== `codex-cli ${CODEX_VERSION}`) throw new Error('Codex version differs from the verified execution policy');
    // Export content only: the container never sees the host's Git metadata.
    const archive = path.join(WORK, 'source.tar');
    command('git', ['archive', '--format=tar', '--output', archive, task.head_sha], { cwd: ROOT });
    command('tar', ['-xf', archive, '--no-same-owner', '-C', workspace]);
    rmSync(archive);
    const empty = path.join(WORK, 'build-context'); mkdirSync(empty, { recursive: true });
    command('docker', ['build', '-q', '-t', 'codex-workspace:local', '-f', path.join(ROOT, '.github/scripts/codex/Dockerfile'), empty], { timeout: 240000 });
    command('docker', containerArgs(container, workspace, task.mode === 'review'));
    const evidence = JSON.stringify(task.context);
    if (evidence.length > 90000) throw new Error('Collected context exceeds the 90000-character limit; human scoping is required');
    const prompt = readFileSync(path.join(ROOT, `.github/prompts/${task.mode}.md`), 'utf8') + '\n' +
      readFileSync(path.join(ROOT, '.github/prompts/execution.md'), 'utf8') + '\nUntrusted task evidence (JSON):\n' +
      evidence;
    execution = await execute(cliArgs(controller, container, task.mode, process.env.CODEX_MODEL || ''), prompt,
      cleanEnvironment({ CODEX_HOME: path.dirname(authFile()), NODE_OPTIONS: '--disable-sigusr1' }));
    const current = existsSync(authFile()) ? readAuth() : {};
    const redact = redactor([...authValues(original), ...authValues(current)]);
    // Keep a restricted event projection; omit prompts, commands, reasoning and
    // command output. Full JSONL is intentionally never stored or uploaded.
    const events = execution.stdout.split('\n').flatMap(line => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'thread.started') return [{ type: event.type, thread_id: event.thread_id }];
        if (event.type === 'turn.completed') return [{ type: event.type, usage: event.usage }];
        if (['turn.failed', 'error'].includes(event.type)) return [{ type: event.type, message: 'Codex reported an execution error; check auth and usage limits.' }];
      } catch { /* not a JSON event */ }
      return [];
    });
    writeFileSync(path.join(ARTIFACTS, 'events.jsonl'), events.map(e => JSON.stringify(redactValue(e, redact))).join('\n'), { mode: 0o600 });
    save(path.join(ARTIFACTS, 'execution.json'), { mode: task.mode, target: task.target, head_sha: task.head_sha,
      run_id: task.run_id, cli_version: CODEX_VERSION, exit_code: execution.code, timed_out: execution.timedOut,
      thread_id: events.find(e => e.type === 'thread.started')?.thread_id || null, session_persisted: false });
    if (execution.code !== 0 || execution.timedOut) throw new Error('Codex failed or timed out. Check subscription login, usage limits and CLI compatibility; no API billing fallback was attempted.');
    const audit = existsSync(path.join(controller, 'tool-audit.jsonl')) ? readFileSync(path.join(controller, 'tool-audit.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const result = enforceReviewCompletion(parseResult(readFileSync(path.join(controller, 'result.json'), 'utf8'), task.mode, redact), task.mode, audit, (task.files || []).map(f => f.filename));
    save(path.join(ARTIFACTS, 'tool-coverage.json'), reviewCoverage(audit, (task.files || []).map(f => f.filename)));
    save(path.join(ARTIFACTS, 'result.json'), result);
    console.log('Codex execution completed; sanitized results are ready for validation.');
  } catch (error) {
    save(path.join(ARTIFACTS, 'error.json'), { message: error.message });
    throw error;
  } finally {
    try { command('docker', ['rm', '-f', container]); } catch { /* may not have started */ }
    rmSync(controller, { recursive: true, force: true });
  }
}
if (process.argv[1] === import.meta.filename) main().catch(error => { console.error(error.message); process.exitCode = 1; });

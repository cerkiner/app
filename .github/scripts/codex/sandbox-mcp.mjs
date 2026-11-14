import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// This is trusted host code. Commands are passed as Docker argv, never evaluated
// by a host shell. Only /workspace is mounted; neither auth nor the Docker socket
// is visible inside the container. No GitHub/OpenAI environment is forwarded.
export function toolDefinitions(review) {
  if (!review) return [{ name: 'workspace', description: 'Run a shell command in /workspace in the isolated, credential-free container. Read AGENTS.md, investigate, edit and test here. Each command has a 170 second limit.',
    inputSchema: { type: 'object', properties: { command: { type: 'string', maxLength: 20000 } }, required: ['command'], additionalProperties: false } }];
  return [
    { name: 'list_files', description: 'List repository files without executing repository code.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: 'read_file', description: 'Read up to 24000 bytes of a repository file, from a 1-based start line.', inputSchema: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer', minimum: 1 } }, required: ['path'], additionalProperties: false } },
    { name: 'search', description: 'Search repository text using ripgrep, without executing code.', inputSchema: { type: 'object', properties: { pattern: { type: 'string', maxLength: 1000 } }, required: ['pattern'], additionalProperties: false } },
  ];
}
export function toolArgv(name, args, review) {
  if (!review && name === 'workspace' && typeof args.command === 'string' && args.command.length <= 20000) {
    return ['timeout', '--signal=TERM', '--kill-after=5s', '170s', 'bash', '-lc', args.command];
  }
  if (review && name === 'list_files') return ['rg', '--files', '--hidden', '-g', '!.git', '-g', '!node_modules'];
  if (review && name === 'read_file') {
    if (typeof args.path !== 'string' || args.path.startsWith('/') || args.path.split('/').some(p => p === '..') || /[\x00-\x1f]/.test(args.path)) throw new Error('Invalid repository path');
    const start = args.start_line ?? 1;
    if (!Number.isSafeInteger(start) || start < 1) throw new Error('Invalid line');
    // resolve() inside the container also rejects symlinks outside /workspace.
    return ['python3', '-c', 'import pathlib,sys; p=pathlib.Path(sys.argv[1]).resolve(); assert p.is_relative_to("/workspace"); f=p.open(); start=int(sys.argv[2]); print("".join(f.readlines()[start-1:start+299])[:24000])', args.path, String(start)];
  }
  if (review && name === 'search' && typeof args.pattern === 'string' && args.pattern.length <= 1000) return ['rg', '-n', '--hidden', '--max-count', '30', '-g', '!.git', '-g', '!node_modules', '--', args.pattern, '.'];
  throw new Error('Tool is not allowed in this mode');
}
export function handle(message, review, run) {
  if (message.id === undefined) return null;
  const response = { jsonrpc: '2.0', id: message.id };
  try {
    if (message.method === 'initialize') response.result = { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'isolated-workspace', version: '1.0.0' } };
    else if (message.method === 'ping') response.result = {};
    else if (message.method === 'tools/list') response.result = { tools: toolDefinitions(review) };
    else if (message.method === 'resources/list') response.result = { resources: [] };
    else if (message.method === 'resources/templates/list') response.result = { resourceTemplates: [] };
    else if (message.method === 'tools/call') {
      const text = run(toolArgv(message.params.name, message.params.arguments || {}, review));
      response.result = { content: [{ type: 'text', text: String(text).slice(-24000) }] };
    } else response.error = { code: -32601, message: 'Unsupported method' };
  } catch {
    response.result = { isError: true, content: [{ type: 'text', text: 'Workspace operation failed or exceeded its limits.' }] };
  }
  return response;
}
if (process.argv[2] === '--serve') {
  const container = process.argv[3];
  if (!/^codex-[a-z0-9-]+$/.test(container)) throw new Error('Invalid container identifier');
  const review = process.argv[4] === 'review';
  const run = args => {
    const result = spawnSync('docker', ['exec', '-w', '/workspace', container, ...args], {
      encoding: 'utf8', timeout: 180000, maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    return `exit=${result.status ?? 'timeout'}\n${(result.stdout || '').slice(-18000)}\n${(result.stderr || '').slice(-6000)}`;
  };
  for await (const line of createInterface({ input: process.stdin })) {
    if (line.length > 100000) continue;
    try {
      const request = JSON.parse(line), response = handle(request, review, run);
      if (request.method === 'tools/call' && process.argv[5]) {
        const content = response?.result?.content?.[0]?.text || '';
        const success = !response?.result?.isError && !response?.error && (!/^exit=(?!0(?:\n|$))/.test(content) || (request.params?.name === 'search' && /^exit=1(?:\n|$)/.test(content)));
        appendFileSync(process.argv[5], JSON.stringify({ tool: request.params?.name, path: request.params?.arguments?.path, success, optional_instruction: /(?:^|\/)AGENTS\.md$/.test(request.params?.arguments?.path || '') }) + '\n');
      }
      if (response) process.stdout.write(JSON.stringify(response) + '\n');
    } catch { /* malformed transport input has no authority */ }
  }
}

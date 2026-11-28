import { readFileSync } from 'node:fs';
import { gh, pages, repository, integer, output, sha } from './lib.mjs';

export function documentationPath(file) {
  return typeof file === 'string' && !/^src\//.test(file) &&
    !/(?:^|\/)AGENTS\.md$/i.test(file) && (/\.md$/i.test(file) || /^(?:docs\/|LICENSE$)/.test(file));
}
export function documentationOnly(files, total) {
  return files.length > 0 && files.length === total && files.every(file =>
    documentationPath(file.filename) && (!file.previous_filename || documentationPath(file.previous_filename)));
}
if (process.argv[1] === import.meta.filename) {
  const payload = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const repo = repository(process.env.GITHUB_REPOSITORY);
  const number = integer(payload.pull_request?.number || process.env.PR_NUMBER);
  const pr = gh(`repos/${repo}/pulls/${number}`);
  if (pr.head.sha !== sha(process.env.EXPECTED_SHA)) throw new Error('The PR revision changed before validation');
  if (!payload.pull_request && process.env.GITHUB_SHA !== pr.head.sha) throw new Error('Manual validation must run on the exact PR branch revision');
  const files = pages(`repos/${repo}/pulls/${number}/files?per_page=100`);
  output('documentation_only', String(documentationOnly(files, pr.changed_files)));
}

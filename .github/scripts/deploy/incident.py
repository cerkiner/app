"""Report production publication failures independently of pull-request repair."""
import json
import os
from pathlib import Path
import re
import subprocess

STATUS = 'Deployment failed; latest changes are not confirmed live.'
WORKFLOWS = {'CI': ('CI.yml', 'push'),
             'Deploy Hostinger manually': ('deploy-hostinger.yml', 'workflow_dispatch')}
FAILURES = {'failure', 'timed_out', 'cancelled', 'startup_failure'}


def api(path, method='GET', payload=None):
    args = ['gh', 'api', '--method', method, path]
    if payload is not None:
        args += ['--input', '-']
    return json.loads(subprocess.check_output(
        args, input=json.dumps(payload).encode() if payload is not None else None))


def pages(path, key=None):
    result = []
    for page in range(1, 1001):
        data = api(f'{path}{"&" if "?" in path else "?"}per_page=100&page={page}')
        entries = data[key] if key else data
        result.extend(entries)
        if len(entries) < 100:
            return result
    raise RuntimeError('Pagination limit reached; incident report requires complete results')


def publication_failures(run, jobs, repo, branch):
    workflow = WORKFLOWS.get(run.get('name'))
    if (not workflow or run.get('path') != '.github/workflows/' + workflow[0]
            or run.get('event') != workflow[1] or run.get('status') != 'completed'
            or run.get('conclusion') not in FAILURES or run.get('head_branch') != branch
            or run.get('repository', {}).get('full_name') != repo
            or run.get('head_repository', {}).get('full_name') != repo
            or not re.fullmatch(r'[0-9a-f]{40}', run.get('head_sha', ''))):
        return []
    return [job for job in jobs if job.get('name', '').split(' / ')[-1] == 'Production deployment'
            and job.get('conclusion') in FAILURES]


def report(repo, branch, run, failed):
    run_id = int(run['id'])
    attempt = int(run['run_attempt'])
    marker = f'<!-- deployment-incident:{run_id} -->'
    run_url = f'https://github.com/{repo}/actions/runs/{run_id}/attempts/{attempt}'
    manual = f'https://github.com/{repo}/actions/workflows/deploy-hostinger.yml'
    steps = '\n'.join(f'- {job["html_url"]}' for job in failed)
    source = (f'Use CI run ID `{run_id}` as the source build.' if run['name'] == 'CI' else
              'Use the source CI run ID from the failed manual run inputs; its workflow commit may differ from the artifact commit.')
    body = f"""{marker}
**{STATUS}**

The publication job did not finish successfully. Files may be partially updated;
a successful build or merge does not confirm a successful deployment.

- Workflow: {run['name']}
- Workflow commit: `{run['head_sha']}`
- Branch: `{branch}`
- Failed run, attempt {attempt}: {run_url}

Failed publication jobs:
{steps}

Recovery:
1. Inspect the failed job and distinguish credentials/hosting/network problems from code errors. Fix external configuration directly; use a recovery PR for code changes. Do not push repairs directly to the protected branch.
2. Retry the retained build from [Deploy Hostinger manually]({manual}) with `check_only` disabled. {source} For a rollback, select an earlier validated CI run whose artifact remains available.
3. Confirm that upload and public-file verification both succeed. Record the successful run here before closing this incident. A connection check or successful CI validation alone does not resolve it.

Later retries update this issue rather than creating duplicates. Secrets and raw deployment logs are intentionally excluded.
"""
    existing = next((issue for issue in pages(f'repos/{repo}/issues?state=all')
                     if 'pull_request' not in issue and marker in (issue.get('body') or '')), None)
    payload = {'title': f'Deployment failed: changes not confirmed live (run {run_id})', 'body': body}
    if existing:
        issue = api(f'repos/{repo}/issues/{existing["number"]}', 'PATCH', payload | {'state': 'open'})
    else:
        issue = api(f'repos/{repo}/issues', 'POST', payload)
    return issue['html_url']


def main():
    repo = os.environ['GITHUB_REPOSITORY']
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    if os.environ.get('GITHUB_EVENT_NAME') != 'workflow_run' or event.get('action') != 'completed':
        raise ValueError('Expected completed workflow event')
    if event['repository']['full_name'] != repo:
        raise ValueError('Repository mismatch')
    run = api(f'repos/{repo}/actions/runs/{int(event["workflow_run"]["id"])}')
    jobs = pages(f'repos/{repo}/actions/runs/{int(run["id"])}/attempts/{int(run["run_attempt"])}/jobs', 'jobs')
    failed = publication_failures(run, jobs, repo, event['repository']['default_branch'])
    if not failed:
        print('No failed production publication; no incident needed')
        return
    print(f'::error::{STATUS}')
    # Write the status before the API mutation so reporting failures remain visible.
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(f'**{STATUS}**\n\n')
    issue_url = report(repo, event['repository']['default_branch'], run, failed)
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(f'[Deployment incident]({issue_url})\n')
    print(f'Incident: {issue_url}')


if __name__ == '__main__':
    main()

"""Report production publication failures independently of pull-request repair."""
import json
import os
from pathlib import Path
import re
import subprocess

STATUS = 'Deployment failed; latest changes are not confirmed live.'
WORKFLOWS = {'App release': ('CI.yml', 'push'), 'CI': ('CI.yml', 'push'),
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


def publication_failures(run, jobs, repo, branch, allow_active=False):
    workflow = next((value for value in WORKFLOWS.values() if run.get('path') == '.github/workflows/' + value[0]), None)
    active = allow_active and run.get('status') == 'in_progress'
    if (not workflow or run.get('path') != '.github/workflows/' + workflow[0]
            or run.get('event') != workflow[1]
            or (not active and (run.get('status') != 'completed' or run.get('conclusion') not in FAILURES))
            or run.get('head_branch') != branch
            or run.get('repository', {}).get('full_name') != repo
            or run.get('head_repository', {}).get('full_name') != repo
            or not re.fullmatch(r'[0-9a-f]{40}', run.get('head_sha', ''))):
        return []
    return [job for job in jobs if (job.get('name', '').split(' / ')[-1] == 'Production deployment'
            or (job.get('name', '').split(' / ')[-1] == 'publish'
                and run.get('path') == '.github/workflows/CI.yml' and run.get('event') == 'push'))
            and job.get('conclusion') in FAILURES
            and any(step.get('name') in ('Check connection or publish retained build', 'Publish retained build')
                    and step.get('conclusion') in FAILURES for step in job.get('steps', []))]


def report(repo, branch, run, failed, build=None):
    run_id = int(run['id'])
    attempt = int(run['run_attempt'])
    marker = f'<!-- deployment-incident:{run_id} -->'
    run_url = f'https://github.com/{repo}/actions/runs/{run_id}/attempts/{attempt}'
    manual = f'https://github.com/{repo}/actions/workflows/deploy-hostinger.yml'
    steps = '\n'.join(f'- {job["html_url"]}' for job in failed)
    source = (f'Use CI run ID `{run_id}` as the source build.' if run['path'] == '.github/workflows/CI.yml' else
              'Use the source CI run ID from the failed manual run inputs; its workflow commit may differ from the artifact commit.')
    body = f"""{marker}
**{STATUS}**

The publication job did not finish successfully. Files may be partially updated;
a successful build or merge does not confirm a successful deployment.

- Workflow: {run['name']}
- Workflow commit: `{run['head_sha']}`
- Source artifact commit: `{(build or run)['head_sha']}`
- Source build run: `{(build or run)['id']}`
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
                     if 'pull_request' not in issue and issue.get('user', {}).get('login') == 'github-actions[bot]'
                     and issue.get('user', {}).get('type') == 'Bot'
                     and marker in (issue.get('body') or '')), None)
    previous = re.findall(r'https://github\.com/[^\s)]+/actions/runs/\d+/attempts/\d+', (existing or {}).get('body', ''))
    history = list(dict.fromkeys(previous + [run_url]))[-20:]
    body += '\n\nAttempt history:\n' + '\n'.join('- ' + url for url in history)
    payload = {'title': f'Deployment failed: changes not confirmed live (run {run_id})', 'body': body}
    if existing:
        issue = api(f'repos/{repo}/issues/{existing["number"]}', 'PATCH', payload | {'state': 'open'})
    else:
        issue = api(f'repos/{repo}/issues', 'POST', payload)
    return issue['html_url']


def main():
    repo = os.environ['GITHUB_REPOSITORY']
    event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
    if event['repository']['full_name'] != repo:
        raise ValueError('Repository mismatch')
    run_id = os.environ.get('INCIDENT_RUN_ID', '')
    attempt = os.environ.get('INCIDENT_RUN_ATTEMPT', '')
    build_id = os.environ.get('INCIDENT_BUILD_RUN_ID', '')
    if not all(value.isdigit() and int(value) > 0 for value in (run_id, attempt, build_id)):
        raise ValueError('Source run, attempt and validated build IDs are required')
    output = os.environ.get('GITHUB_OUTPUT')
    def emit(value):
        if output:
            with open(output, 'a') as stream:
                stream.write(value + '\n')
    emit('proceed=false')
    # Read the requested attempt, not the latest attempt of a rerun.
    run = api(f'repos/{repo}/actions/runs/{run_id}/attempts/{attempt}')
    if run.get('id') != int(run_id) or run.get('run_attempt') != int(attempt):
        raise ValueError('Source attempt provenance changed')
    jobs = pages(f'repos/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs', 'jobs')
    active = run_id == os.environ.get('GITHUB_RUN_ID') and attempt == os.environ.get('GITHUB_RUN_ATTEMPT')
    failed = publication_failures(run, jobs, repo, event['repository']['default_branch'], active)
    if not failed:
        print('No attempted production publication failure; no investigation needed')
        return
    definition = api(f"repos/{repo}/actions/workflows/{run['path'].split('/')[-1]}")
    if run.get('workflow_id') != definition.get('id') or run['path'] != definition.get('path'):
        raise ValueError('Publication workflow identity changed')
    build = api(f'repos/{repo}/actions/runs/{build_id}')
    build_definition = definition if run['path'] == '.github/workflows/CI.yml' else api(f'repos/{repo}/actions/workflows/CI.yml')
    if (build.get('path') != '.github/workflows/CI.yml' or build.get('event') != 'push'
            or build.get('workflow_id') != build_definition.get('id') or build.get('head_branch') != 'master'
            or build.get('repository', {}).get('full_name') != repo
            or build.get('head_repository', {}).get('full_name') != repo
            or not re.fullmatch(r'[0-9a-f]{40}', build.get('head_sha', ''))
            or (run.get('event') == 'push' and build_id != run_id)):
        raise ValueError('Source artifact provenance cannot be established')
    validation = pages(f"repos/{repo}/actions/runs/{build_id}/attempts/{build['run_attempt']}/jobs", 'jobs')
    if len([job for job in validation if job.get('name') == 'Validate app' and job.get('conclusion') == 'success']) != 1:
        raise ValueError('Source build was not validated')
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(f'**{STATUS}**\n\n')
    issue_url = report(repo, event['repository']['default_branch'], run, failed, build)
    context = dict(repo=repo, run_id=int(run_id), attempt=int(attempt), source_build=int(build_id),
                   issue_number=int(issue_url.rstrip('/').split('/')[-1]), source_sha=build['head_sha'],
                   workflow_sha=run['head_sha'], url=run['html_url'],
                   failed_jobs=[dict(name=job['name'], url=job.get('html_url'),
                                    failed_steps=[step['name'] for step in job.get('steps', []) if step.get('conclusion') in FAILURES]) for job in failed])
    work = Path(os.environ.get('CODEX_WORK', str(Path(os.environ.get('RUNNER_TEMP', '/tmp')) / 'repository-tasks')))
    work.mkdir(parents=True, exist_ok=True)
    (work / 'deployment-context.json').write_text(json.dumps(context))
    with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as summary:
        summary.write(f'[Deployment incident]({issue_url})\n')
    emit('proceed=true')


if __name__ == '__main__':
    main()

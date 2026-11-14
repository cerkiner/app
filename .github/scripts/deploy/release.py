"""Resolve only validated, repository-owned master build artifacts."""
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tempfile
import zipfile


def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', path]))


def eligible(run, workflow_id, repo):
    return (run['workflow_id'] == workflow_id and run['event'] == 'push'
            and run['head_branch'] == 'master'
            and run['head_repository']['full_name'] == repo
            and re.fullmatch(r'[0-9a-f]{40}', run['head_sha']) is not None)


def extract(archive, destination):
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if sum(x.file_size for x in entries) > 250 * 1024 * 1024:
            raise ValueError('Build artifact exceeds size limit')
        for entry in entries:
            path = PurePosixPath(entry.filename)
            if (path.is_absolute() or '..' in path.parts or '\\' in entry.filename
                    or stat.S_ISLNK(entry.external_attr >> 16)):
                raise ValueError('Unsafe artifact path')
        bundle.extractall(destination)


def main():
    run_id = os.environ['RELEASE_RUN_ID']
    if not run_id.isdigit():
        raise ValueError('A numeric CI run ID is required')
    repo = os.environ['GITHUB_REPOSITORY']
    base = f'repos/{repo}'
    run = api(f'{base}/actions/runs/{run_id}')
    workflow = api(f'{base}/actions/workflows/CI.yml')
    if not eligible(run, workflow['id'], repo):
        raise ValueError('Only CI push builds from this repository master are accepted')
    automatic = os.environ.get('RELEASE_AUTOMATIC') == 'true'
    if automatic:
        if run_id != os.environ['GITHUB_RUN_ID']:
            raise ValueError('Automatic release must use its own CI run')
        head = api(f'{base}/git/ref/heads/master')['object']['sha']
        if head != run['head_sha']:
            with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
                output.write('skip=true\n')
            print('Skipping superseded production build')
            return
    elif run['status'] != 'completed' or run['conclusion'] not in ('success', 'failure'):
        raise ValueError('Manual release requires a completed CI run')
    pages = json.loads(subprocess.check_output([
        'gh', 'api', '--paginate', '--slurp',
        f"{base}/actions/runs/{run_id}/attempts/{run['run_attempt']}/jobs?per_page=100"]))
    validation = [job for page in pages for job in page['jobs'] if job['name'] == 'Validate app']
    if len(validation) != 1 or validation[0]['conclusion'] != 'success':
        raise ValueError('All app validation must have succeeded')
    name = 'production-' + run['head_sha']
    pages = json.loads(subprocess.check_output([
        'gh', 'api', '--paginate', '--slurp', f'{base}/actions/runs/{run_id}/artifacts?per_page=100']))
    artifacts = [a for page in pages for a in page['artifacts'] if a['name'] == name and not a['expired']]
    if len(artifacts) != 1:
        raise ValueError('Expected one unexpired production artifact')
    with tempfile.TemporaryFile() as archive:
        subprocess.run(['gh', 'api', f"{base}/actions/artifacts/{artifacts[0]['id']}/zip"],
                       stdout=archive, check=True)
        archive.seek(0)
        extract(archive, Path('release-app'))
    with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
        output.write(f"sha={run['head_sha']}\nskip=false\n")


if __name__ == '__main__':
    main()

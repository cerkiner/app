"""Folder-restricted FTP publishing; preserve remote assets and configuration."""
import ftplib
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import sys
import time
import urllib.request
from urllib.parse import urlsplit
import uuid

PUBLIC_URL = 'https://sam.erkiner.com/app/'
class DeploymentError(ValueError):
    """A fixed, credential-free diagnostic safe to show in workflow logs."""


MARKERS = {'wp-admin', 'wp-content', 'wp-includes', 'wp-config.php'}


def config(env):
    values = [env.get('HOSTINGER_FTP_' + key, '') for key in ('HOST', 'USERNAME', 'PASSWORD')]
    if not all(values) or any('\n' in x or '\r' in x for x in values):
        raise DeploymentError('Missing or invalid FTP credentials')
    host = urlsplit(values[0].strip() if '://' in values[0] else '//' + values[0].strip())
    if (host.scheme not in ('', 'ftp') or not host.hostname
            or host.username is not None or host.password is not None
            or host.path not in ('', '/') or host.query or host.fragment):
        raise DeploymentError('FTP host must be a hostname or FTP URL without credentials or a folder path')
    try:
        port = int(env.get('HOSTINGER_FTP_PORT') or host.port or 21)
    except ValueError:
        raise DeploymentError('FTP port must be a number') from None
    values[0] = host.hostname
    if not 1 <= port <= 65535:
        raise DeploymentError('Invalid FTP port')
    return (*values, port)


def connect(settings):
    host, username, password, port = settings
    ftp = ftplib.FTP(timeout=30)
    try:
        ftp.connect(host, port)
        ftp.login(username, password)
        ftp.cwd('/')
        return ftp
    except Exception:
        ftp.close()
        raise


def preflight(ftp):
    if ftp.pwd() != '/':
        raise DeploymentError('Account must be rooted at the app directory')
    names = {PurePosixPath(x.rstrip('/')).name for x in ftp.nlst()}
    if names & MARKERS or 'index.html' not in names:
        raise DeploymentError('Root does not look like the existing isolated app folder')
    content = io.BytesIO()
    ftp.retrbinary('RETR index.html', content.write)
    html = content.getvalue()
    if b'https://sam.erkiner.com/app/' not in html or b'<app-root' not in html:
        raise DeploymentError('Existing app identity does not match deployment target')
    ftp.cwd('..')
    if ftp.pwd() != '/':
        raise DeploymentError('Account can escape the app folder')
    for directory in ('/wp-admin', '/../wp-admin', '/public_html', '/domains'):
        try:
            ftp.cwd(directory)
        except ftplib.error_perm:
            continue
        raise DeploymentError('Account exposes directories outside the app')
    ftp.cwd('/')


def files(root):
    result = []
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise DeploymentError('Symlinks are not deployable')
        if path.is_dir():
            continue
        relative = path.relative_to(root).as_posix()
        if any(part.startswith('.') or part in MARKERS for part in Path(relative).parts):
            raise DeploymentError('Server configuration is not deployable')
        if not re.fullmatch(r'[A-Za-z0-9_./@+-]+', relative):
            raise DeploymentError('Unsafe build filename')
        result.append(relative)
    if not {'index.html', 'ngsw.json'} <= set(result):
        raise DeploymentError('Missing production entry files')
    html = (root / 'index.html').read_text()
    if '<base href="/app/">' not in html or PUBLIC_URL not in html:
        raise DeploymentError('Production base URL or canonical URL is incorrect')
    manifest = json.loads((root / 'ngsw.json').read_text())
    for url, digest in manifest['hashTable'].items():
        relative = manifest_path(url)
        if relative not in result or hashlib.sha1((root / relative).read_bytes()).hexdigest() != digest:
            raise DeploymentError('Service worker hashes do not match build')
    return [x for x in result if x not in ('index.html', 'ngsw.json')] + ['index.html', 'ngsw.json']


def manifest_path(url):
    if not url.startswith('/app/') or '..' in PurePosixPath(url).parts:
        raise DeploymentError('Unexpected service-worker resource path')
    return url[len('/app/'):]


def upload(ftp, root, relative):
    parent = PurePosixPath(relative).parent
    ftp.cwd('/')
    for part in parent.parts:
        try:
            ftp.cwd(part)
        except ftplib.error_perm:
            ftp.mkd(part)
            ftp.cwd(part)
    name = PurePosixPath(relative).name
    temporary = '.deploy-' + uuid.uuid4().hex
    with (root / relative).open('rb') as source:
        ftp.storbinary('STOR ' + temporary, source)
    ftp.rename(temporary, name)  # No delete: fail if server cannot replace by rename.
    ftp.cwd('/')


def publish(settings, root, paths, factory=connect, pause=time.sleep):
    ftp = None
    try:
        for relative in paths:
            for attempt in range(3):
                try:
                    if ftp is None:
                        ftp = factory(settings)
                        preflight(ftp)
                    upload(ftp, root, relative)
                    break
                except (OSError, EOFError, ftplib.error_temp):
                    if ftp:
                        ftp.close()
                    ftp = None
                    if attempt == 2:
                        raise
                    pause(2 ** attempt)
    finally:
        if ftp:
            ftp.close()


def fetch(relative):
    request = urllib.request.Request(PUBLIC_URL + relative + '?deployment=' + uuid.uuid4().hex,
                                     headers={'Cache-Control': 'no-cache', 'Accept-Encoding': 'identity'})
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.geturl().split('?')[0] != PUBLIC_URL + relative:
            raise DeploymentError('Unexpected public resource redirect')
        return response.read()


def verify(root, pause=time.sleep):
    manifest = json.loads((root / 'ngsw.json').read_text())
    expected = {manifest_path(url) for url in manifest['hashTable']}
    expected.update(('index.html', 'ngsw.json', 'manifest.json'))
    for attempt in range(3):
        try:
            for relative in sorted(expected):
                if fetch(relative) != (root / relative).read_bytes():
                    raise DeploymentError('Public resource differs from deployed build')
            return
        except (OSError, ValueError):
            if attempt == 2:
                raise
            pause(2 ** attempt)


def main():
    print('Checking FTP settings and production artifact', flush=True)
    settings = config(os.environ)
    root = Path('release-app')
    paths = files(root)
    check_only = os.environ.get('RELEASE_CHECK_ONLY') == 'true'
    print('Checking FTP connection and isolated app folder', flush=True)
    ftp = connect(settings)
    try:
        preflight(ftp)
    finally:
        ftp.close()
    if check_only:
        print('FTP connection and app folder checks passed; no files uploaded. Confirm folder restriction in hPanel.')
        return
    print('Uploading validated build', flush=True)
    publish(settings, root, paths)
    print('Verifying public resources', flush=True)
    verify(root)
    print('Production build published and verified')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Server replies and URLs can contain credentials. Never print raw exceptions.
        detail = str(error) if isinstance(error, DeploymentError) else type(error).__name__
        print(f'Deployment failed: {detail}', file=sys.stderr)
        sys.exit(1)

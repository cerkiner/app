import ftplib
import io
import json
import os
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

import ftps
import release


class SafetyTests(unittest.TestCase):
    def test_credentials_required_and_host_is_not_url(self):
        for env in ({}, {'HOSTINGER_FTP_HOST': 'ftp://example.org',
                        'HOSTINGER_FTP_USERNAME': 'user', 'HOSTINGER_FTP_PASSWORD': 'secret'}):
            with self.assertRaises(ValueError):
                ftps.config(env)

    def test_secret_port_is_used_and_defaults_to_21(self):
        env = {'HOSTINGER_FTP_HOST': 'example.org', 'HOSTINGER_FTP_USERNAME': 'user',
               'HOSTINGER_FTP_PASSWORD': 'password', 'HOSTINGER_FTP_PORT': '2121'}
        self.assertEqual(ftps.config(env)[3], 2121)
        del env['HOSTINGER_FTP_PORT']
        self.assertEqual(ftps.config(env)[3], 21)

    def test_tls_precedes_login_and_protects_data(self):
        with patch.object(ftps.ftplib, 'FTP_TLS') as constructor:
            ftp = constructor.return_value
            ftps.connect(('example.org', 'user', 'password', 21))
            context = constructor.call_args.kwargs['context']
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
            self.assertEqual([c[0] for c in ftp.method_calls],
                             ['connect', 'auth', 'login', 'prot_p', 'cwd'])

    def test_tls_failure_never_sends_password(self):
        for failure in (ssl.SSLCertVerificationError(), ftplib.error_perm('TLS unavailable')):
            with patch.object(ftps.ftplib, 'FTP_TLS') as constructor:
                ftp = constructor.return_value
                ftp.auth.side_effect = failure
                with self.assertRaises(type(failure)):
                    ftps.connect(('example.org', 'user', 'password', 21))
                ftp.login.assert_not_called()
                ftp.close.assert_called_once()

    def test_parent_escape_is_rejected(self):
        ftp = Mock()
        ftp.pwd.side_effect = ['/', '/parent']
        ftp.nlst.return_value = ['index.html']
        ftp.retrbinary.side_effect = lambda command, sink: sink(b'<app-root https://sam.erkiner.com/app/')
        with self.assertRaises(ValueError):
            ftps.preflight(ftp)

    def test_wordpress_root_is_rejected(self):
        ftp = Mock()
        ftp.pwd.return_value = '/'
        ftp.nlst.return_value = ['index.html', 'wp-content']
        with self.assertRaises(ValueError):
            ftps.preflight(ftp)

    def test_entries_are_last_and_configuration_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'index.html').write_text('<base href="/app/">' + ftps.PUBLIC_URL)
            (root / 'ngsw.json').write_text(json.dumps({'hashTable': {}}))
            (root / 'main.123.js').write_text('app')
            self.assertEqual(ftps.files(root), ['main.123.js', 'index.html', 'ngsw.json'])
            (root / '.htaccess').write_text('server config')
            with self.assertRaises(ValueError):
                ftps.files(root)

    def test_interrupted_transfer_reconnects_before_entry_publication(self):
        ftp = Mock()
        factory = Mock(return_value=ftp)
        with patch.object(ftps, 'preflight'), patch.object(ftps, 'upload') as upload:
            upload.side_effect = [OSError('interrupted'), None, None, None]
            ftps.publish((), Path('.'), ['asset.js', 'index.html', 'ngsw.json'], factory, Mock())
            self.assertEqual([c.args[2] for c in upload.call_args_list],
                             ['asset.js', 'asset.js', 'index.html', 'ngsw.json'])
            self.assertEqual(factory.call_count, 2)

    def test_failure_is_bounded_and_stops_entry_upload(self):
        with patch.object(ftps, 'preflight'), patch.object(ftps, 'upload', side_effect=OSError) as upload:
            with self.assertRaises(OSError):
                ftps.publish((), Path('.'), ['asset.js', 'index.html'], Mock(return_value=Mock()), Mock())
            self.assertEqual(upload.call_count, 3)
            self.assertTrue(all(c.args[2] == 'asset.js' for c in upload.call_args_list))

    def test_temporary_file_is_renamed_only_after_complete_transfer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'index.html').write_text('app')
            ftp = Mock()
            ftps.upload(ftp, root, 'index.html')
            self.assertTrue(ftp.storbinary.call_args.args[0].startswith('STOR .deploy-'))
            self.assertEqual(ftp.rename.call_args.args[1], 'index.html')
            ftp.storbinary.side_effect = OSError()
            ftp.rename.reset_mock()
            with self.assertRaises(OSError):
                ftps.upload(ftp, root, 'index.html')
            ftp.rename.assert_not_called()

    def test_public_content_mismatch_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'ngsw.json').write_text('{"hashTable": {}}')
            (root / 'index.html').write_text('expected')
            (root / 'manifest.json').write_text('{}')
            with patch.object(ftps, 'fetch', return_value=b'wrong'):
                with self.assertRaises(ValueError):
                    ftps.verify(root, Mock())

    def test_only_repository_master_push_builds_are_eligible(self):
        run = dict(workflow_id=1, event='push', head_branch='master',
                   head_repository={'full_name': 'owner/app'}, head_sha='a' * 40)
        self.assertTrue(release.eligible(run, 1, 'owner/app'))
        for change in ({'event': 'pull_request'}, {'head_branch': 'feature'}, {'workflow_id': 2},
                       {'head_repository': {'full_name': 'fork/app'}}):
            self.assertFalse(release.eligible(run | change, 1, 'owner/app'))

    def test_failed_validation_never_downloads(self):
        run = dict(workflow_id=1, event='push', head_branch='master',
                   head_repository={'full_name': 'owner/app'}, head_sha='a' * 40,
                   status='completed', conclusion='failure', run_attempt=1)
        env = {'RELEASE_RUN_ID': '123', 'GITHUB_REPOSITORY': 'owner/app'}
        with patch.dict(os.environ, env, clear=True), patch.object(release, 'api', side_effect=[run, {'id': 1}]), patch.object(release.subprocess, 'check_output', return_value=b'[{"jobs":[{"name":"Validate app","conclusion":"failure"}]}]'), patch.object(release.subprocess, 'run') as download:
            with self.assertRaises(ValueError):
                release.main()
            download.assert_not_called()

    def test_superseded_automatic_release_is_skipped(self):
        run = dict(workflow_id=1, event='push', head_branch='master',
                   head_repository={'full_name': 'owner/app'}, head_sha='a' * 40)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'output'
            env = {'RELEASE_RUN_ID': '123', 'GITHUB_RUN_ID': '123',
                   'GITHUB_REPOSITORY': 'owner/app', 'RELEASE_AUTOMATIC': 'true',
                   'GITHUB_OUTPUT': str(output)}
            with patch.dict(os.environ, env, clear=True), patch.object(release, 'api', side_effect=[run, {'id': 1}, {'object': {'sha': 'b' * 40}}]), patch.object(release.subprocess, 'run') as download:
                release.main()
                self.assertEqual(output.read_text(), 'skip=true\n')
                download.assert_not_called()

    def test_artifact_cannot_escape_destination(self):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr('../escape', 'bad')
        archive.seek(0)
        with tempfile.TemporaryDirectory() as directory, self.assertRaises(ValueError):
            release.extract(archive, directory)


if __name__ == '__main__':
    unittest.main()

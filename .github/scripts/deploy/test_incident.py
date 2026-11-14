import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import incident


class IncidentTests(unittest.TestCase):
    def setUp(self):
        self.run = dict(id=123, run_attempt=1, name='CI', path='.github/workflows/CI.yml',
                        event='push', status='completed', conclusion='failure', head_branch='master',
                        head_sha='a' * 40, repository={'full_name': 'owner/app'},
                        head_repository={'full_name': 'owner/app'})
        self.job = dict(name='deploy / Production deployment', conclusion='failure',
                        html_url='https://github.com/owner/app/actions/runs/123/job/456')

    def test_merged_release_failure_needs_no_open_pull_request(self):
        self.assertEqual(incident.publication_failures(self.run, [self.job], 'owner/app', 'master'), [self.job])
        with patch.object(incident, 'pages', return_value=[]), patch.object(incident, 'api', return_value={'html_url': 'https://github.com/owner/app/issues/9'}) as api:
            url = incident.report('owner/app', 'master', self.run, [self.job])
        self.assertTrue(url.endswith('/9'))
        path, method, payload = api.call_args.args
        self.assertEqual((path, method), ('repos/owner/app/issues', 'POST'))
        for expected in (incident.STATUS, 'a' * 40, '/runs/123/attempts/1', '/job/456', 'CI run ID `123`', 'recovery PR', 'public-file verification'):
            self.assertIn(expected, payload['body'])

    def test_validation_failure_without_publication_does_not_open_incident(self):
        self.assertEqual(incident.publication_failures(self.run, [dict(name='Validate app', conclusion='failure')], 'owner/app', 'master'), [])
        self.assertEqual(incident.publication_failures(self.run, [self.job | {'conclusion': 'skipped'}], 'owner/app', 'master'), [])

    def test_manual_production_failure_is_reported_but_connection_check_is_not(self):
        run = self.run | dict(name='Deploy Hostinger manually', path='.github/workflows/deploy-hostinger.yml', event='workflow_dispatch')
        job = self.job | {'name': 'release / Production deployment'}
        self.assertEqual(incident.publication_failures(run, [job], 'owner/app', 'master'), [job])
        self.assertEqual(incident.publication_failures(run, [job | {'name': 'release / Connection check'}], 'owner/app', 'master'), [])
        with patch.object(incident, 'pages', return_value=[]), patch.object(incident, 'api', return_value={'html_url': 'issue'}) as api:
            incident.report('owner/app', 'master', run, [job])
            self.assertIn('source CI run ID from the failed manual run inputs', api.call_args.args[2]['body'])

    def test_timeout_or_cancelled_publication_is_unconfirmed(self):
        for outcome in ('timed_out', 'cancelled', 'startup_failure'):
            self.assertTrue(incident.publication_failures(self.run | {'conclusion': outcome}, [self.job | {'conclusion': outcome}], 'owner/app', 'master'))

    def test_untrusted_or_irrelevant_runs_are_rejected(self):
        for changed in ({'event': 'pull_request'}, {'head_branch': 'feature'}, {'conclusion': 'success'},
                        {'repository': {'full_name': 'fork/app'}}, {'head_repository': {'full_name': 'fork/app'}},
                        {'path': '.github/workflows/other.yml'}, {'head_sha': 'bad'}, {'status': 'in_progress'}):
            self.assertEqual(incident.publication_failures(self.run | changed, [self.job], 'owner/app', 'master'), [])

    def test_duplicate_attempt_updates_and_reopens_existing_issue(self):
        issues = [{'number': 9, 'state': 'closed', 'body': '<!-- deployment-incident:123 --> old'}]
        with patch.object(incident, 'pages', return_value=issues), patch.object(incident, 'api', return_value={'html_url': 'issue'}) as api:
            incident.report('owner/app', 'master', self.run | {'run_attempt': 2}, [self.job])
        path, method, payload = api.call_args.args
        self.assertEqual((path, method, payload['state']), ('repos/owner/app/issues/9', 'PATCH', 'open'))
        self.assertIn('attempts/2', payload['body'])

    def test_issue_lookup_is_paginated(self):
        with patch.object(incident, 'api', side_effect=[[{'number': n} for n in range(100)], [{'number': 101}]]) as api:
            self.assertEqual(len(incident.pages('repos/owner/app/issues?state=all')), 101)
            self.assertIn('page=2', api.call_args.args[0])

    def test_summary_survives_issue_api_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            event = Path(directory) / 'event.json'
            event.write_text(json.dumps({'action': 'completed', 'repository': {'full_name': 'owner/app', 'default_branch': 'master'}, 'workflow_run': {'id': 123}}))
            summary = Path(directory) / 'summary'
            env = dict(GITHUB_EVENT_NAME='workflow_run', GITHUB_EVENT_PATH=str(event), GITHUB_STEP_SUMMARY=str(summary), GITHUB_REPOSITORY='owner/app')
            with patch.dict(os.environ, env), patch.object(incident, 'api', return_value=self.run), patch.object(incident, 'pages', return_value=[self.job]), patch.object(incident, 'report', side_effect=RuntimeError('API unavailable')), patch('builtins.print'):
                with self.assertRaises(RuntimeError):
                    incident.main()
                self.assertIn(incident.STATUS, summary.read_text())


if __name__ == '__main__':
    unittest.main()

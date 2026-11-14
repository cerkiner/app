# Hostinger deployment

After a push to `master` passes CI, GitHub uploads the validated `app/` build to
Hostinger, where it is served at https://sam.erkiner.com/app/.

## Connection settings

Use the dedicated FTP account restricted to
`/home/u845409551/domains/erkiner.com/public_html/app`. Its FTP root `/` must
contain the existing app. WordPress and the rest of the hosting root must remain
outside the account's access.

Add these **repository secrets** in GitHub. No variables or activation switch
are required.

| Secret | Value |
| --- | --- |
| `HOSTINGER_FTP_HOST` | Hostname, IP address or `ftp://` URL without credentials or a folder path |
| `HOSTINGER_FTP_USERNAME` | Full restricted FTP username |
| `HOSTINGER_FTP_PASSWORD` | Restricted account password |
| `HOSTINGER_FTP_PORT` | Port, usually `21`; defaults to `21` if omitted |

This setup intentionally uses plain FTP, as approved for this hosting account.
FTP sends the password and files without transport encryption. Keep using the
dedicated folder-restricted account and keep its password in GitHub secrets.
Public resource verification still uses HTTPS.

## Deployment and checks

CI builds and tests the app, then retains that exact build for 30 days as
`production-<commit SHA>`. The deployment job downloads it without rebuilding.
PRs cannot deploy. The `production` environment records deployments and limits
them to `master`; it inherits the repository secrets.

Before uploading, the script checks the existing app's identity and probes
common parent/WordPress paths. Confirm the folder restriction in hPanel too;
these checks cannot prove complete server-side isolation. Back up the existing
app folder before the first deployment.

Each file uploads under a temporary name and is renamed after transfer.
Supporting files go first, `index.html` next, and `ngsw.json` last. Old hashed
assets and existing server configuration are preserved; no remote files are
deleted. Publication is sequential, not a fully atomic release.

Automatic and manual uploads share one queue. Active uploads are not cancelled
by newer releases. Superseded automatic builds skip before publication starts.
Transient upload failures receive up to three attempts with 30-second socket
timeouts. A successful upload is followed by HTTPS comparison of the page,
service-worker resources and manifests with the artifact.

## Connection check, retry and rollback

Open **Actions → Deploy Hostinger manually → Run workflow** on `master`.
Enter the numeric CI run ID from its URL.

- Leave **check_only** enabled to check login and folder access without uploads.
- Disable **check_only** to publish that retained build, retry a failed deployment
  or restore an earlier build.

The source must be a completed master push CI run whose `Validate app` job
passed and whose artifact is still available. A failed deployment does not
invalidate its successful build. PR builds and failed validation are rejected.
There is no automatic rollback; a later master push publishes the newer build.

## Local verification

```sh
python3 -m unittest discover -s .github/scripts/deploy -p 'test_*.py'
```

Tests cover FTP connection behavior, credentials, folder checks, publication
ordering, bounded retries, public-content mismatches and artifact provenance.

## Failed production deployments

A failed, timed-out or cancelled production publication is reported as
**“Deployment failed; latest changes are not confirmed live.”** in the release
summary and a dedicated deployment incident. The independent **Deployment
incidents** workflow handles both automatic CI releases and manual uploads.
It checks the completed run and publication job, so a failed PR build,
pre-deployment validation failure or read-only connection check does not create
a production incident.

Each incident includes the workflow commit, failed run/attempt, failed job links,
and instructions to retry a retained build or roll back. Code fixes go through
a recovery PR; configuration and hosting problems can be corrected directly.
Repeated failures of the same run update and reopen its existing incident.
Confirm successful upload and public-file verification before closing it.
Incidents are not automatically closed by a connection check or later build.

Default-branch failures no longer enter the PR-only repair queue. The incident
reporter has issue-write permission but no hosting secrets or code-write access.
Automatic investigation and recovery PR creation are separate future work;
creating an incident with the built-in GitHub token does not trigger the
repository's issue-opened automation.

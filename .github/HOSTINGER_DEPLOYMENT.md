# Hostinger deployment

After a production-relevant push to `master` passes App release validation, GitHub uploads the validated `app/` build to
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

App release uses GitHub's native path filters. Production source and assets under
src, package inputs, production/TypeScript/service-worker/browser configuration
and the Node version qualify. Known source test files are excluded. README,
documentation, workflow, automation and standalone test changes do not start a
production run. Mixed application/documentation changes qualify. This is a coarse
file-based rule, not a comparison of compiled app contents.


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
by newer releases. Before automatic publication, the candidate must still be an ancestor of master
and the newest production push run. Documentation pushes create no production
run, so they do not displace a pending app release. Superseded app builds skip.
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

The release, incident and FTP runtime helpers are unchanged by the workflow
readability cleanup. This learning POC no longer retains automation test files.
Verify helper syntax and provenance/freshness behavior with temporary synthetic
inputs when changing deployment code. Keep the production application build,
unit checks and browser checks. Never publish to production solely to verify
this cleanup.

## Failed production deployments

Only an attempted publication failure starts Deployment investigation as jobs
inside the same failed release run. There is no incident listener after every CI
completion. Build/validation failures, skipped uploads and connection-only checks
do not open production incidents. Hard cancellation or runner loss may require
manual investigation recovery.

Investigation verifies the source run/attempt and publication step, reuses one
linked incident, and records attempt history, workflow revision, source build
revision, failed steps and recovery links. It can run while the failed parent
release is still active. Historical recovery verifies completed source attempts.
Both current App release and historical CI names remain recognized.

The model gets sanitized evidence and the source-artifact revision, without
hosting credentials. Application fixes become a PR. Hosting or credential
blockers receive concrete human actions. Investigation cannot redeploy and does
not rely on a bot-created issue producing another event.

Use Deployment investigation's Run workflow form for historical recovery. Supply
`failed_release_run_id`, `release_attempt`, and the validated `build_run_id`.
Use Deploy Hostinger manually separately to retry publication or roll back.
Confirm upload and public-file verification before closing the incident.

# Hostinger production deployment

The production build in `app/` is served at https://sam.erkiner.com/app/.
Hostinger metadata in `.hostinger/site.json` records the website as `erkiner.com`
and the folder as `public_html/app/`. WordPress, the blog and the API share the
hosting root. Only the app folder may be accessible to the deployment account.

## One-time setup

1. In Hostinger, select **erkiner.com → Files → File Manager** and confirm that
   the existing app is in `public_html/app/`. Back up that entire app folder
   before the first automated upload; keep the backup outside the public folder.
2. Under **Files → FTP Accounts**, create a separate account whose allowed
   directory is exactly that app folder. Do not use the main hosting account.
   [Hostinger's folder restriction instructions](https://www.hostinger.com/support/1583246-how-to-create-additional-ftp-accounts-in-hostinger/).
3. Confirm **explicit FTP over TLS** works with this account. Use the server
   hostname matching the TLS certificate, not an arbitrary domain or IP.
   Port is normally 21, but use the port Hostinger specifies. There is no
   plaintext fallback and certificate validation cannot be disabled.
4. Open [GitHub repository secrets](https://github.com/cerkiner/app/settings/secrets/actions).
   Add the following secrets. No variables or activation settings are required.
   The production environment is used only to record deployments and restrict
   them to `master`; credentials are inherited from the repository secrets.

| Name | GitHub setting | Value |
| --- | --- | --- |
| `HOSTINGER_FTP_HOST` | Secret | FTP hostname or `ftp://` / `ftps://` URL, without credentials or a folder path |
| `HOSTINGER_FTP_USERNAME` | Secret | Full dedicated FTP username |
| `HOSTINGER_FTP_PASSWORD` | Secret | Dedicated account password |
| `HOSTINGER_FTP_PORT` | Secret | FTP port, defaults to `21` if omitted |

5. Confirm in hPanel and an FTP client that `/` contains the app files, `..`
   remains at `/`, and no WordPress, sibling or parent directories are exposed.
   The workflow checks common escape paths but cannot prove server-side account
   isolation; the folder restriction in hPanel is required. Existing app-specific
   `.htaccess` files are allowed and preserved.
6. Merge the workflows into `master`. Once CI passes, the validated build uploads
   automatically using the configured FTP credentials. There is no activation switch.
7. To check the connection separately at any time, open **Actions → Deploy Hostinger
   manually → Run workflow**, select `master`, enter a CI run's numeric ID from its
   URL, and leave **check_only** enabled. This checks the encrypted connection,
   reads the directory and existing app, and probes parent/WordPress access without
   uploading anything. Disable **check_only** to retry or restore that build.
8. After the first deployment, verify the app, a known WordPress page, the blog
   and the API still behave as before.

If this hosting account does not offer FTPS with a verifiable certificate, stop
setup and resolve that with Hostinger; do not switch to plain FTP. Passwords
belong only in GitHub secrets and your password manager.

## Automatic releases

Every push to `master` runs the existing `CI` validation: production build,
unit tests, browser tests and automation/deployment safety tests. Only after all
checks pass is `production-<commit SHA>` uploaded as a 30-day artifact. The
subsequent deployment job downloads that exact artifact; it never rebuilds it.
Pull requests and CI manual validation runs cannot publish production artifacts
or run deployment jobs.

Automatic and manual releases use the same `hostinger-production` concurrency
group without cancellation. A new master push does not cancel an active upload.
GitHub may replace an older pending deployment with a newer pending deployment;
this is intentional. Automatic releases skip if master has already advanced
when the serialized deployment begins. A push during an active upload queues
the next release rather than interrupting it.

The Python standard-library FTPS client validates server certificates and
requires TLS for authentication and data connections. It uses 30-second socket
timeouts and at most three attempts for transient upload failures. Each file
is transferred under a temporary name, then renamed over its destination;
Hostinger must support rename-over-existing. A failed rename stops publication
without deleting the destination. No remote cleanup or deletion is performed.

Supporting files are published before `index.html`, followed by `ngsw.json`
last. Previous hashed files and server configuration remain in place. After
publication the workflow compares the public page, web manifest, service-worker
manifest and all resources listed in the service-worker hash table with the
artifact, with bounded retries for cache propagation. A mismatch fails the job.
The deployment summary records commit SHA, public URL, check-only/skipped state
and job result. Consult the failing step if deployment fails; raw FTP replies
are deliberately suppressed to keep credentials out of logs.

## Retry and rollback

Use **Deploy Hostinger manually**, choose `master`, enter the source CI run ID
and disable **check_only**. This retries the current release or restores an older
retained build. The resolver verifies repository ownership, CI workflow identity,
master push provenance, artifact identity/expiry and successful `Validate app`.
A completed CI run with failed deployment is accepted if validation succeeded;
a failed validation, PR build, cancelled run or expired artifact is rejected.
Manual rollback deliberately permits a commit older than current master.

Both modes serialize with automatic releases. After rollback, a later master
push will deploy the newer validated build. There is no automatic rollback.
The initial backup must be restored manually if no suitable artifact exists.

Publication is sequential, not a fully atomic multi-file switch. Existing
visitors may keep their cached version; shared filenames can change during an
upload. Interrupted attempts can leave `.deploy-*` files, and old hashed files
accumulate. Cleanup and cache/CDN changes are separate maintenance tasks.

## Local checks

```sh
python3 -m unittest discover -s .github/scripts/deploy -p 'test_*.py'
```

Tests cover TLS enforcement and certificate policy, credential validation,
folder escape detection, upload ordering, bounded retries, atomic file
publication, public-content mismatches and artifact provenance/path safety.
Actual Hostinger login, account confinement, replacement-by-rename and public
cache behavior require the setup checks above. No live upload was performed
while implementing these workflows.

# Repository tasks

The workflows use a ChatGPT subscription login and the pinned CLI. They do not
use API billing, approve PRs, merge code, or deploy from a model session.

## What appears in Actions

| Workflow | Trigger | Work |
| --- | --- | --- |
| Issue tasks | Issue opened, or manual recovery | Investigate and implement a focused change or report findings |
| PR checks | New PR revision, including drafts | Validate that exact revision |
| PR review and repair | PR checks complete | Repair failures, or independently review passing changes and fix confirmed findings |
| App release | Production-relevant master push | Validate and publish the retained build |
| Deployment investigation | Failed publication job, or manual recovery | Update the incident and investigate without redeploying |

Issue work runs directly in its workflow. Instructions are literal YAML blocks beside each execution step. Review and CI
repair have different prompts and fresh sessions. A passing-CI review can start a fresh repair session
inside the same follow-up run. A fix returns through normal PR checks. No source
change means no new commit, CI request, or release. Documentation receives review
for coherence, links, examples and consistency with the application.

There is no dispatcher-to-worker chain, Docker image, command-forwarding bridge,
automatic workflow approval, immediate review dispatch or CI-dispatch fallback.
A superseded or canceled check may still produce a short skipped follow-up entry;
it does not invoke a model. Conflicted PRs without completed checks can be reviewed
through explicit manual recovery.

## PR-page approval and results

Publication uses the built-in GitHub token. GitHub may hold checks for a created
or updated PR. Select **Approve workflows to run** on that PR to start CI. This
only authorizes workflow execution. Code review and merging remain separate
maintainer decisions. A later fix commit can require the button again.

Check results, COMMENT reviews, actionable findings, fix commits and remaining
blockers stay on the PR. There are no approval commands or approval services.
Existing repository protections and approval settings are unchanged.

## Authentication

Use the existing repository secrets:

- `CODEX_CHATGPT_AUTH_JSON`: the complete raw file-based ChatGPT auth JSON.
- `CODEX_GITHUB_AUTH_PAT`: a repository-scoped PAT with Secrets read/write and
  implicit Metadata read permission only. It reads auth-secret metadata and saves
  refreshed authentication, never pushes code or publishes reviews.

Authentication is restored outside the project with private directory/file
permissions. The CLI uses that actual file; refreshed contents are piped directly
to `gh secret set` through stdin. All fields are preserved. Digests avoid unchanged
writes. After every model session, persist the actual login file even if the task
failed, provided authentication was restored. Always clean up afterward. Use the
existing persistence and cleanup steps. This includes read-only reviews. A review
followed by repair saves after each session. Persistence reports saved, unchanged,
failed or not attempted. The CLI environment receives neither the PAT nor the
publication token. Hosting credentials exist only in the publication step.

Every credential-using job shares `codex-login`, with no active cancellation and
`queue: max`. Before restoration, migrated workflows compare the run creation time
with the secret update time, including timestamp equality. A stale queued snapshot
redispatches the same purpose-specific workflow, at most 12 times, before reserving
an execution attempt. This is credential recovery, not a worker or CI dispatch.

**Untouched tutorial limitation:** `run-codex.yml` and the published blog are
unchanged. GitHub captures repository secrets when a run is queued. Another
workflow can refresh the shared login while the tutorial waits, leaving it with
an older copy. A shared concurrency lock prevents simultaneous execution but does
not update that queued copy. Sharing credentials therefore does not completely
solve authentication for the tutorial. Start tutorial experiments only when the
shared queue is idle. The tutorial also retains its existing queue behavior.
No additional framework works around the untouched workflow.

Do not share this login with another machine or repository. If refresh succeeds
but write-back fails, stop queued work, fix PAT access, obtain a new dedicated
login and reseed the raw secret. Hard cancellation or runner loss can prevent
write-back even with always-run persistence. Weekly tutorial maintenance is an
opportunity to refresh, not a guarantee of permanent validity.

## Native execution

The CLI version is `0.169.0`, defined once in `scripts/tasks/execution.mjs` and used
by installation and execution version checks. Only Issue tasks, PR review and
repair, and Deployment investigation install it. Accepted default-branch code
generates the TOML settings outside the proposed workspace. The native CLI receives those settings
explicitly and ignores ambient user configuration and execution rules.

Implementation, repair and deployment investigation can edit the project and
use the native network proxy for the listed package/browser download destinations
and localhost tests. Review uses native read-only filesystem access and command
networking disabled. Read-only restricts writes; it does not necessarily prevent
commands or repository code from executing. There is no custom read/search API.

Authentication, accepted Git metadata, execution configuration, workflow command
files, process credential paths and privileged sockets are unavailable to project
commands. Publication happens later through accepted helpers with a separate Git
index, hooks disabled, checked paths and an atomic expected-head push. Workflow,
instruction, credential, symlink, package-script and test-configuration changes
require human handling. Native settings do not use managed enterprise policies,
requirements.toml deployment or unrestricted-access fallbacks.

Each invocation gets a clean environment, fresh conversation, separate temporary
session and task-specific permissions. Existing bounded summaries supply context;
implementation conversations are never resumed for review. CLI execution lasts
at most 12 minutes, single-task jobs 25 minutes, and combined review/repair jobs
40 minutes. Artifacts retain sanitized results and execution metadata for seven
days, without authentication, arbitrary stderr or full transcripts.

## State and repairs

Authenticated GitHub Actions bot comments and reviews retain task history. Legacy
state markers are read for compatibility. Copying a marker into a human comment
does not authorize execution or reset attempt counters.

Issue implementation is deduplicated by issue/existing branch PR, completed reviews
by head, CI repairs by run/attempt and cycle, and deployment investigation by source
run/attempt. Incomplete reviews remain incomplete and retryable. A repair reserves
one of three shared attempts before execution. Bot commits preserve the cycle;
a new verified human revision or explicit maintainer reset can start another.
CI and review findings share the budget. Every targeted finding is independently
verified. Application repairs require passing regression coverage; documentation
fixes verify the corrected claims or links without artificial code tests.

The current head is checked again immediately before execution and publication.
Forks receive read-only reviews. Protected/default branches are never repaired
directly. Hosting, credential and infrastructure blockers receive concrete human
actions instead of invented code fixes or repeated attempts.

## Runtime helpers

The task runtime folder contains six modules and the structured response schema.
There are no external prompt files, automation test files or fixtures.

| Helper | Purpose |
| --- | --- |
| auth.mjs | Restore the raw login, reject stale queued copies, save changes and clean up. |
| execution.mjs | Install the pinned CLI and run a fresh session with native permissions. |
| tasks.mjs | Collect GitHub context, check eligibility and publish results or changes. |
| state.mjs | Track duplicates, repair budgets, durable reservations and review records. |
| lib.mjs | Supply shared GitHub, validation, filesystem and redaction utilities. |
| validation.mjs | Classify complete changed-file metadata for documentation validation. |

The YAML chooses which task runs. Explicit preparation commands check that task's
inputs and eligibility. Publication emits actionable review findings; a later YAML
step decides whether to prepare and run a separate repair. Helpers retain the
substantial credential, GitHub and publication operations. The existing Python
release, incident and FTP helpers remain unchanged.

## Manual recovery

Use the standard Run workflow forms on the default branch. These are recovery
requests, not approval commands. Approve held PR checks with the PR-page button.

- Issue tasks: supply `issue_number`.
- PR review and repair: choose `task=review` and supply `pr_number`. Optionally
  constrain it with `expected_head_sha` and a successful `checks_run_id`.
- CI repair: choose `task=ci-repair`, supply `pr_number` and `checks_run_id`.
  `reset_repair_budget=true` explicitly requests a new maintainer-authorized budget.
- Review repair: choose `task=review-repair`, supply `pr_number`, `review_id`, and
  the exact reviewed `expected_head_sha`.
- PR checks: choose the PR branch as ref, supply `pr_number` and its exact
  `expected_head_sha`. This reruns validation and does not approve a pending run.
- Deployment investigation: supply `failed_release_run_id`, `release_attempt`,
  and `build_run_id`. The failed workflow and artifact revisions can differ.
  Investigation never redeploys.

Leave `login_retry_count` at zero and `budget_reset_run_id` blank. These fields
preserve bounded stale-login recovery and the original authorized reset request.
The same-workflow retry carries the task, revision and source identifiers forward.

For example, investigate the verified historical publication failure without
uploading anything:

```sh
gh workflow run deployment-investigation.yml --repo cerkiner/app --ref master \
  -f failed_release_run_id=43568290275 -f release_attempt=1 -f build_run_id=43568290275
```

## Verification and rollout

This learning POC intentionally omits automation test suites and fixtures. They
are not needed to execute the workflows. Runtime result validation, permission
checks, authenticated state, repair budgets and publication guards remain.
The normal application build, unit suite and browser suite remain in validation.
PR checks and App release no longer install the model CLI.

During this cleanup, establish the existing test baseline before deletion, check
module imports and workflow syntax, then use temporary synthetic data for focused
authentication, state, revision and CLI verification. Report concrete CLI or runner
limitations instead of loosening permissions. These development checks do not
establish that a real subscription login or end-to-end task succeeds.

After merge, wait for the shared login queue to drain, then open a controlled
README-only issue. Verify a real task, credential persistence, PR-page approval
when required, CI, independent review, fixes and duplicate suppression. Replay a
verified historical publication failure without redeploying. Do not deploy only
for verification. Live success proves the migrated flows, not elimination of the
untouched tutorial's queued-secret limitation.

Only `CODEX_AUTH_JSON_B64` and `GH_PAT` become obsolete after live verification.
Keep both replacement authentication secrets and every hosting secret.

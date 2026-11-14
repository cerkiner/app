# Autonomous Codex development in GitHub Actions

This implementation investigates new issues, independently reviews new PR heads,
and repairs eligible failed `CI` runs or significant actionable review findings,
with no automatic PR approval or merge. It
uses the Codex CLI with a ChatGPT subscription, GitHub CLI, repository secrets,
comments, commits and short-lived diagnostic artifacts. There is no external
service, database, Agents API or API-key billing fallback.

## Automatic operation

Every new issue starts investigation and implementation when a code change is
appropriate. Every new PR head receives a review regardless of its creator.
Failed CI or actionable P0/P1/P2 review findings start bounded repair on
repository-owned feature branches, for both human and bot PRs. Green CI does not
prevent review-triggered repair. Optional P3 suggestions remain feedback. No labels, tags, linked issue, author
allowlist or repair opt-in are required or checked. Repository visibility does
not affect eligibility. GitHub's repository interaction permissions remain under
the owner's control.

OpenAI's current [account-auth CI/CD guide](https://learn.chatgpt.com/docs/auth/ci-cd-auth)
documents the advanced restore/refresh/persist pattern for trusted automation.
This repository uses its owner's collaborator-only trust model, a dedicated
serialized login and isolated repository tools. Fork PRs receive read-only
reviews through the base repository's PR head ref; repair only writes to
authorized branches inside this repository. There is no API billing fallback.

GitHub Free can run this on its standard Ubuntu runners within the account's
applicable Actions allowance. Builds, tests, containers and
queued-job setup consume runner minutes, and Codex consumes subscription usage.
There is no promise of unlimited or zero-cost execution. Repository environment
secrets and paid environment protection features are not required.

## Files and execution flow

| File | Responsibility |
| --- | --- |
| `workflows/codex-issue.yml` | Every `issues: opened` event dispatches an investigation, without a label. |
| `workflows/codex-review.yml` | PR-context signal plus a trusted metadata-only `pull_request_target` dispatcher, including conflicted PRs. Neither path receives Codex credentials; the target path checks out only default-branch orchestration. |
| `workflows/codex-repair.yml` | A failed completed `CI` run dispatches a repair investigation. |
| `workflows/codex-agent.yml` | Trusted default-branch worker; also handles completion of the PR review signal. |
| `scripts/codex/agent.mjs` | Context collection, provenance, eligibility, attempt reservations, validated commits, reviews, comments and downstream dispatch. |
| `scripts/codex/messages.mjs` | Central agent identities, stage headings, concise checks/next steps, and collapsed technical details. |
| `scripts/codex/reviews.mjs` | Authenticated structured review records, request validation and direct repair dispatch. |
| `scripts/codex/checks.mjs` | Start exact, trusted bot-generated PR workflow runs; controlled dispatch remains the fallback. |
| `scripts/codex/state.mjs` | Retry cycles, secret freshness, finding deduplication and diff-line mapping. |
| `scripts/codex/auth.mjs` | Restore, validate, persist and erase subscription credentials. |
| `scripts/codex/run-codex.mjs` | Replaceable Codex execution adapter. CLI is pinned to `0.169.0`. |
| `scripts/codex/sandbox-mcp.mjs` | Trusted stdio workspace bridge into a credential-free Docker container. |
| `prompts/` | Task-specific instructions and execution contract. |

All `.mjs` orchestration uses Node's standard library; there are no additional
project dependencies. The workflows use Node 24 and `ubuntu-latest`. Existing
third-party actions are pinned to full commits. The container base is versioned
as `node:24.15.0-bookworm` and pinned to its verified multi-platform image digest;
Debian packages still resolve at build time.

GitHub can hold `pull_request` workflows created by `GITHUB_TOKEN` for execution
approval. After a validated publish, the coordinator starts only the matching
`CI.yml` and `codex-review.yml` runs for the exact repository, PR, branch and SHA.
It uses the existing short-lived Actions-write token, and only when the entire
workflow tree matches the trusted controller checkout. This authorizes CI
execution, never a PR review approval or merge. Changed workflow definitions
remain subject to GitHub's workflow approval policy; Codex still reviews them.
Older event behavior falls back to controlled CI and review dispatches. See
[GitHub token event behavior](https://docs.github.com/en/actions/concepts/security/github_token).

The execution adapter accepts a collected task and emits `result.json` according
to `result.schema.json`, plus restricted diagnostic events and metadata. It does
not publish anything. A later API or remote executor can implement this contract
without replacing the issue/review/repair orchestration or enabling API billing
in the current adapter.

Issue investigations read the issue, recent discussion and repository.
Actionable changes become `codex/issue-N`, a commit, and a PR against the current
default branch, using `Refs #N`. The issue gets the PR link and test summary.
Non-coding/ambiguous requests get a findings comment and no commit or PR. An issue
with a completed bot record or an existing issue-branch PR is not implemented
again. Failed or incomplete investigations can be redispatched by a maintainer.
PRs with reported failing tests or no passing tests are opened as drafts.

The three consistent identities are **Codex Issue Agent**, **Codex Review
Agent**, and **Codex Repair Agent**. Investigation and implementation are stages
of the same Issue Agent execution. Review always starts independently with a
fresh context.

The publisher, rather than model prose, generates every comment heading and
layout. Visible messages contain a short summary, **Checks**, **Next**, and run,
commit or PR links. Failure reasons stay visible and short. Investigation notes,
full check results, paths, workflow names and identifiers are inside collapsed
**Technical details**. Machine state remains in escaped HTML comment markers.
Issue progress is updated in place; each bounded repair attempt updates its own
progress comment so historical attempt records remain available.

| Agent/stage | Visible heading |
| --- | --- |
| Issue investigation and implementation | 🔎 Codex Issue Agent — Investigating |
| Issue PR ready | 🛠️ Codex Issue Agent — Pull request prepared |
| Issue findings/no coding | 💬 Codex Issue Agent — Findings reported |
| Complete review without significant defects | 👀 Codex Review Agent — No significant issues found |
| Review with material defects | 👀 Codex Review Agent — Changes needed |
| Incomplete review | 👀 Codex Review Agent — Review incomplete |
| CI repair starts | 🔧 Codex Repair Agent — Investigating CI failure · Attempt N/3 |
| Review repair starts | 🔧 Codex Repair Agent — Investigating review findings · Attempt N/3 |
| Repair published | 🔧 Codex Repair Agent — Fix pushed · Attempt N/3 |
| Blocked/disputed repair | 🛑 Codex Repair Agent — Human input needed |
| Shared budget exhausted | 🛑 Codex Repair Agent — Retry limit reached |

Reviews run regardless of CI status or merge conflicts. The metadata-only
`pull_request_target` path dispatches the exact PR head, since GitHub does not run
`pull_request` workflows for conflicted PRs. It never checks out or executes PR
code. The normal PR signal remains a second event path; the serialized worker
deduplicates by SHA. Publication always uses `COMMENT`, never `APPROVE` or merge.
Review execution only lists, reads and searches files; it never runs PR code.

Results explicitly state `review_status`: complete, incomplete or not_applicable.
Missing relevant source access, failed repository tool operations or a partial
diff force an incomplete review, which cannot use the clean heading. Known
findings are still reevaluated on subsequent revisions. Stable keys and explicit
previous-key references prevent repeated inline comments; unresolved findings
remain eligible for repair even when previously published.

After publishing a review, the coordinator directly dispatches the same trusted
worker with `mode=repair`, `repair_source=review`, the PR number, exact reviewed
SHA, review identifier and structured actionable findings. There is no general
PR-comment/activity listener. The worker fetches the actual GitHub review,
verifies its bot-authored state and commit, and rejects supplied findings that
differ from that record. Actionable P0/P1/P2 defects qualify; optional suggestions
never qualify. A credible actionable finding can be verified even when the
broader review has an explicitly reported scope limitation.

The Repair Agent independently reproduces each finding, adds or updates a
regression test, demonstrates its pre-fix failure, applies the focused fix, and
checks that the regression passes. Each finding receives a structured verdict:
verified_fixed, incorrect, not_reproduced, already_resolved or blocked. Incorrect
or unreproduced findings receive an explanation and stop that finding's path for
the cycle. They do not block unrelated CI repair. Publication rejects a claimed
review fix without passing regression verification or a changed test file.

## Repository setup

1. Land all four workflows, scripts and prompts on the repository's **default
   branch**. `workflow_run` handlers and dispatch targets must exist there. If
   copying to another repository, retain `CI` as the workflow name and `CI.yml`
   as the filename, or update the repair trigger, `CI_WORKFLOW` constant and
   workflow-run provenance checks together. The default branch is discovered
   through GitHub; it is currently `master` here.
2. In **Settings → Actions → General**, allow the pinned actions to run and enable
   **Allow GitHub Actions to create and approve pull requests**. The checkbox is
   necessary to create PRs; this implementation does not approve them. Workflow
   `permissions` explicitly give only the trusted worker Contents, Issues,
   Pull requests and Actions write permissions. The request workflows have
   Contents read/Actions write; the PR-context signal has no token permissions.
   Organization policy can prevent these grants; an administrator must resolve
   that restriction. Do not add a branch-protection bypass for the bot.
3. Create a fine-grained PAT restricted to this repository with **Repository
   permissions → Secrets: Read and write** and the implicit Metadata read
   permission. Give it a sensible expiration. Store it as the **repository
   Actions secret `GH_PAT`**. This PAT only checks auth-secret metadata and updates
   that secret. It is never used to push, publish or launch Codex. The worker
   uses a separate `GITHUB_TOKEN` for those operations.
4. On a trusted local machine, create a **dedicated CI Codex login** using the
   pinned CLI and file-based credential storage. Use a new directory so you do
   not rotate the session used by an active desktop or CLI installation:

   ```sh
   umask 077
   codex_ci_home="$(mktemp -d)"
   CODEX_HOME="$codex_ci_home" npx --yes --package=@openai/codex@0.169.0 \
     codex -c cli_auth_credentials_store='"file"' login
   # Complete ChatGPT sign-in. Do not use login --with-api-key.
   ```

   Set `GH_REPO=owner/repo` to this repository, authenticate
   local `gh`, then upload without displaying the auth data:

   ```sh
   export GH_REPO=owner/repo
   python3 -c 'import base64,pathlib,sys; sys.stdout.write(base64.b64encode(pathlib.Path(sys.argv[1]).read_bytes()).decode())' \
     "$codex_ci_home/auth.json" | gh secret set CODEX_AUTH_JSON_B64 --repo "$GH_REPO"
   rm -rf "$codex_ci_home"
   unset codex_ci_home
   ```

   Existing `~/.codex/auth.json` can also be copied if it is a ChatGPT file login,
   but stop other processes sharing that session before seeding. Auth stored only
   in a macOS/keyring credential store is not an auth file; generate a separate
   file login. Never print, commit, upload as an ordinary artifact, or reuse the
   seed on another active runner. A copied refresh token is still the same session.
5. Optionally set repository variable `CODEX_MODEL` to a model available to the
   subscription. If unset, the CLI selects its default. Setting
   `CODEX_AUTOMATION_ENABLED=false` disables execution and posts a notice. Do not
   put tokens in variables. Events start work directly after setup.
6. Run the smoke scenarios below. A live successful CLI execution, refresh and
   write-back need valid secrets and an open issue/PR target; local tests
   cannot certify the current account, PAT or GitHub settings.

## Credential refresh, persistence and queue safety

The CLI, rather than the official action, is used directly. The official
[action documentation](https://learn.chatgpt.com/docs/github-action) describes
its API-key proxy and configurable Codex home; it does **not** promise the
subscription secret write-back required here. The current
[authentication reference](https://learn.chatgpt.com/docs/auth) documents
`cli_auth_credentials_store="file"`, `CODEX_HOME`, ChatGPT-only login and built-in
refresh. The executor forces these settings and removes API keys from its
environment, so a failed login cannot fall back to API billing.

Every actual execution restores `CODEX_AUTH_JSON_B64` into
`$RUNNER_TEMP/codex-agent/credentials/auth.json`, with a 0700 parent and 0600 file.
That exact directory is passed as `CODEX_HOME`; no action copies it to an
untracked home. File/keyring/API-mode mismatches fail explicitly. Codex can write
its refreshed file there. The `always()` persistence step validates the actual
file and pipes its base64 encoding to `gh secret set` using `GH_PAT`. It runs even
if execution, tests or CLI setup fail. If the file did not change, the already
current secret is left alone, avoiding needless queue churn. Cleanup erases auth
and ephemeral session files before publication.

All worker jobs use the same concurrency group, `queue: max`, and
`cancel-in-progress: false`. GitHub's default queue retains only one pending job;
[`queue: max`](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
retains up to 100. Do not change it to `single` or cancel in-progress work.

**Serialization alone does not make repository secrets fresh.** GitHub
[reads repository secrets when a run is queued](https://docs.github.com/en/actions/reference/security/secrets),
so a waiting job can hold an obsolete refresh token. Before decoding credentials,
the worker reads the secret's `updated_at` via `GH_PAT` and compares it with the
workflow run's `created_at`. If the secret was updated at or after that time, it
dispatches a new worker and stops without launching Codex or reserving a repair
attempt. Equality is treated as stale because timestamps have second precision.
The new run receives a fresh repository-secret snapshot. Repeated redispatch is
capped at 12, with a clear failure if credential churn prevents progress.

Do not update/reseed this secret while jobs are executing, or share this session
with other repositories/machines: the repository concurrency group cannot lock
those processes. Manual cancellation, runner loss, GitHub outage and the hard
job timeout can prevent even `always()` cleanup/write-back. If rotation occurred
but write-back failed, disable automation, obtain a **new** login, replace the
secret, fix PAT/storage access, then re-enable and redispatch. The CLI timeout is
12 minutes inside a 25-minute job to reserve time for write-back and publication.
PAT permission/expiration failures name `GH_PAT` and do not print API responses
or credential data.

## Trust boundaries

1. GitHub events contain identifiers, never shell-interpolated issue/PR text. The
   coordinator fetches current data through `gh`, validates repository, workflow
   path/name, event, branch and SHA, and checks policy before referencing secrets.
   Investigation and review do not depend on author identity, labels or tags.
   Repair requires an unprotected, repository-owned feature branch. Comments and
   artifacts from PR code never authorize credential release.
2. The trusted controller is checked out from the default branch. No PR workflow
   YAML, package lifecycle hook, test or source script executes on that host.
   The Codex CLI runs from a neutral directory with host shell, images, hooks,
   plugins, apps, child agents and web search disabled, a read-only host sandbox,
   and user/project config and rules excluded. The controller's filesystem
   permission profile grants only minimal runtime/trusted-script reads and
   explicitly denies auth-directory, `/proc` and Docker-socket access. Its only repository tools come
   from the trusted workspace MCP bridge. Native apply_patch cannot write under
   this read-only policy. This policy is tied to the pinned CLI's tool behavior;
   review it before upgrading the CLI or enabling additional tools.
   The workspace namespace is explicitly exposed as direct tools, including for
   model catalogs that request code-mode-only execution. The code-mode host stays
   disabled; repository tools do not depend on its discovery/execution path.
   Only the trusted bridge's four tools use `approval_mode="approve"`; Codex's
   `auto` mode can still require an interactive prompt for unannotated MCP tools.
   Their operations remain confined to the container and review's restricted
   tool set; the overall interactive approval policy remains `never`.
3. Repository files are exported without host Git metadata into a Docker
   container. Its temporary filesystem permits downloaded browser binaries to run,
   while retaining `nosuid` and `nodev`. It has no auth mount, PAT, GitHub token,
   Docker socket, host PID namespace or elevated capabilities. The root filesystem is read-only, with
   bounded memory/CPUs/processes and a private writable `/tmp`. Implementation
   commands can install dependencies and run tests over normal network access.
   Untrusted commands are Docker argument data, never evaluated by a host shell.
4. Review uses a read-only repository mount and no container network. Its bridge
   offers listing, reading and text search, with no arbitrary command tool. It
   neither installs dependencies nor executes PR code. Test results are reported
   as not run rather than inferred from CI success.
5. The container is destroyed before publishing. Publication uses the trusted
   Git directory, an independent index, no global/system config, no hooks, and
   `commit-tree`, without executing model-provided scripts. It rejects automation,
   instruction, credential, test configuration, symlink and submodule edits,
   changes to package scripts, patches over 1 MiB, and over 80 changed files.
   Known credential patterns are rejected. Before repair push, ownership,
   protection and the exact head are checked again. The explicit
   `--force-with-lease=ref:expectedSHA` is an atomic compare-and-swap: the new
   commit's parent is the original head, so the successful update is a fast
   forward. A human's concurrent change or branch recreation makes the push fail.
   New issue branches require an absent remote ref.
6. `GH_PAT` exists only in the auth metadata/restore and persistence steps, never
   in Codex's environment or repository commands. The separate publication token
   is only supplied to the trusted coordinator. Prompts are defense in depth;
   tool restrictions and container mounts provide the command boundary.

Anyone who can directly modify the trusted default branch/workflows or manage
repository secrets is an administrator of this trust model. Protect that branch
and review automation changes. Container isolation and output redaction reduce
risk but cannot prove arbitrary generated code is correct or secret-free. Human
review remains required before merging. Automation cannot edit its own guardrails
or relax tests merely to make CI green.

## Retry policy and persistent memory

Bot comments have a `<!-- codex-agent:v1 {...} -->` record. Only records authored by
`github-actions[bot]` with GitHub's Bot account type count as machine state.
An issue/PR author cannot forge ownership or attempt counters by copying a marker.
Recent discussion and bounded bot summaries are supplied to each fresh session;
full history is not copied into every prompt. Visible comments are concise;
structured state retains source, request keys, review identifiers and per-finding
verification without exposing machine metadata in the rendered message.

Repair reservations count **before** execution, including crashes, auth/setup
failures after reservation, and unsuccessful fixes. Records contain input/output
SHA, cycle, attempt, failed workflow ID/attempt, failure fingerprint, run URL and
result summary. The output SHA is saved **before** pushing. Thus a repair commit
inherits its cycle and cannot reset the limit of three attempts. The same CI run
attempt or review request is not reserved twice. CI and review repairs share the
same three-attempt cycle; bot commits never replenish it. The worker includes
current actionable review findings in CI repair, and an already failed exact-head
CI run in review repair. One execution can address both. Queued requests for a
revision superseded by a fix are skipped before execution.

Infrastructure/non-code outcomes stop the affected trigger path. Incorrect,
unreproduced, already-resolved or blocked findings stop that finding's path for
the cycle; other sources retain the remaining shared budget. A new request after
attempt three posts the human-intervention notice without a fourth Codex repair
execution. A separate immediate head check runs after credential restore and
before Codex; publication checks again and retains the atomic push lease.

A different head resets automatically for a repository writer's commit. For
verified GitHub web-editor commits, `web-flow` is the service committer, so the
worker checks the associated human author's write permission instead. Unverified
web-flow attribution and unrelated bot commits do not reset the budget. A known
repair output always retains its original cycle, even if its identity is human-
associated. An explicit new cycle requires a maintainer's manual dispatch:

```sh
gh workflow run codex-agent.yml --repo "$GH_REPO" --ref master \
  -f mode=repair -f target=FAILING_CI_RUN_ID -f new_cycle=true
```

Use the destination's default branch instead of `master` when different. For a
manual review or issue retry, dispatch `mode=review` or
`mode=issue` with the PR/issue number. A completed issue is deliberately not
reimplemented; create a follow-up issue for a genuinely new request.

Codex's [non-interactive documentation](https://learn.chatgpt.com/docs/non-interactive-mode)
supports `codex exec --json`, `--output-schema` and
`codex exec resume <SESSION_ID>`. The MVP captures the thread ID but uses
`--ephemeral` and **does not upload or restore session files**. Resuming on a fresh
runner requires the session data, not just the ID. A future adapter can restore a
vetted allowlist of session data, fall back to summaries, and still keep auth out
of artifacts. Resuming may consume prior-context resources and is not free usage.

## CI retriggering, review dispatch and manual recovery

After an issue implementation or repair is pushed, the coordinator waits a
bounded time for native bot-created PR workflow runs. GitHub PR-head metadata
may briefly lag behind an atomic push: polling tolerates only the exact pre-push
head until it catches the published SHA. Any third revision stops authorization. It starts only the matching
CI and review signal runs for the exact repository, PR, branch and SHA, and only
when their workflow tree matches the trusted default-branch checkout. This
approves workflow **execution**, never a PR review or merge. The existing
short-lived Actions-write token is sufficient; no extra secret is required.

When native events are unavailable or workflow definitions differ, the fallback
explicitly dispatches `CI.yml` at the PR branch with PR number and expected SHA.
CI rejects superseded dispatches and uses the PR number as its concurrency key.
The coordinator independently dispatches review of the exact new head. Native
and explicit review requests are harmless duplicates because publication is
tracked by SHA. Older branches that reject optional dispatch inputs with HTTP
422 are dispatched once without inputs; other API errors are not blindly retried.
Update old feature branches from the default branch for the current guards.

GitHub's [token event documentation](https://docs.github.com/en/actions/concepts/security/github_token)
explains held bot PR workflows and supported explicit dispatch. The configured
`CI` workflow builds production, runs Karma and Playwright, and tests automation
policies. Other workflow/check names do not independently start CI repair.
Review findings do start repair even when all CI checks are green.

For a review repair, `target` is the PR number, not a CI run ID. A maintainer can
retry a published review explicitly (set new_cycle only to request a fresh
bounded budget):

```sh
gh workflow run codex-agent.yml --repo "$GH_REPO" --ref master \
  -f mode=repair -f repair_source=review -f target=PR_NUMBER \
  -f expected_sha=REVIEWED_SHA -f review_id=REVIEW_ID -f new_cycle=true
```

The structured findings input is always passed by the automatic coordinator.
For manual recovery it can be omitted: the trusted published review is fetched
and validated. Supply `repair_source=ci` (the default) and a failing run ID for CI
repair. Stale-auth redispatch preserves source, review ID and structured findings.
Duplicate review signals can recover a missing repair dispatch from the existing
published record without another model review. Executions deduplicate durable
request keys before reserving an attempt.

Comments and issue edits provide context but do not themselves trigger execution.
New issue events, PR events, completed failed CI and these controlled dispatches
are the orchestration inputs. The worker never bypasses branch rules or merges.

## Diagnostics and limits

Artifacts retain seven days of structured results, optional sanitized failed-CI
excerpts, restricted JSONL lifecycle/usage events, tool coverage counts, CLI version, session ID, head
SHA, target and workflow run ID. Command output, reasoning, full transcripts,
auth files, environment dumps, session databases and patches are **not** uploaded.
Known seed and refreshed token values are redacted before a result is saved;
common token/bearer formats are also filtered. Structured output is parsed first,
then only its string values are redacted before JSON serialization, preserving
quotes, escapes, arrays and numeric/schema fields. Malformed JSON produces a
generic parse error that does not echo result contents. Credentials are never passed as
command arguments. Comments include investigation, changes, tests and unresolved
work, with a workflow link. Commits carry issue/cycle trailers.

Limits: 25-minute worker job; 12-minute Codex invocation; 170-second individual
workspace commands; 4-minute image build; 3 repair attempts/cycle; 100 pending
credential jobs; 12 stale-snapshot redispatches; bounded prompt/diff/log sizes;
80 changed files and 1 MiB patches. Large logs and partial diffs cannot establish
exhaustive coverage. Timeouts and errors fail visibly rather than extending loops.

## Test plan

Run the local standard-library suite, without credentials or an AI call:

```sh
node --test .github/scripts/codex/*.test.mjs
```

It covers cycle continuity/exhaustion, crash reservations, new human revisions,
forged comments, stale credentials, file auth restoration/rotation/cleanup, PAT
failures, unrestricted author handling, read-only fork review, conflicted-PR dispatch, web-editor budget
resets, review comment publication, stale heads, tool
restrictions, redaction, blocked edits, package-script protection, independent Git
indexes, hooks, new files, and an actual local-Git concurrent push race.
An optional contract test also starts the actual pinned CLI against a local mock
endpoint, with an empty temporary auth home and no external inference calls.
It verifies direct tool exposure and executes every isolated tool through an inert
Docker substitute, proving that interactive approval is not required:

```sh
CODEX_CLI_BIN=/absolute/path/to/pinned/codex node --test .github/scripts/codex/cli-contract.test.mjs
```

Use `actionlint .github/workflows/*.yml` to check workflow syntax. As of the
implementation, released actionlint `1.7.12` does not understand GitHub's newly
documented `concurrency.queue`. With that release use this exact, narrow exception
and separately verify `queue: max` against the GitHub documentation linked above:

```sh
actionlint -ignore 'unexpected key "queue" for "concurrency" section' .github/workflows/*.yml
```

In this repository or a collaborator-restricted test copy, verify these scenarios before relying on
the automation:

| Scenario | Expected result |
| --- | --- |
| Open a small reproducible bug issue, no labels | Investigation, focused test/fix, issue branch, PR, linked issue summary and explicitly dispatched CI/review. |
| Open a question or ambiguous issue | Findings/next-action comment; no branch, commit or PR. Redispatch does not duplicate completed work. |
| Open/update a human PR with passing CI | Independent COMMENT review. Actionable defects start verified repair; optional suggestions remain feedback. |
| Review finds a genuine logic defect missed by CI | Direct review-to-repair dispatch, failing-then-passing regression, same-branch fix, fresh CI and independent review. |
| A reported finding is incorrect or cannot be reproduced | Explain the evidence, stop that finding path, and preserve the remaining shared budget for other failures. |
| A review cannot inspect relevant source or has a partial diff | Explicit Review incomplete result; never a clean heading. |
| CI and review both request repair of one SHA | One combined context where possible, durable request deduplication, and at most three shared attempts. |
| Open/update a PR with failing CI | Review runs and failed CI starts repair on an eligible repository-owned branch automatically. |
| Open/update a PR with merge conflicts | Trusted metadata dispatch starts the head review even when PR-context CI/signal workflows cannot run. |
| Fail `CI` on any same-repository feature branch | Durable attempt record, focused commit on the same branch and fresh CI run at the new SHA. |
| Fail `CI` on a bot-created PR without provenance records | The same automatic repair behavior applies. |
| Leave the failure unresolved through three attempts | No fourth execution; a human-intervention notice and CI run link. Bot commits do not reset the cycle. |
| Push a new human revision, including a signed GitHub web edit | A new cycle is available; previous summaries remain visible. Bot repair SHAs keep their existing cycle. |
| Report missing credentials/flaky infrastructure | Halt/report rather than repeatedly changing source. |
| Update or protect the branch during execution | Publication refuses the stale/unauthorized push. |
| Open an issue or PR in a public copy, as any creator | Investigation/review proceeds automatically without author or visibility approval. |
| Submit a fork PR | Read-only review is published. Automatic repair never pushes to the external contributor branch. |
| Queue several tasks, then let a normal CLI run refresh auth | Refreshed secret is stored; older queued snapshots redispatch before using it. |
| Force a nonzero Codex exit after a refresh in a controlled test | Write-back still runs. Use only a dedicated test login; never edit/forge OAuth token contents to force refresh. |
| Revoke the test PAT or login | Named auth/storage error, no API fallback, no credential artifacts. |
| Put prompt-injection text in an issue/log/PR | No host shell or credential mount becomes available; guardrail edits are rejected. |
| Check all run artifacts and comments | Only allowed diagnostic fields; no auth, keys, complete transcripts or session cache. |

A Docker daemon and Ubuntu are needed to test the actual container boundary.
Local mocked CLI tests do not establish live subscription validity, account rate
limits, token rotation, workflow event delivery or branch rules. The smoke test
must confirm those with the destination's credentials.

## Troubleshooting and future work

- **Only policy notices:** disabled automation, protected repair branch, or an
  attempted repair of an external branch. Reviews are not restricted by creator.
- **No worker run:** workflows are absent from the default branch, Actions write
  is restricted, initial fork workflow awaits GitHub approval, or the 100-job queue
  filled. Inspect the request run and manually redispatch the missed target.
- **401/refresh revoked/interactive login:** disable, generate a dedicated new
  file login, replace the secret and re-enable. Do not switch to an API key.
- **GH_PAT missing/expired/403:** replace the repository-only Secrets read/write
  PAT. Contents/Issues/PR/Actions publishing permissions belong to the job token.
- **Credential persistence failed after refresh:** reseed before another run;
  the runner copy is intentionally never published as an artifact.
- **Stale-head or occupied issue branch:** inspect the newer human changes. An
  interrupted push before PR creation may leave an orphan `codex/issue-N` branch;
  inspect it and create its PR manually. The agent never overwrites that branch.
- **CI/review dispatch failed after push:** the commit/PR and attempt remain in
  GitHub. Dispatch `CI.yml` with `pr_number` and `expected_sha`, and dispatch
  `codex-agent.yml` with `mode=review`, `target=PR_NUMBER`, `expected_sha=SHA`.
  Do not start another implementation solely to repeat dispatch.
- **Docker/image/browser installation failed:** inspect the trusted executor and
  runner availability. There is no host-execution fallback. Long individual
  tests may exceed the per-command limit and need a deliberate policy change.
- **CLI upgrade:** update the pinned version in workflow, adapter, docs and setup,
  check its auth file behavior and entire native-tool surface, then rerun boundary
  and Ubuntu-runner smoke tests. Do not change to an unpinned latest install.

Potential improvements are an immutable prebuilt container image, stricter
network egress, separate publication jobs, safe orphan-branch recovery,
durable queue recovery beyond 100 requests, richer failure fingerprints, a
credential-persistence circuit breaker, and vetted session-data restoration.
These require explicit design work; the current implementation favors bounded,
auditable summaries and human review over extra infrastructure.

# Operations

Complete [installation and activation](installation.md) first. Define the [pinned CLI function](installation.md#choose-and-run-a-pinned-cli) with the revision recorded in `.grait/installation.json`. Run the commands from the target checkout or the assigned issue worktree as directed below. Use one host per Project. The parent runs in the official harness, and deterministic commands coordinate GitHub state.

## Start and inspect

```sh
grait orchestrator start
grait orchestrator status
```

The default is five concurrent workers; [configure worker concurrency](setup.md#configure-worker-concurrency) with `maxConcurrentWorkers` in `workflow.config.json`. Native harness sessions are not an unlimited background service: subscription limits, permission prompts, or human/CI waits may stop progress. Save committed handoffs and continue from the recorded state rather than starting duplicate work. There is no automatic API-billing fallback.

## Triage and claim

Create the issue with its problem, acceptance criteria, validation, and native blocked-by relationships. The triage role returns a JSON assessment:

```json
{
  "version": 1,
  "issue": 123,
  "digest": "SHA256_OF_CURRENT_TITLE_AND_BODY",
  "ready": true,
  "blockers": [],
  "questions": [],
  "checklist": {
    "scope": true,
    "acceptance": true,
    "validation": true,
    "dependencies": true,
    "alignment": true
  },
  "tdd": { "required": true }
}
```

Compute the digest from the current GitHub issue title and body. Replace `OWNER/REPOSITORY` and `123` with the repository and issue number:

The parent runs triage in the background alongside implementation and review when Ready is below `maxReady`. It selects Backlog candidates by Project priority, then queue order, and continues dispatching eligible Ready stories while triage runs. Triage uses the same `maxConcurrentWorkers` pool as the other specialists.

When each assessment returns, the parent records it with the ready command below and requests that the harness stop or close the triage sub-agent as needed. The parent keeps counting the triage worker while it is active or stopping, even when a claim frees a Ready slot. It releases the worker slot only after the harness confirms that the agent has stopped or completed. A confirmed completed thread can stay visible after the slot is free.

Blocked candidates stay in Backlog. The triage pass ends when Ready is full, no further candidate can become Ready, or a pause or capacity limit prevents further work. The parent rechecks when a claim frees a Ready slot, a completed dependency changes eligibility, or a worker becomes available.

```sh
gh api repos/OWNER/REPOSITORY/issues/123 | node --input-type=module -e '
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
const { title, body } = JSON.parse(readFileSync(0, "utf8"));
const hash = createHash("sha256").update(JSON.stringify([title, body || ""]));
console.log(hash.digest("hex"));
'
```

Blocker references use `owner/repository#N` and must exactly match native GitHub blockers. Use `ready: false` while any blocker remains incomplete. Ready holds up to `maxReady` stories across the Project (five by default). Claiming a Ready story frees a Ready slot for another eligible Backlog story. An exemption uses `"tdd": {"required": false, "reason": "Concrete reason testing is inapplicable"}`. An outsider needs maintainer admission via `agent:admitted` unless current write access or configured identity makes them trusted.

```sh
grait orchestrator ready --issue 123 --file /tmp/triage.json
grait orchestrator claim --issue 123
grait orchestrator worktree --issue 123
```

The orchestrator counts In Progress stories and Review reservations before each new claim. It can claim eligible Ready work when fewer than five story slots are occupied and can dispatch it when a worker is available. A current-head approval with no effective request for changes frees the story slot, even while inline threads await resolution before merge. Pending, rejected, and unverifiable Review stories each occupy one slot. See the [workflow rules](workflow.md#claiming-and-delivery) for how reviews count. Existing claims and Review fixes remain resumable.

The command reserves In Progress before work. Repeated accepted claims return the same issue branch. The command checks current scope, dependencies, and the combined five-story cap. Inaccessible active items count against capacity. Budget one `maxConcurrentWorkers` slot for each active reviewer, with one active reviewer per story. The worktree command prints the assigned absolute path and head. Give that path, acceptance digest, committed SHA, scope, and next owner to each specialist.

## Tester-first implementation and publishing

Follow [TDD](tdd.md) for the committed Red/Green handoffs. The parent may delegate natively using the assigned worktree, or start a native specialist session there:

```sh
grait orchestrator worker --issue 123 --role test
```

Run verification/publishing from the assigned issue worktree. Only one role may own it at a time. After accepted implementation and Green:

```sh
grait github push --issue 123
grait github pr --issue 123 --title 'feat: implement accepted behavior' --body-file /tmp/pr-body.md
```

Complete the accepted scope, validation, and relevant documentation before publishing. The publisher opens a normal ready-for-review PR with `Closes #123` and requires accepted independent Green for that exact head (or a reasoned triage exemption). Include actual validation evidence and risks in its body, then synchronize the Project:

```sh
grait orchestrator sync --pr 456
```

Use `--draft` on the PR publishing command only when the user explicitly requests work in progress or early feedback. Drafts are not the normal delivery state and do not imply completed work. After finishing such a draft and obtaining exact-head Green or the accepted exemption, use `grait orchestrator ready-pr --pr 456` to mark it ready and synchronize the Project. Marking the PR ready allows GitHub Actions to validate it. Review waits for the configured CI checks on its current head, and humans still approve and merge. Publishing is limited to the claimed issue branch and configured writable paths; no force-push, merge, or release command is supplied to agents.

For workflow file changes in `rodush/grait`, the push command checks independent Green for the exact head and uses the configured workflow-capable `GH_TOKEN` for that issue branch. The Writer App handles PR creation and ordinary pushes. See [GRAIT's source repository write scope](grait-development.md#source-repository-write-scope).

## Review publication

Assign the exact PR head and trusted policy to the separate local reviewer. GitHub is the shared review record: the reviewer must publish a readable formal decision and inline findings on the remote PR, not merely return a local report. The parent passes a structured payload to the identity-scoped publisher, for example:

```json
{
  "version": 1,
  "pr": 456,
  "head": "EXACT_40_CHARACTER_PR_HEAD_SHA",
  "round": 1,
  "verdict": "REQUEST_CHANGES",
  "blockers": ["src/parser.mjs:parse:empty-input"],
  "rethink": false,
  "conflicts": false,
  "body": "Explain the concrete defect and evidence.",
  "comments": [
    {
      "path": "src/parser.mjs",
      "line": 12,
      "side": "RIGHT",
      "body": "P1 [src/parser.mjs:parse:empty-input]: explain this finding."
    }
  ]
}
```

Use APPROVE with no blockers/rethink/conflicts for a complete clean review; COMMENT for incomplete evidence or human judgment. Inline comments must reference actual diff lines; `LEFT` is for deletions, `RIGHT` for additions/current code. The review skill defines severity and stable IDs.

```sh
grait orchestrator review --pr 456 --file /dev/stdin
```

Supply the JSON payload above on standard input and close the input stream. Hosts without `/dev/stdin` can use `--file PATH` with a temporary transport file. The JSON carries exact-head/round metadata for validation; testers and fixers read the published GitHub conversation directly and do not need that file.

Run `grait github checks --pr N` to see the current head SHA, readiness, and check names, publisher IDs, statuses, conclusions, and run links. The `required` list shows each configured check, including any with a `missing` status. In `workflow.config.json`, list each required GitHub Check Run under `ci.requiredChecks` as an object with its exact `name` and the positive numeric publisher `appId` returned by GitHub's Check Runs API. Configure jobs to run full project validation and report on the PR head. Existing configurations without this list keep their existing GitHub merge protections. Configured checks must complete with the `success` conclusion. Missing, pending, skipped, failed, and older-head runs keep review waiting, and the latest run ID for each configured name and publisher takes precedence. Open the affected run link and read its annotations or the failing step excerpt when investigating.

For a setup/migration PR that must satisfy existing active agent-review rules before the new host is activated, a configured human operator can explicitly publish its locally evaluated review with `grait orchestrator review --setup-review --pr N --file PATH`. This permits only the reviewer publishing operation during staged setup; it never enables claims, implementation, or a fix loop. Existing issue/PR pause state and lifetime limits still apply. Use ordinary review publication after activation.

The publisher uses the reviewer App, verifies the actual GitHub review identity/head/decision, and records lifetime history. Only a valid approval makes the writer's `Agent review` status succeed for that exact SHA. A new head needs a new review. Humans still approve and squash merge.

### Follow-up conversation and resolution

Read reviews and inline comments from GitHub, for example:

```sh
gh pr view 456 --repo OWNER/REPOSITORY --json reviews,comments
gh api --paginate repos/OWNER/REPOSITORY/pulls/456/comments
```

Use the PR UI or GitHub's GraphQL review-thread API to inspect thread resolution state; the REST comments list alone does not show whether a thread is resolved. Keep corrections and verification in the original threads, with stable finding IDs, fix commits, and test evidence. Publish fix replies through the configured writer identity. After the independent reviewer verifies the current head, record that verification and mark the agent's thread Resolved using an authorized reviewer session in the PR UI/API. Leave human objections for their author or a maintainer to resolve. Never treat a push or an outdated diff as resolution, delete earlier findings, or claim a thread is resolved when the remote state remains open. If the current publishing tool cannot perform a reply or resolution, leave that action pending for an authorized session and report it explicitly; do not borrow another identity or broaden publishing permissions.

A `fix` decision starts another tester-first cycle in the same issue worktree. A `rethink` decision first needs an In Progress slot:

```sh
grait orchestrator next --issue 123 --pr 456
```

Stop if the command reports `pause`; do not reset its history. After a human merges:

```sh
grait orchestrator sync --pr 456
```

Only a merged, issue-linked PR completes the story. A closed unmerged PR needs triage/human judgment. Clean up task-owned worktrees only after confirmed human merge and released ownership.

## Pause and recovery

Add `agent:paused` to an issue/PR, or set repository variable `AUTOMATION_ENABLED=false` to stop local commands. A running native agent must be stopped in its harness as well; labels cannot terminate an OS process instantly. Revoke App keys/installations for an immediate credential incident.

The ledger preserves review rounds, exact heads, claims, pending intentions, and stop reasons. Duplicate/malformed state and uncertain external writes fail closed. A human reconciles the actual branch, PR, review, and Project before resuming; never delete/reset a ledger to make a command pass. Legacy pending hosted operations must be stopped and their evidence reconciled during migration. The ten-round lifetime cap survives restarts and ordinary author pushes.

For a test correction use the explicit [handoff](tdd.md#test-corrections). For interrupted setup, a failed configuration push, or host migration follow [installation recovery](installation.md#resume-remote-hosts-and-credentials). A lock in `<git-common-dir>/grait-setup/lock` is exclusive. Inspect it and confirm its recorded process has stopped before removing a stale lock.

If a claimed story's writer publication was interrupted, preserve the clean committed worktree and compare its head with the remote issue branch. Check for a PR before retrying creation:

```sh
git ls-remote origin refs/heads/agent/issue-123
gh pr list --repo OWNER/REPOSITORY --head agent/issue-123 --state all
```

If the branch is absent, retry `grait github push --issue 123` from the assigned worktree. If the remote branch matches the accepted head and no PR exists, rerun the original `grait github pr` command. If a matching PR already exists, continue with `grait orchestrator sync --pr 456` using its PR number. Have an operator reconcile a different remote head or an unexpected PR state before retrying.

## Dependency updates

In the GRAIT source repository, Dependabot updates the deterministic Actions and npm lockfile. Keep action references SHA-pinned with a readable release comment and choose stable releases at least three days old. Treat dependency PRs like any other admitted contribution and apply the same CI, review, and human merge gates. Adopted applications update the GRAIT pin through the [upgrade workflow](installation.md#upgrade-an-existing-grait-installation).

## Optional releases

The GRAIT source repository includes a deterministic, manual `release.yml` for maintainers. Packaged installation supplies GRAIT validation, and application owners manage their own release workflow. To configure the source repository's optional release workflow, give a dedicated release App contents write access, set `RELEASE_APP_CLIENT_ID` and `RELEASE_APP_ID`, and store its key only as `RELEASE_APP_PRIVATE_KEY` in the protected `release` environment. Register its numeric App ID as the sole integration allowed to create `v*` tags in the **Release tag creation** ruleset. Keep **Immutable release tags** active, prohibiting updates and deletion without bypass. Existing integrations can use the human-only token mode.

A configured human operator requests a version from the default branch:

```sh
gh workflow run release.yml -f version=v1.2.3
```

The environment requires human approval. The script requires successful CI on the current default head, creates a new immutable tag, and publishes the release. Agents never dispatch this workflow. It uses no model, provider key, or subscription allowance. Application deployment is project-specific.

# Operations

Complete [installation and activation](installation.md) first. Use one host per Project. The parent runs in the official harness; deterministic commands coordinate GitHub state and do not call models.

## Start and inspect

```sh
npm run orchestrator -- start
npm run orchestrator -- status
```

The default is two concurrent workers. Native harness sessions are not an unlimited background service: subscription limits, permission prompts, or human/CI waits may stop progress. Save committed handoffs and continue from the recorded state rather than starting duplicate work. There is no automatic API-billing fallback.

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

Compute the digest with `issueDigest` from `scripts/lib/policy.mjs` using the current API issue object (`number`, `title`, `body`); never guess it from copied text. Blocker references use `owner/repository#N` and must exactly match native GitHub blockers. An exemption uses `"tdd": {"required": false, "reason": "Concrete reason testing is inapplicable"}`. An outsider needs maintainer admission via `agent:admitted` unless current write access or configured identity makes them trusted.

```sh
npm run orchestrator -- ready --issue 123 --file /tmp/triage.json
npm run orchestrator -- claim --issue 123
npm run orchestrator -- worktree --issue 123
```

Any unarchived Project story in Review blocks admission of a new story, including Review work awaiting humans or external dependencies. Finish or resolve that work first; existing claims, review/fix stages, and redesign under an existing claim may continue. The five-story limit is a ceiling, not a target to fill.

The command reserves In Progress before work. Repeated accepted claims return the same issue branch. Fresh scope/dependencies and the five-story cap are checked; inaccessible active items count against capacity. The worktree command prints the assigned absolute path and head. Give that path, acceptance digest, committed SHA, scope, and next owner to each specialist.

## Tester-first implementation and publishing

Follow [TDD](tdd.md) for the committed Red/Green handoffs. The parent may delegate natively using the assigned worktree, or start a native specialist session there:

```sh
npm run orchestrator -- worker --issue 123 --role test
```

Run verification/publishing from the assigned issue worktree. Only one role may own it at a time. After accepted implementation and Green:

```sh
npm run github -- push --issue 123
npm run github -- pr --issue 123 --title 'feat: implement accepted behavior' --body-file /tmp/pr-body.md
```

The PR starts as a draft with `Closes #123`. Include actual validation evidence and risks in its body. After the exact PR head has accepted Green (or a reasoned triage exemption):

```sh
npm run orchestrator -- ready-pr --pr 456
```

This marks it ready and synchronizes the Project. Publishing is limited to the claimed issue branch and configured writable paths; no force-push, merge, or release command is supplied to agents.

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
npm run orchestrator -- review --pr 456 --file /dev/stdin
```

Supply the JSON payload above on standard input and close the input stream. Hosts without `/dev/stdin` can use `--file PATH` with a temporary transport file. The JSON carries exact-head/round metadata for validation; testers and fixers read the published GitHub conversation directly and do not need that file.

For a setup/migration PR that must satisfy existing active agent-review rules before the new host is activated, a configured human operator can explicitly publish its locally evaluated review with `npm run orchestrator -- review --setup-review --pr N --file PATH`. This permits only the reviewer publishing operation during staged setup; it never enables claims, implementation, or a fix loop. Existing issue/PR pause state and lifetime limits still apply. Use ordinary review publication after activation.

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
npm run orchestrator -- next --issue 123 --pr 456
```

Stop if the command reports `pause`; do not reset its history. After a human merges:

```sh
npm run orchestrator -- sync --pr 456
```

Only a merged, issue-linked PR completes the story. A closed unmerged PR needs triage/human judgment. Clean up task-owned worktrees only after confirmed human merge and released ownership.

## Pause and recovery

Add `agent:paused` to an issue/PR, or set repository variable `AUTOMATION_ENABLED=false` to stop local commands. A running native agent must be stopped in its harness as well; labels cannot terminate an OS process instantly. Revoke App keys/installations for an immediate credential incident.

The ledger preserves review rounds, exact heads, claims, pending intentions, and stop reasons. Duplicate/malformed state and uncertain external writes fail closed. A human reconciles the actual branch, PR, review, and Project before resuming; never delete/reset a ledger to make a command pass. Legacy pending hosted operations must be stopped and their evidence reconciled during migration. The ten-round lifetime cap survives restarts and ordinary author pushes.

For a test correction use the explicit [handoff](tdd.md#test-corrections). For interrupted setup, a failed configuration push, or host migration follow [installation recovery](installation.md#resume-remote-hosts-and-credentials). A lock in `<git-common-dir>/grait-setup/lock` is exclusive; stop its owning process and inspect it before manually removing a stale lock. Locks are local to that Git common directory; never coordinate the same Project from two independent clones/hosts.

## Dependency updates

Dependabot updates the hand-maintained deterministic Actions and npm lockfile. There are no generated Actions locks or compiler pin to reconcile. Keep action references SHA-pinned with a readable release comment; choose stable releases at least three days old. Treat dependency PRs like any other admitted contribution and apply the same CI/review/human merge gates.

## Optional releases

Release publication is separate from AI execution and is not required for initial activation. The included `release.yml` is deterministic and manual. Configure a dedicated release App with contents write, set `RELEASE_APP_CLIENT_ID`/`RELEASE_APP_ID`, and store its key only as `RELEASE_APP_PRIVATE_KEY` in the protected `release` environment. Register its numeric App ID as the sole integration allowed to create `v*` tags in the **Release tag creation** ruleset. Keep **Immutable release tags** active, prohibiting updates/deletion without bypass. Human-only token mode is available only for existing deliberate release integrations; default publishing identities use Apps.

A configured human operator requests a version from the default branch:

```sh
gh workflow run release.yml -f version=v1.2.3
```

The environment requires human approval. The script requires successful CI on the current default head, creates a new immutable tag, and publishes the release. Agents never dispatch this workflow. It uses no model, provider key, or subscription allowance. Application deployment is project-specific.

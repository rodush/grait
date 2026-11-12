# Operating the workflow

## Observe work

Use the GitHub Project for status, issue comments for triage and claims, and PR inline reviews for findings. Controller state comments include pending operation IDs, previous rounds, and stop reasons. Actions logs provide execution details; do not use them as the only place to record a review finding.

The schedule is a recovery path, so transitions may take several minutes. GitHub may delay scheduled runs. Capacity is released when an issue moves from In Progress to Review; ordinary follow-up fixes stay in Review. A redesign waits for an available In Progress slot.

## Local work

```sh
gh workflow run controller.yml -f task=claim-local -f number=123
```

Only configured human operators may request a local claim. A local agent starts after the controller publishes a successful claim. Keep the issue's acceptance criteria current and open a PR with `Closes #123`. A local agent may work autonomously within that claim; hosted review still happens through GitHub Actions.

## Pause and resume

Add `agent:paused` to the issue or PR to stop scheduling work. The controller requests cancellation of an active run when it observes the pause; cancellation can race an already-running safe output. For an immediate incident response, disable the agent workflows or revoke credentials as well.

Inspect the latest findings, operation, and commits when `agent:needs-human` appears. After resolving the cause:

```sh
gh workflow run controller.yml -f task=resume -f number=456
```

Resume preserves the lifetime round count and starts a new oscillation-detection window. Apply a new revision before asking for another review. If both the issue and PR are paused, reconcile and resume each explicitly. Ten completed reviews remain the maximum: additional changes need human review rather than resetting automation state.

If the issue's scope or blockers changed, update its description, then request fresh triage:

```sh
gh workflow run controller.yml -f task=triage -f number=123
```

Pause or finish any active workflow first. Existing native dependencies are preserved; remove an obsolete blocker explicitly in GitHub before retriage. A dependency closed as not planned does not unblock implementation automatically.

## Failure recovery

- **Dispatch uncertain:** inspect Actions for the operation ID before resuming. Avoid duplicate implementation.
- **Implementation without a PR:** inspect protected-file restrictions, allowed paths, and engine output. The issue retains its slot until reconciled.
- **Expired credentials:** refresh the corresponding secret and resume after confirming no run is still active.
- **Malformed or stale review metadata:** inspect the formal review and recorded head. Never treat an old-head approval as evidence for new changes.
- **PR closed without merge:** re-triage or decide its disposition manually; automation does not mark it Done.
- **Local claim abandoned:** confirm the agent has stopped, then re-triage the issue. A claim does not expire silently while an agent could still be working.

Never delete ledgers to reset a stopped loop. They provide the durable budget and audit trail.

## Releases and maintenance

After a human squash merge and successful default-branch CI:

```sh
gh workflow run release.yml -f version=v1.2.3
```

The configured human operator approves the release environment. The workflow tags the current default-branch commit and publishes GitHub-generated release notes. Update application version files through a PR before releasing when the chosen stack requires them. GRAIT includes an MIT license; configure the maintainer contact when adopting the template.

Dependabot opens changes for Actions and npm tooling. Review compiler upgrades deliberately, regenerate workflows, and inspect changes to actions and secrets before approving the new manifest. Enable private vulnerability reporting, secret scanning, push protection, and dependency alerts where available.

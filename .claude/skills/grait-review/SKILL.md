---
name: grait-review
description: Request, inspect, or perform PR review through GRAIT's authorized GitHub Actions workflow. Local use dispatches or observes hosted review and does not evaluate code locally.
---

# Route GRAIT PR review

Review evaluation runs only in the controller-authorized GitHub Actions review workflow. Findings and formal decisions belong in the PR UI.

## Local harness

Identify the PR and its current head. Inspect the controller ledger, hosted run status, and already-published findings. If a current review is missing and the operator authorized a review, request controller reconciliation once:

```sh
gh workflow run controller.yml -f task=reconcile
```

Wait for or report the hosted run's state. Do not analyze the diff locally, produce local code-review findings, submit a local approval, or dispatch `review.lock.yml` directly. A paused or exhausted loop needs the operator's decision; repeated dispatches cannot reset it.

## Authorized hosted workflow

Apply the [review policy](../../../docs/review-guidelines.md) and [hosted review contract](../../../automation/prompts/review.md) to the exact requested head. Read contributor code through GitHub APIs without executing it. Publish actionable inline findings and one formal review with stable finding IDs and matching controller metadata. A stale head, missing evidence, or conflicting instructions cannot authorize a merge.

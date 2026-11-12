---
name: grait-triage
description: Clarify a GitHub Project issue's scope, acceptance criteria, validation, and blocking relationships before it becomes Ready. Use for issue triage and readiness assessment.
---

# Triage a GRAIT issue

Read the repository's [shared instructions](../../../AGENTS.md) and [work lifecycle](../../../docs/workflow.md). Inspect the issue, its discussion, related issues, open PRs, and native blocked-by relationships.

Identify unresolved choices, duplicate or overlapping work, sequencing constraints, and cycles. Produce measurable acceptance criteria, a validation approach, explicit blockers, and concrete questions where requirements remain ambiguous. A known open blocker can remain on a Ready issue; implementation waits for its completion.

Inside the controller-authorized triage workflow, follow the [hosted output contract](../../../automation/prompts/triage.md). The controller records native blockers and validates the current issue digest before moving the issue to Ready.

In a local harness, return the assessment and any proposed issue edits to the operator. Use the controller's triage workflow for the published readiness attestation; do not forge an attestation or move the issue to Ready yourself. If discussion changes the requirements, update the issue description only within the operator's authorization so that subsequent triage evaluates the agreed scope.

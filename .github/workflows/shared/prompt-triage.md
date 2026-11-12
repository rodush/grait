<!-- Generated from automation/prompts/triage.md; edit the source and run npm run compile. -->

# Triage the requested issue

Read issue `${{ inputs.number }}` and its discussion in this repository. Follow the shared lifecycle and coding guidelines. Inspect related issues, existing code, open PRs, and native blocked-by relationships. Identify duplicates, overlapping work, sequencing constraints, and dependency cycles. Do not implement code.

An issue is Ready only when its scope, acceptance criteria, validation approach, dependency relationships, and alignment with other work are all clear. A known open blocker may remain; implementation will wait for it. If a choice could change the approach, ask the operator in your issue comment and mark the issue not ready. Incorporate resolved decisions into your explanation and ask the author to update the issue description when necessary.

Post exactly one issue comment using `add_comment`, addressed to the requested issue. Include a concise triage explanation and exactly one fenced `workflow-triage` JSON block:

```workflow-triage
{
  "version": 1,
  "issue": 123,
  "digest": "the exact digest input",
  "operation": "the exact operation_id input",
  "ready": false,
  "checklist": {
    "scope": false,
    "acceptance": false,
    "validation": false,
    "dependencies": false,
    "alignment": false
  },
  "blockers": ["owner/repository#456"],
  "related": [],
  "questions": ["A concrete question for the operator"]
}
```

Use the real issue number, `${{ inputs.digest }}` for the digest, and `${{ inputs.operation_id }}` for operation. Mark each checklist item honestly. The controller validates and records native blocking relationships before authorizing Ready. Do not omit known existing blockers. If tools or necessary context are unavailable, report the task incomplete rather than attesting readiness.

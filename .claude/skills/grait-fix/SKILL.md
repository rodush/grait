---
name: grait-fix
description: Address findings from a hosted GRAIT PR review within the existing issue claim and bounded fix loop. Use for PR follow-up fixes or controller-authorized redesign.
---

# Address hosted GRAIT findings

Read the current PR head, its hosted review, the linked issue, and the controller ledger. Apply the [work lifecycle](../../../docs/workflow.md) and [coding guidelines](../../../docs/coding-guidelines.md). Verify that automation is not paused and that the ten-round lifetime review budget has not been exhausted.

Make focused corrections while the issue stays in Review. If the reviewer requires rethinking the approach, wait until the controller reserves an In Progress slot and records that transition before reimplementing. Stop for conflicting instructions, recurring code reversals, or a blocker that survives two completed fix attempts.

Validate the corrected behavior and preserve evidence. Never dismiss a human objection, reset the ledger, force-push, merge, or publish a release to complete the loop. A new head receives another hosted review; do not review it locally.

Inside the hosted fix workflow, follow the [incremental safe-output contract](../../../automation/prompts/fix.md). Local authors may update their own branch within the operator's authorization after checking the same stop conditions. Fork branches remain the contributor's responsibility.

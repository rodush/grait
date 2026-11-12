# Implement the claimed issue

Implement issue `${{ inputs.number }}`. The controller has reserved its In Progress slot. Read the issue, triage discussion, native dependencies, and relevant project code. Follow AGENTS.md and its linked policies. If requirements remain ambiguous or the issue has changed, report incomplete and explain the decision needed in an issue comment.

Work only on the issue's accepted outcome and within the configured safe-output write paths. Use the existing stack and its commands. Run meaningful checks, add behavioral regression coverage when appropriate, and update relevant documentation. For a project without an application stack, ask for a stack choice rather than choosing a framework.

Create one ready PR through `create_pull_request` on branch `issue-${{ inputs.number }}`; the configured prefix produces `agent/issue-${{ inputs.number }}`. Use a Conventional Commit title. Include `Closes #${{ inputs.number }}`, outcome, validation evidence, and relevant risks. Set the PR ready only after the work is ready for review. Never merge or publish a release. Use safe outputs for writes; do not push directly or change authentication.

If the task requires protected automation, instruction, or configuration files outside your write scope, report the limitation and ask for human handling. Do not work around the policy or weaken checks.

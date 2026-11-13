---
name: Agent developer
strict: true
timeout-minutes: 20
permissions:
  contents: read
  issues: read
  pull-requests: read
  actions: read
run-name: ${{ inputs.operation_id }}
concurrency:
  group: agent-${{ github.workflow }}-${{ inputs.number }}
  cancel-in-progress: false
  job-discriminator: ${{ github.run_id }}
on:
  workflow_dispatch:
    inputs:
      number: { type: string, required: true }
      digest: { type: string, required: true }
      head: { type: string, required: true }
      pr: { type: string, required: true }
      cycle: { type: string, required: true }
      operation_id: { type: string, required: true }
imports:
  - shared/runtime.md
  - shared/runtime-implementer.md
  - shared/writer-auth.md
  - shared/developer-output.md
  - shared/authorize.md
  - shared/policy-agents.md
  - shared/policy-coding.md
  - shared/policy-workflow.md
  - shared/prompt-develop.md
  - shared/skill-grait-develop.md
checkout:
  ref: ${{ inputs.head }}
  fetch-depth: 0
  fetch: ["*"]
tools:
  github:
    toolsets: [repos, issues, pull_requests]
    min-integrity: none
  bash: ["*"]
  edit:
safe-outputs:
  add-comment:
    max: 1
    target: ${{ inputs.number }}
    pull-requests: false
---

Follow the imported TDD role and handoff contracts. Never merge or release.

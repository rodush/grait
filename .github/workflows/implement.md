---
name: Agent implementation
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
      number:
        type: string
        required: true
      digest:
        type: string
        required: true
      operation_id:
        type: string
        required: true
imports:
  - shared/runtime.md
  - shared/writer-auth.md
  - shared/implementation-output.md
  - shared/authorize.md
  - shared/policy-agents.md
  - shared/policy-coding.md
  - shared/policy-workflow.md
  - shared/prompt-implement.md
  - shared/skill-grait-implement.md
checkout:
  ref: ${{ github.event.repository.default_branch }}
  fetch-depth: 0
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

# Hosted issue implementation

Follow the imported shared policies and implementation prompt.

---
jobs:
  authorize:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    permissions:
      contents: read
      issues: read
      pull-requests: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: ${{ github.event.repository.default_branch }}
          persist-credentials: false
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
        with:
          node-version: "24"
      - name: Verify controller authorization
        env:
          GH_TOKEN: ${{ github.token }}
          AUTOMATION_ENABLED: ${{ vars.AUTOMATION_ENABLED }}
          AUTOMATION_BUDGET_ISSUE: ${{ vars.AUTOMATION_BUDGET_ISSUE }}
          AUTOMATION_BUDGET_LOGIN: ${{ vars.AUTOMATION_BUDGET_LOGIN }}
          AUTOMATION_LOGIN: ${{ vars.AUTOMATION_LOGIN }}
        run: node scripts/authorize.mjs
  agent:
    if: github.run_attempt == 1
    needs: [authorize]
  detection:
    if: github.run_attempt == 1
  safe_outputs:
    if: github.run_attempt == 1
  conclusion:
    if: github.run_attempt == 1
safe-outputs:
  needs: [authorize]
---

# Controller authorization

Only the designated controller may schedule work. A dispatch must match its durable operation record.

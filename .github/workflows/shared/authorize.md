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
      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6
        with:
          ref: ${{ github.event.repository.default_branch }}
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
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

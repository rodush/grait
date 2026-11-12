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
      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6
        with:
          node-version: "24"
      - name: Verify controller authorization
        env:
          GH_TOKEN: ${{ github.token }}
          AUTOMATION_ENABLED: ${{ vars.AUTOMATION_ENABLED }}
          AUTOMATION_LOGIN: ${{ vars.AUTOMATION_LOGIN }}
        run: node scripts/authorize.mjs
  agent:
    needs: [authorize]
safe-outputs:
  needs: [authorize]
---

# Controller authorization

Only the designated controller may schedule work. A dispatch must match its durable operation record.

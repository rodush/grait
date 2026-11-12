# Workflow decisions

| Decision            | Selected policy                                                                      |
| ------------------- | ------------------------------------------------------------------------------------ |
| Scope               | Generic template; no application language or framework                               |
| Shared instructions | `AGENTS.md` and linked policy documents; small harness adapters                      |
| Engines             | Codex by default; Claude and GitHub Copilot selectable                               |
| Work location       | Local and GitHub-hosted implementation; hosted PR review                             |
| Review trigger      | Every ready PR opening and subsequent head update                                    |
| Review authority    | Formal agent decisions; human approval and final merge                               |
| Fix loop            | Automatic; ten rounds maximum; interrupt reversals, repeated blockers, and conflicts |
| Work source         | Triaged GitHub issues in GitHub Projects                                             |
| Readiness           | Triage agents may authorize Ready                                                    |
| Board               | Backlog → Ready → In Progress → Review → Done                                        |
| Capacity            | Five stories In Progress across the project; Review excluded                         |
| Follow-up fixes     | Stay in Review; redesign returns to In Progress after acquiring capacity             |
| Contributions       | Public forks and private repositories                                                |
| Authentication      | GitHub Apps preferred for organizations; supplied tokens also supported              |
| Git history         | Conventional Commits and human squash merges                                         |
| Releases            | Explicit operator-triggered release workflow                                         |
| Ownership           | Configured by the operator when adopting the template                                |
| License             | MIT, as selected in the GRAIT repository                                             |

## Implementation boundaries

The controller enforces scheduling and review-loop limits in code. Agent prompts explain the policy but do not implement counters or locks. One controller is required per project because GitHub Actions concurrency groups are repository-scoped.

Public fork review reads code through GitHub APIs without executing it. Automatic fixes to arbitrary forks require a separate contribution design and are not part of the initial writer. A fork author remains able to apply fixes and receive a new review.

External configuration is applied by an operator after reviewing the bootstrap plan. This template cannot provide repository identities, account credentials, or hosted execution evidence before a derived repository is configured.

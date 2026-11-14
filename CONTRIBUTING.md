# Contributing

Read [AGENTS.md](AGENTS.md), the [coding guidelines](docs/coding-guidelines.md), and the [workflow](docs/workflow.md).

## Pick up work

All implementation starts with an issue in the GitHub Project. A Ready issue must describe the outcome, acceptance criteria, validation, and dependencies without unresolved ambiguity. The local orchestrator serializes claims on its designated host; do not move an issue into In Progress yourself. All agents run in the user's harness.

Use `npm run orchestrator -- claim --issue 123` to request a claim. Wait for its accepted state before starting. Use one orchestrator host per Project.

## Make a change

Use a separate worktree for the coordinator and unrelated sub-agents; tester and implementer for the same issue share one worktree and branch with sequential exclusive ownership; follow the [handoff and cleanup protocol](docs/worktrees.md). Use an isolated branch such as `feat/123-short-description` or `fix/123-short-description`. Keep one issue's outcome per PR. Follow the existing language's conventions and add the smallest meaningful regression tests for changed behavior. Update documentation and example configuration when behavior changes.

Template tooling requires Node.js 24 and npm locally. These commands validate GRAIT’s repository automation; application build and run commands are defined separately when a stack is added. See [GRAIT development](docs/grait-development.md) for scope, prerequisites, and regeneration rules.

Template tooling commands:

```sh
npm ci
npm run check
npm test
npm run format:check
npm run lint:md
```

Record application-specific install, build, lint, test, and local-run commands when introducing a stack. Do not invent successful validation results for commands that could not run.

## Open and finish a PR

Use a Conventional Commit PR title, such as `feat(api): add health endpoint` or `fix(parser): reject empty input`. Link the issue using `Closes #123`. Explain behavior, validation, risks, and any migration; attach screenshots for visual changes.

The separate local reviewer publishes findings and its formal decision in the PR. Follow-up fixes stay in Review. A substantial approach change returns the issue to In Progress through the orchestrator and consumes a slot. If none is available, work pauses in Review until capacity is available.

Only a human may squash merge after required checks, current agent review, and human approval pass. A stopped loop requires human investigation; pushing another commit does not reset its budget.

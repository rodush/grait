# Contributing

Read [AGENTS.md](AGENTS.md), the [coding guidelines](docs/coding-guidelines.md), and the [workflow](docs/workflow.md).

## Pick up work

All implementation starts with an issue in the GitHub Project. A Ready issue must describe the outcome, acceptance criteria, validation, and dependencies without unresolved ambiguity. The controller claims work atomically; do not move an issue into In Progress yourself. Local agents use the same claim process as hosted agents.

Use `gh workflow run controller.yml -f task=claim-local -f number=123` to request a local claim. Wait for the controller's successful claim comment before starting. Hosted implementation is picked up automatically from Ready.

## Make a change

Use an isolated branch such as `feat/123-short-description` or `fix/123-short-description`. Keep one issue's outcome per PR. Follow the existing language's conventions and add the smallest meaningful regression tests for changed behavior. Update documentation and example configuration when behavior changes.

Template tooling requires Node.js 24 and npm locally. These commands validate GRAIT’s repository automation; application build and run commands are defined separately when a stack is added. See the [runtime and command reference](docs/setup.md#repository-tooling-runtime) for prerequisites and regeneration rules.

Template tooling commands:

```sh
npm ci
npm run check
npm test
npm run format:check
npm run lint:md
npm run compile
```

Record application-specific install, build, lint, test, and local-run commands when introducing a stack. Do not invent successful validation results for commands that could not run.

## Open and finish a PR

Use a Conventional Commit PR title, such as `feat(api): add health endpoint` or `fix(parser): reject empty input`. Link the issue using `Closes #123`. Explain behavior, validation, risks, and any migration; attach screenshots for visual changes.

The Actions reviewer publishes findings in the PR. Follow-up fixes stay in Review. A substantial approach change returns the issue to In Progress through the controller and consumes a slot. If none is available, work pauses in Review until capacity is available.

Only a human may squash merge after required checks, current agent review, and human approval pass. A stopped loop requires human investigation; pushing another commit does not reset its budget.

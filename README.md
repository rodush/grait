# GRAIT

**GitHub Repository for AI Tooling** — Great engineering, augmented by AI.

An opinionated, language-neutral starter for engineering with local AI agents and GitHub PRs. Your **Codex CLI or Claude Code session is the orchestrator**. It delegates specialist agents on your machine or your own remote host, using the harness's native subscription login. Changes move from local worktree branches to GitHub PRs. GitHub runs deterministic CI; humans approve, merge, and release.

**Start with the [installation and configuration guide](docs/installation.md): [new repository](docs/installation.md#new-repository), [existing repository](docs/installation.md#existing-repository), [upgrade](docs/installation.md#upgrade-an-existing-grait-installation), or [someone else's repository](docs/installation.md#ownership-and-access).**

## Quick start

Install Git, Node.js 24 with npm, GitHub CLI, and either Codex CLI or Claude Code. Sign in to GitHub with `gh auth login`, then run from your clone:

```sh
npm run setup -- --plan
npm run setup
```

Setup guides native harness login and the two GitHub App approvals, creates or reuses a Project, preserves application ownership rules, installs native roles, and prepares a validated configuration PR. The App keys stay in private Git metadata on your host. After a human merges the PR and default-branch CI passes:

```sh
git switch main
git pull --ff-only
npm run setup -- --activate
npm run orchestrator -- start
```

Use your repository's actual default branch if it differs from `main`. Choose Claude with `npm run setup -- --harness claude`; Codex is the default. The [guide](docs/installation.md) explains administrator access, existing identities, remote hosts, and interrupted setup.

## What you get

| Component                                                 | Purpose                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [Orchestrator and specialists](docs/agents.md)            | Native Codex/Claude roles for coordination, triage, testing, implementation, review, and fixes  |
| [Shared engineering policy](AGENTS.md)                    | Language-neutral conventions, scoped changes, and human authority                               |
| [Project workflow](docs/workflow.md)                      | Backlog → Ready → In Progress → Review → Done, native blockers, and at most five active stories |
| [Worktrees and tester-first delivery](docs/tdd.md)        | Separate orchestrator checkout, sequential tester/implementer ownership, independent validation |
| [PR review](docs/review-guidelines.md)                    | Separate publishing identity, inline findings, formal decisions, and bounded fix loops          |
| [Deterministic CI](.github/workflows/ci.yml)              | Configuration, generated-adapter drift, tests, formatting, and Markdown checks                  |
| [Operator releases](docs/operations.md#optional-releases) | Optional deterministic release workflow with human approval                                     |

## Subscription and execution

Use the official harness with your own eligible subscription. Native sub-agents share its usage allowance; the default is two concurrent workers. GRAIT does not request provider API keys, run AI agents in GitHub Actions, or supply a separate LLM service. Model inference still uses the provider's servers. See [subscription setup](docs/setup.md#subscription-authentication).

GitHub Apps identify **who publishes**, independently of where agents execute. One writer App pushes branches and opens PRs; one reviewer App publishes reviews. Tester and implementer do not need separate GitHub accounts. Neither App receives permission to bypass human merge gates.

## Maintain the starter

GRAIT's automation uses Node.js 24; your application may use any language. Edit canonical roles under `automation/`, then run:

```sh
npm ci
npm run harness:generate
npm run check
npm test
npm run format:check
npm run lint:md
```

Read [setup](docs/setup.md) for configuration, [operations](docs/operations.md) for commands and recovery, and [CONTRIBUTING.md](CONTRIBUTING.md) for changes. Existing installations should follow the migration guide before enabling the local orchestrator.

## License

[MIT](LICENSE).

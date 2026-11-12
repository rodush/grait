# Architecture

## Shared policy and engine adapters

`AGENTS.md`, `docs/`, and `automation/prompts/` are canonical. Harness adapters reference them. `scripts/compile.mjs` generates shared Markdown under `.github/workflows/shared/` because gh-aw imports are confined to `.github`, then compiles the four agent workflows into executable `.lock.yml` files. The source and generated files are committed together; CI checks drift.

`workflow.config.json` selects the engine, authentication mode, write paths, statuses, and hard limits. `config/codex.toml` supplies the local Codex settings and hosted model/reasoning defaults. The compiler uses CLI configuration arguments for hosted reasoning because the pinned compiler's inline TOML rendering does not produce valid YAML for that setting.

## Controller and persistence

The deterministic Actions controller polls every five minutes and responds to issue, PR, and workflow-completion events. All instances share a repository-scoped concurrency group. The project description binds the board to one controller repository; a conflicting binding stops execution. This baseline schedules its own repository's stories and counts In Progress stories across the entire project.

Controller state is stored in a visible comment on each issue and PR. State includes triage digests, operation IDs, pending work, reviewed head SHAs, stable findings, patch fingerprints, and stop reasons. Only comments from the configured writer identity are accepted. Duplicate ledgers or malformed data stop automatic work.

A claim changes Project Status before dispatch. Dispatch intent is persisted before contacting the API. An uncertain dispatch is paused for inspection rather than retried blindly. Each dispatched workflow independently validates its operation against the ledger before an agent starts. Scheduled reconciliation handles events lost through queue replacement or workflow-chain limits.

## Review and fix boundaries

The reviewer has no shell or contributor checkout. It reads GitHub content with a read-only token and emits inline comments and a formal review through reviewer-authenticated safe outputs. The controller checks metadata against the publisher, operation ID, round, GitHub review state, and commit ID before updating the `Agent review` commit status.

The writer runs code and tests inside gh-aw's sandbox. Its write credential is used only by safe-output jobs. Allowed paths constrain changes; protected policy and automation files are blocked. Application CI executes PR code with a read-only token and no repository secrets. Public fork PRs use the same API-based hosted review, but their branches are never pushed to automatically.

## Human authority

Two independent rulesets enforce delivery checks and human merge authority. Only named human users may update the default branch through a PR, and they cannot bypass the independent checks and human code-owner approval. There is no agent merge safe output or automatic release path. A release requires a configured human operator, successful default-branch CI, and the release environment's approval.

## Operational limits

The controller cannot prevent a project administrator from manually exceeding WIP. Restrict direct status changes and route all claims through the controller. One controller per project is essential; copying the scheduler into several repositories does not create a cross-repository lock. Scope this baseline to one repository's automatic dispatches, or extend the central controller before automating more repositories on the same board.

Local agents must wait for a confirmed claim and honor pause state. Hosted sandboxing, GitHub rules, and credentials provide technical boundaries; prose instructions alone do not constrain an independently configured local harness.

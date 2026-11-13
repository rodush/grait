# Recorded decisions

| Area            | Decision                                                                                                                  |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Execution       | All AI roles run in the user's native Codex CLI, Claude Code, or GitHub Copilot CLI harness, locally or on their own host |
| Provider access | Use the official harness's subscription login; no LLM API keys or hosted agent workflows in the default setup             |
| Orchestration   | A parent session delegates specialists; deterministic local tools enforce Project claims and review-loop state            |
| Concurrency     | Two workers by default; at most five In Progress stories across the Project; one orchestrator host per Project            |
| Identity        | Two repository-owned GitHub Apps separate writer and reviewer publishing; roles share the user's provider allowance       |
| Validation      | Tester-first local handoffs and independent Red/Green evidence; deterministic GitHub CI remains required                  |
| Review          | Local exact-head evaluation, inline GitHub findings, formal review, and at most ten lifetime rounds                       |
| Delivery        | Human code-owner approval and squash merge; optional operator-approved releases                                           |
| Platform        | GitHub issues, native blockers, Projects, PRs, reviews, rulesets, and deterministic Actions                               |
| Tooling         | Node.js 24 for starter tooling; application language remains unconstrained                                                |

The previous hosted-agent design required provider keys, workflow compilation, and generated lockfiles. It was removed to make the opinionated default use the consumer's existing coding subscription and host. No implicit API-billing fallback is provided. GitHub Apps remain because publishing identity is independent of agent execution.

Compatibility identifiers `controllerRepository`, `[agent-controller:...]`, and existing state markers remain for migration. New user-facing guidance uses **orchestrator**. Existing Project bindings, App identities, application ownership, and review history must not be silently replaced during upgrade. A single host is an explicit current limitation; independent hosts do not share a lock.

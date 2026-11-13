# Architecture

## Execution and subscriptions

The user owns the runtime host. A native Codex CLI or Claude Code session acts as the orchestrator and controls specialist sub-agents. Their files, processes, commands, and worktrees remain on that host, or on a user-owned remote host. Inference uses the provider service through the official client's own subscription login. GRAIT does not proxy provider login tokens or call an LLM API itself.

GitHub stores issues, native blocking relationships, the Project, branches, PRs, formal reviews, and visible state comments. Actions runs deterministic validation and optional operator releases. No model credentials or agent jobs are required there.

## Canonical policy and adapters

`AGENTS.md`, `docs/`, `automation/skills/`, and `automation/agents.json` are canonical. `scripts/harnesses.mjs` generates Codex and Claude discovery files. CI checks drift. `workflow.config.json` declares local execution, the selected harness, scoped writes, role profiles, and hard limits. `config/codex.toml` supplies the canonical native Codex defaults. There are no workflow compilation steps or generated Actions locks.

## Deterministic local operations

The orchestrator uses `scripts/orchestrator.mjs` for readiness, claiming, worktree preparation, review publishing, and Project synchronization. These commands call deterministic GitHub helpers; they never make model requests. The native parent session decides how to delegate authorized work.

Readiness is bound to the current issue digest and native dependency set. Claims count all Project stories, including other repositories and inaccessible active items. Only one designated repository/host coordinates a Project. Local commands acquire an exclusive lock in shared Git metadata before loading/mutating remote state. This does not provide a distributed lock across clones or machines; multi-host scheduling requires a future coordination service.

Writer-authenticated issue/PR comments hold accepted readiness, claims, review history, and stop reasons. Duplicate or malformed trusted state fails closed. Intent is persisted before uncertain external writes; retries cannot silently reset a loop. Legacy `controllerRepository`, `[agent-controller:...]`, and ledger markers remain readable so existing identity/binding evidence can be preserved.

## Worktrees and ownership

The parent has its own checkout. Each issue has a worktree/branch. Tester and implementer take sequential exclusive ownership of that same worktree at exact committed handoffs; unrelated work and review use separate worktrees. Independent validation checks Red/Green and role-scoped diffs. Native role prompts constrain test visibility; they are not an OS confidentiality boundary. See [TDD](tdd.md) and [worktrees](worktrees.md).

## Credentials and human authority

GitHub Apps separate writer and reviewer publishing identities. Setup's temporary loopback server performs state-checked manifest registration and installation verification. Keys are saved privately in Git metadata on the host; publishing tools mint short-lived repository-scoped tokens. No model or publishing credentials are installed in CI by the default setup. The human's host-side GitHub authorization manages the Project separately.

Worktrees and local files do not prevent arbitrary processes owned by the same OS user from accessing keys. Keep untrusted execution in isolated users/containers and do not run PR code in the credentialed reviewer session. Deterministic CI runs PR code with read-only GitHub permissions and no publishing secrets.

Independent branch rules require passing CI, current agent review, and human code-owner approval. Only configured humans may update the default branch through a PR, without bypassing the delivery rules. Agents never merge or release. Optional release credentials live in a separate protected environment and do not participate in AI execution.

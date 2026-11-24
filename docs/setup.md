# Setup reference

Use the [installation guide](installation.md) to prepare an application repository and [select a pinned CLI](installation.md#choose-and-run-a-pinned-cli). Run these commands from the target checkout using that package. Git, GitHub CLI, Node.js 24 or newer, npm 11.10.0 or newer, and the selected native harness belong on the operator host. Application code may use any stack.

## Packaged CLI commands

| Command                                                                                    | Purpose                                                             |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `grait init --plan --repo OWNER/REPOSITORY --revision "$GRAIT_REVISION"`                   | Preview installation artifacts                                      |
| `grait init --repo OWNER/REPOSITORY --revision "$GRAIT_REVISION"`                          | Provision the Project and Apps and apply application-side artifacts |
| `grait validate`                                                                           | Check the installed configuration and managed artifacts             |
| `grait activate`                                                                           | Activate after human merge and default-branch CI                    |
| `grait upgrade --plan --revision "$GRAIT_UPGRADE_REVISION"`                                | Preview a packaged upgrade                                          |
| `grait migrate --plan --revision "$GRAIT_REVISION" --legacy-revision "$TEMPLATE_REVISION"` | Preview migration from a configured GRAIT template                  |
| `grait orchestrator --help`                                                                | Queue, worktree, worker, review, and synchronization commands       |
| `grait github --help`                                                                      | Scoped writer publishing commands                                   |

See [GRAIT development](grait-development.md) for source-checkout tests and generator commands.

## Subscription authentication

Sign in through the official client: `codex login`, `claude auth login`, or `copilot login`. Setup checks the native Codex/Claude login and invokes it when missing. Copilot has no documented non-interactive login-status command: setup verifies the CLI is installed and invokes its native OAuth login; the interactive client validates account access and plan entitlement when the session starts. It never reads/copies the provider's stored credentials or uploads model keys to GitHub. If you have configured API billing, switch the client to subscription login before setup. Availability and allowances depend on your plan; all sub-agents share its allowance. GRAIT does not automatically switch to API billing when an allowance runs out.

[Codex supports ChatGPT subscription sign-in](https://learn.chatgpt.com/docs/auth), and [Claude Code supports native Claude sign-in](https://code.claude.com/docs/en/authentication). Keep the unmodified official client responsible for authentication; [Anthropic distinguishes this from third-party applications routing subscription credentials](https://code.claude.com/docs/en/legal-and-compliance).

Copilot uses local CLI sub-agents; its `/delegate` cloud-agent flow is outside this setup. Copilot uses its own user login, separate from the writer/reviewer GitHub Apps. Its built-in GitHub CLI login fallback belongs to that user; publishing App tokens are stripped before harness launch. Avoid configuring BYOK providers in the native client for this subscription-backed setup. See [Copilot CLI authentication](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli) and [native CLI flags](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference). GRAIT does not probe Copilot entitlement by making a model request or invent an authentication-status command.

## Harness and model configuration

`workflow.config.json` selects `engine: "codex"`, `"claude"`, or `"copilot"` and `execution: "local"`. Its six roles all run on the host. The main session is the orchestrator. `maxConcurrentWorkers` defaults to five, independently of the five-story Project cap. The orchestrator skill applies the worker cap. The native harness can impose its own limits.

### Configure worker concurrency

Set `maxConcurrentWorkers` in `workflow.config.json` to an integer from **1 to 5**. The default is **5**. For example, use `"maxConcurrentWorkers": 3` to run at most three specialists at once. The orchestrator reads this value when it starts, and Copilot worker launches receive it. Native limits also apply.

For a packaged Codex installation, set the native cap in the trusted project's `.codex/config.toml` outside the GRAIT-managed block. Add the setting to the existing `[agents]` table or create that table. The example allows three spawned threads in addition to the primary session. [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)

```toml
[agents]
max_concurrent_threads_per_session = 3
```

In a GRAIT source or legacy template checkout, run `npm run harness:generate` to generate the native Codex setting from `maxConcurrentWorkers`. Start a new harness session after changing its configuration.

Worker slots are shared across triage, testing, implementation, fixes, and review. Each active review uses one worker, with at most one active reviewer per story. Each story's tester and implementer take sequential exclusive ownership of its branch and worktree. The independent Project-wide ceiling is [five occupied story slots](workflow.md#claiming-and-delivery), shared by In Progress stories and Review reservations.

### Configure Ready queue capacity

Set `maxReady` in `workflow.config.json` to a positive integer. The default is **5**. A reasonable starting point is to match the maximum number of concurrent workers or subagents configured for your harness. For example, with `"maxConcurrentWorkers": 3`, set `"maxReady": 3`.

The limit applies across the Project. If you lower it below the current Ready count, claiming or returning existing Ready stories to Backlog frees space for new ones.

### Configure role settings

Set `roleProfiles.<engine>.<role>` in `workflow.config.json` to override a role's `model` or `reasoning`. Supported role keys are `orchestrator`, `triage`, `test`, `implement`, `review`, and `fix`. Only profiles for the selected `engine` take effect.

```json
{
  "roleProfiles": {
    "codex": {
      "orchestrator": { "model": "gpt-6.2-sol" },
      "review": { "reasoning": "xhigh" }
    },
    "claude": {
      "implement": { "model": "sonnet", "reasoning": "high" }
    }
  }
}
```

Each field resolves independently. A missing or `null` value falls back to the selected harness's legacy `tdd.profiles.tester` for `test` and `tdd.profiles.implementer` for `implement` and `fix`. The next fallback is the role default. Models inherit from the native harness. Review defaults to `high` reasoning. The orchestrator and other Claude and Copilot roles use `orchestrator.reasoning`, which defaults to `medium`. Other Codex roles inherit native reasoning settings. The `orchestrator` and `worker` launch commands pass the resolved profile to the native CLI.

| Harness                                                                                                        | Native agent field       | Accepted reasoning values                                           |
| -------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------- |
| [Codex](https://developers.openai.com/codex/config-reference)                                                  | `model_reasoning_effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| [Claude Code](https://code.claude.com/docs/en/sub-agents)                                                      | `effort`                 | `low`, `medium`, `high`, `xhigh`, `max`                             |
| [GitHub Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference) | `reasoningEffort`        | `low`, `medium`, `high`, `xhigh`, `max`                             |

Use model IDs or aliases supported by your installed harness and account. GRAIT validates the profile keys, model ID syntax, and accepted effort values for every configured engine. The harness determines model availability and supported effort combinations. Copilot profiles require Copilot-served model IDs. Its launcher defaults to Auto and strips provider override variables. When a Copilot parent uses Auto, use an explicit worker launch if native delegation inherits the parent model instead of selecting the worker profile.

In a template checkout, run `npm run harness:generate` after updating the configuration. `config/codex.toml` remains the canonical Codex project default, and the active Codex orchestrator profile can override the model and reasoning in its generated copy. In an installed project, run the pinned `grait upgrade` with the installation's current or newer revision to refresh the managed agent files. Existing user-owned native settings take precedence in generated agent files. Role profiles grant no additional permissions.

Claude triage/review roles use native worktree isolation. Tester, implementer, and fix stages use the orchestrator's pre-created issue worktree sequentially; they must not create independent default-branch worktrees. `grait orchestrator worker --issue N --role implement` launches a native session in that existing worktree. Native delegation can instead assign its absolute path and exact committed handoff explicitly.

## Publishing identities and Project access

Setup registers two private, repository-owned GitHub Apps using manifest approvals:

| App      | Repository permissions                                                      |
| -------- | --------------------------------------------------------------------------- |
| Writer   | Contents, issues, pull requests, and commit statuses: write; metadata: read |
| Reviewer | Contents: read; issues and pull requests: write; metadata: read             |

The Apps are publishing identities, not execution environments or provider accounts. No webhook server is required after setup. Commands mint short-lived installation tokens scoped to the target repository; private keys remain in private Git metadata. They are not OS-isolated from arbitrary code running as the same user. Reviewers inspect untrusted code without executing it; stronger isolation requires a separate OS user/container.

Project API access uses the host user's GitHub CLI authorization, or an explicitly supplied `PROJECT_TOKEN` environment variable. Give a personal token only the needed Project scope and store it in your host's secret manager. It is not an LLM credential. Repository variables store non-secret Project and App login metadata; `AUTOMATION_ENABLED` provides a repository-wide pause switch.

## Operator blockers

Submit the [usual triage fields](operations.md#triage-and-claim) with `ready: false`, the current issue digest, and actual native dependencies. Use `questions` for public questions that require an operator decision. GRAIT records those questions as the action to take. To supply a specific blocker and action, include both `humanAttention` fields below.

```json
{
  "humanAttention": {
    "blocker": "The acceptance criteria specify two conflicting behaviors.",
    "action": "Decide which behavior is required and update the acceptance criteria."
  }
}
```

```sh
grait orchestrator ready --issue 123 --file /tmp/triage.json
```

GRAIT applies the label configured in `labels.needsHuman` (default `agent:needs-human`) and records the blocker and requested action in its issue comment. Repeated reports update the same comment. Issues in triage stay in Backlog. A wait on native dependencies alone uses the existing dependency links. Include public `questions` or `humanAttention` when an issue also needs a separate operator action.

Use the same command for a blocker found during delivery, such as a required edit outside the writer's publishing scope. The report preserves the accepted claim and Project status. Write both fields for readers of the issue and omit credentials, private setup details, and raw command output.

The label pauses new claims and further automation on the issue, including review of its linked PR. An operator with permission to manage its labels resolves the blocker and removes the human-attention label in GitHub. Submit a fresh assessment for a Backlog issue or retry the blocked step for a claimed issue. Explicit `agent:paused` labels and native dependency requirements still apply.

Conflicting reviewer instructions also label the linked issue and record the action there. The recorded PR review pause still applies after label removal. Follow [pause and recovery](operations.md#pause-and-recovery) to reconcile the PR review ledger before resuming.

## Clean up a merged task

After GitHub confirms the issue's linked PR was merged and the worker sessions have released the issue, run this from the coordinator checkout:

```sh
grait orchestrator sync --pr 123
```

Before moving the Project issue to Done and recording the completed PR, sync verifies that the PR from the canonical claim branch in the same repository was merged into that repository's default branch and that GitHub reports exactly one closing reference to the claimed issue. Local cleanup requires Git 2.36 or newer. When a TDD handoff exists, it must be released and its accepted head must match the PR head. For claims without a TDD handoff, the merged PR supplies the exact head. This also works after a squash merge.

Cleanup can remove the clean, registered task worktree under the sibling `<repository>-worktrees/issue-N` path and the local `agent/issue-N` branch at the accepted head once Git operations in other worktrees have released that branch. Each accepted claim prepares temporary space at `<git-common-dir>/grait-setup/issue-scratch/issue-N`. Cleanup verifies the directory against its private device and inode record under `grait-setup/issue-scratch-owners`. It preserves unregistered or replaced directories and directories with embedded Git checkout metadata. Keep durable records and shared files outside task scratch.

Each process that prepares an accepted claim keeps a private marker in `<git-common-dir>/grait-setup/issue-reservations/issue-N/`. This includes managed workers for TDD-exempt issues and separate commands that publish for the same claim. Normal command exit releases that process's marker. Cleanup waits until the directory is empty.

If a command is interrupted, inspect the marker's PID and verify that the associated launcher and any native worker or descendant using the issue have stopped. Once shutdown is confirmed, remove only that stale marker and retry sync. A missing PID alone is insufficient. Apply the same recovery steps if an older installation left a single `issue-N` reservation file at the directory path.

For a TDD-exempt worker launched outside the managed command, run `git worktree lock --reason "Worker active" <worktree-path>` before launch and `git worktree unlock <worktree-path>` after the session and its descendants have stopped.

The `cleanup.removed` list records what was deleted, and `cleanup.failures` reports blockers. If a blocker remains, review the reported path or ref, release any remaining sessions, and reconcile the ownership, files, or branch before rerunning the same command. Use a separate location to preserve any operator files you need to move. Cleanup skips work already completed, so a successful retry with no remaining artifacts returns two empty lists.

## Legacy template repair and maintainer bootstrap

In a source checkout that still includes the GRAIT tooling, maintainers can inspect staged provision details with the advanced bootstrap command. Packaged installations use `grait init` and `grait activate`. To preview the legacy bootstrap:

```sh
npm run bootstrap -- --repo OWNER/REPOSITORY --maintainers alice --writer-login 'writer-app[bot]' --reviewer-login 'review-app[bot]'
```

Add `--apply` to mutate the repository. Use `--project-owner` and `--project-number` to select an existing Project. Bootstrap preserves existing CODEOWNERS rules and validates an existing Project's statuses rather than resetting them. It records new Project identity before later configuration can fail. Repository rules are staged until activation, except immutable release-tag protections. Ruleset errors open the [guided fallback](installation.md#ruleset-configuration-fallback): complete manual configuration or explicitly acknowledge unenforced operation. Setup, bootstrap, and activation accept `--acknowledge-unenforced-rules` for that acknowledgement; the overall setup `--yes` does not imply it. The repository variable `RULESET_ENFORCEMENT` records the outcome. Agents still require human PR approval and merge. A release environment is configured only when an optional release App ID is supplied. No credit ledger or provider secrets are created. The `controllerRepository` key remains for compatibility with existing Project bindings.

Advanced commands do not replace the host-side credentials and native login that guided setup configures. Follow [activation](installation.md#guided-configuration) before starting the orchestrator.

### Publishing identity bindings

Guided setup verifies both Apps using their private keys and target repository installations. It records `AUTOMATION_APP_ID` and `REVIEW_APP_ID` for the Apps, plus `AUTOMATION_BOT_USER_ID` and `REVIEW_BOT_USER_ID` for their bot accounts. GitHub authorship checks use the bot user IDs. The login variables are display metadata after the numeric bindings are recorded. An App rename keeps the same bindings and associated history.

During initial packaged provisioning, add `--writer-key PATH --reviewer-key PATH` to the `grait init` command to import existing private keys while the workflow is paused. Import requires the repository to record all four numeric bindings. Each key must be a private regular file owned by the operator with mode 600.

To record publishing identities during legacy bootstrap, supply the verified writer App ID with `--status-app-id`, the reviewer App ID with `--reviewer-app-id`, and the two bot user IDs with `--writer-bot-user-id` and `--reviewer-bot-user-id`. Bootstrap without publishing IDs can stage Project and repository settings. Activation independently verifies the numeric bindings against the saved App credentials. If the required numeric bindings are missing or inconsistent, complete clean setup before activation.

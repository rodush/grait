# Installation and configuration

Choose your repository path first, then follow [guided configuration](#guided-configuration). The target is one user-owned host running Codex CLI or Claude Code, with GitHub providing issues, a Project, PRs, reviews, and deterministic CI.

## Prerequisites

Install Git, Node.js 24, npm (the version in `package.json`), GitHub CLI, and your chosen official harness: [Codex CLI](https://developers.openai.com/codex/cli) or [Claude Code](https://code.claude.com/docs/en/quickstart). Use an eligible provider subscription. No LLM API key is required.

Authenticate GitHub and configure Git authentication:

```sh
gh auth login
gh auth setup-git
```

The target GitHub plan must support the required branch rules and human code-owner review (especially for private repositories). The applying user needs repository administration, access to create/install Apps under the repository owner's account, and permission to create or manage the Project. For a personal Project, authorize the GitHub CLI's Project scope with `gh auth refresh -s project`. Organization policy may require an owner to approve App registration or installation. Those GitHub approvals cannot be bypassed by the starter.

## New repository

1. Use GitHub's **Use this template → Create a new repository**, selecting your target owner. Alternatively, use GitHub CLI:

   ```sh
   gh repo create OWNER/REPOSITORY --template rodush/grait --private --clone
   cd REPOSITORY
   ```

2. Replace `OWNER/REPOSITORY` and choose your intended visibility. A repository created from a template starts with an unconfigured Project binding.
3. Continue with [guided configuration](#guided-configuration).

## Existing repository

1. Clone the target and create an integration branch. Preserve the existing application's code, history, and policies:

   ```sh
   gh repo clone OWNER/REPOSITORY
   cd REPOSITORY
   git switch -c chore/adopt-grait
   ```

2. Obtain a separate clone of this starter. Bring in `automation/`, `scripts/`, `config/`, `workflow.config.json`, and the engineering docs. Merge `AGENTS.md`, `CLAUDE.md`, `.github/`, `.agents/`, `.claude/`, `.codex/`, and the tooling configuration deliberately. In particular, merge npm scripts/dependencies, lint/format settings, CODEOWNERS, CI, and ignore files into existing equivalents. Do not replace the application's package manifest, lockfile, workflows, or ownership rules wholesale.
3. Keep this starter's `ci.yml` and **Template validation** job alongside application CI, or adjust the required-check rule in `scripts/lib/bootstrap.mjs` to your chosen equivalent. Record application commands and configure `allowedWritePaths`, `protectedPaths`, and `tdd` for the actual stack. The default writable paths are `src/`, `tests/`, `assets/`, and `docs/project/`.
4. Merge any existing Codex project settings into canonical `config/codex.toml`; generation maintains its installed `.codex/config.toml` copy. Review shared role model overrides when changing providers.
5. Commit the integration before running setup; the wizard refuses a dirty checkout. After validation, setup publishes those original integration commits with the administrator's GitHub identity before the App publishes its configuration commit; this supports workflow-file changes without granting the writer App workflow-write permission. The administrator's GitHub authorization must allow those workflow changes (`gh auth refresh -s workflow` when needed). If you lack admin access, follow [the owner handoff](#ownership-and-access). Otherwise continue with guided configuration on this branch.

## Ownership and access

| Your access                       | Your part                                                               | Owner/admin part                                                                                    |
| --------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| You own/administer the target     | Prepare the integration and run setup                                   | Approve App registration/installations and review/merge the configuration PR                        |
| You can contribute but lack admin | Prepare an integration PR and a read-only setup plan                    | Apply setup in a clean clone, approve Apps/Project permissions and rules, then activate after merge |
| You only have a fork              | Propose the integration from your fork, identifying the upstream target | An upstream admin applies configuration to upstream, using upstream-owned Apps and Project          |

For an owner handoff, attach the output of `npm run setup -- --plan --repo UPSTREAM/REPOSITORY` to the integration PR. The administrator checks out the proposed branch in a clone of the target and runs setup. A fork's Actions secrets/settings do not configure upstream. The runtime host must also be operated by an authorized user with the Project access and the two publishing App keys; never send those keys through an issue or PR.

## Guided configuration

1. **Preview the target and defaults.** From a clean checkout:

   ```sh
   npm run setup -- --plan
   ```

   Use `--repo OWNER/REPOSITORY` to pin the target, `--harness claude` to choose Claude Code, and `--maintainers alice,bob` to choose human owners. A plan with an explicit target needs no credentials or network access. An inferred target uses read-only GitHub CLI discovery.

2. **Run setup.** It displays one plan for acceptance, checks administrator access, guides native harness sign-in when needed, installs tooling, and opens the App registration flow:

   ```sh
   npm run setup
   ```

   `--yes` accepts the displayed plan for repeatable invocations. Each App still needs GitHub's human registration and repository-installation approvals. The manifests prefill permissions; no manual bot-account creation is needed. Setup verifies each App's actual owner, permissions, and installation. It creates exactly two publishing identities, writer and reviewer. Provider credentials remain with the official harness; publishing App keys stay in mode-600 files under private Git metadata, never GitHub Actions secrets.

3. **Let setup prepare the configuration PR.** It creates or reuses the recorded Project, configures its five statuses and board for a newly created Project, adds human CODEOWNERS without discarding application rules, stages repository rules, generates native adapters, runs checks, and commits/pushes a focused configuration branch. An existing Project is validated without resetting its statuses or views. To select one explicitly:

   ```sh
   npm run setup -- --project-owner OWNER --project-number 7
   ```

   Its Status field must already include Backlog, Ready, In Progress, Review, and Done. If any step fails, read its recovery message; do not delete existing Apps or create another Project to retry. A failed push/PR leaves the configuration commit locally: rerun `npm run setup -- --publish` on that exact clean branch to retry publishing without provisioning again. The writer App pushes and authors the configuration PR, so the administrator can provide the required human approval.

4. **Have a human review and merge.** Setup never merges. After the configured PR is merged and the default branch has successful CI, update this checkout to that branch and activate:

   ```sh
   git switch main
   git pull --ff-only
   npm run setup -- --activate
   ```

   Substitute the actual default branch. Activation checks the committed configuration, CI head, Project binding, both host-side App credentials, and human ownership before enabling rules and this host.

5. **Start the orchestrator.**

   ```sh
   npm run orchestrator -- start
   ```

   This launches your chosen official CLI with the orchestrator skill. It manages local specialist sessions/worktrees and publishes branches/PRs to GitHub. Follow [operations](operations.md) for the first issue, triage, claims, review, and recovery. It runs while the harness session is active; it is not a GitHub daemon or an unlimited unattended service.

## Upgrade an existing GRAIT installation

1. Stop active agents at committed handoffs. In the old installation set `AUTOMATION_ENABLED=false`, disable `controller.yml`, and cancel/wait for old agent workflows before enabling the local runtime. Preserve issue/PR ledgers and their writer identity so review history and lifetime limits survive migration. Resolve any in-flight or ambiguous external operation with a human.
2. Integrate this version on a branch, preserving application changes and Project identity. Remove the old agent `.md`/`.lock.yml` files and `shared/` under `.github/workflows/`, `controller.yml`, `tdd-verify.yml`, `automation/prompts/`, and the old compiler/dispatch/authorizer scripts. Remove their npm scripts and CI compiler steps. The maintained workflows are `ci.yml` and optional `release.yml`. Remove Copilot adapters, which this subscription path does not support.
3. Migrate `workflow.config.json` to schema version 2 using this version's configuration: keep your repository binding, humans, scopes, statuses, and TDD profiles; select `execution: "local"`, `engine: "codex"` or `"claude"`, two workers, and medium orchestrator reasoning. Remove compiler pins, hosted engine pins, credit budgets, and the old runner image; retain/adapt explicit local test install/command arrays under `tdd.runner`. Keep the legacy `controllerRepository` key and `[agent-controller:OWNER/REPOSITORY]` Project marker: they preserve existing bindings. Add the new orchestrator canonical skill and regenerate adapters.
4. Reuse the existing publishing Apps. Their old private keys cannot be downloaded from GitHub Secrets. Recover your original keys or generate/download replacement keys **on the existing Apps**. Remove obsolete Actions permission from the writer App, keeping contents/issues/pull requests/statuses write and metadata read; reviewer keeps contents read, issues/pull requests write, metadata read. Approve permission changes on the installation. Local Project writes use the human's Project authorization rather than an App organization-Project grant.
5. Import private key files on the runtime host during setup:

   ```sh
   chmod 600 /secure/writer.pem /secure/reviewer.pem
   npm run setup -- --writer-key /secure/writer.pem --reviewer-key /secure/reviewer.pem
   ```

   Commit the integration before this command. Setup finds the recorded App logins and Project variables, validates the supplied keys, and prepares the configuration PR. It will not silently replace missing identities. Review old ledgers for paused work; a pending hosted operation requires human reconciliation before local work resumes.

6. Existing delivery rules may still require an agent review on the migration PR. Have the local reviewer evaluate its exact head, then let a configured human publish that report with `npm run orchestrator -- review --setup-review --pr N --file /tmp/review.json`. This limited staged-review command works before host activation without disabling the delivery rules or starting implementation. See [review publication](operations.md#review-publication).
7. After human merge/CI, activate and start locally. Delete unused provider API-key secrets, hosted writer/reviewer Actions secrets, and hosted credit-budget variables after confirming the old workflows cannot run. Preserve the old budget issue as historical evidence; local setup does not create or reset a paid-automation ledger. Retain optional release credentials only if you use that separate integration.

## Resume, remote hosts, and credentials

Rerun setup after a pre-commit interruption from the same host and checkout once any partial tracked changes have been reviewed and committed. Saved App registrations and the recorded Project are reused. An uncertain manifest conversion or Project creation fails closed; recover the existing object before retrying. A stale lock requires stopping its process and inspecting/removing the lock manually; never delete a live lock to start a second instance.

App credentials and local activation state live in `<git-common-dir>/grait-setup/session.json`; this is outside tracked files and shared by linked worktrees. Back it up securely. On a second host, authenticate GitHub and the native harness there, securely transfer the private setup directory with mode 700 for the directory and 600 for files (excluding any lock), and activate that host. Alternatively import keys as above while automation is paused. Do not commit or attach this directory to a PR.

For an SSH host, use `--no-browser` and forward the printed callback port to your browser machine, for example `ssh -L PORT:127.0.0.1:PORT HOST` in another terminal. Open the printed loopback URL, then finish GitHub's approvals. Setup uses the same saved port on retry.

Run **one orchestrator host per Project**. Local command locks do not coordinate separate clones or machines. Stop the old host before moving coordination to another host. Separate worktrees provide file/branch isolation, not OS security boundaries; use isolated users or containers for untrusted code. See [architecture](architecture.md) and [setup reference](setup.md).

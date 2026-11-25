# Installation and configuration

Use the [Git-pinned CLI](#existing-repository) to install GRAIT in an existing repository. Use [guided configuration](#guided-configuration) if your repository was created from the GRAIT template. The target is one user-owned host running Codex CLI, Claude Code, or GitHub Copilot CLI, with GitHub providing issues, a Project, PRs, reviews, and deterministic CI.

## Prerequisites

Install Git, Node.js 24, npm (the version in `package.json`), GitHub CLI, and your chosen official harness: [Codex CLI](https://developers.openai.com/codex/cli), [Claude Code](https://code.claude.com/docs/en/quickstart), or [GitHub Copilot CLI](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli). Use an eligible provider subscription. No LLM API key is required.

Authenticate GitHub and configure Git authentication:

```sh
gh auth login
gh auth setup-git
```

GitHub rulesets provide optional server-side enforcement of the delivery policy. Private repositories on GitHub Free cannot use rulesets, including through the manual settings UI. Setup can continue after an explicit acknowledgement that those rules are unenforced; agents must still leave PR approval and merge to humans. The applying user needs repository administration, access to create/install Apps under the repository owner's account, and permission to create or manage the Project. For a personal Project, authorize the GitHub CLI's Project scope with `gh auth refresh -s project`. Organization policy may require an owner to approve App registration or installation. Those GitHub approvals cannot be bypassed by the starter.

## New repository

1. Use GitHub's **Use this template → Create a new repository**, selecting your target owner. Alternatively, use GitHub CLI:

   ```sh
   gh repo create OWNER/REPOSITORY --template rodush/grait --private --clone
   cd REPOSITORY
   ```

2. Replace `OWNER/REPOSITORY` and choose your intended visibility. A repository created from a template starts with an unconfigured Project binding.
3. Adapt `AGENTS.md` to describe the application layout and link its stack and command reference under `docs/project/` when a stack is chosen. Keep GRAIT tooling instructions scoped separately; the inherited npm package is automation infrastructure, not an application stack choice. Configure the TDD runner for the application's tests before starting application implementation.
4. Continue with [guided configuration](#guided-configuration).

## Existing repository

1. Install the CLI globally from Git, then create an integration branch in the target checkout.
2. Run GRAIT init and review its plan. Complete the GitHub approvals when prompted.
3. Commit the generated files together, push the integration branch, and open a configuration PR into the default branch.
4. Have a human merge the configuration PR and wait for GRAIT validation on the current default-branch head.
5. Update your checkout to the default branch and activate GRAIT.

**Always use a configuration PR.** A direct push of the setup commit to the default branch blocks activation even when GitHub allows the push.

Install the packaged CLI with npm. The bootstrap selects the tip of `main` at install time, verifies npm's resolved Git SHA, and records that SHA against the global executable.

```sh
npm exec --yes --allow-git=all --ignore-scripts \\
  --package='git+https://github.com/rodush/grait.git#main' -- grait install-global
```

For a reviewed version, replace `main` with its full commit SHA or an exact Git tag such as `v1.2.3`. The revision must include the global installer. The Git opt-in is scoped to this npm invocation. If you install into an isolated npm prefix with `grait install-global --prefix PATH`, put that prefix's npm executable directory on your `PATH`. Bare `grait init` uses the installed immutable SHA even if its branch or tag moves. Generated CI also uses an immutable SHA.

In a clean target checkout, create the integration branch and preview the plan:

```sh
git switch -c chore/adopt-grait
grait init --plan
```

The plan shows the target repository, resolved revision, harness, maintainers, Project, and publishing Apps before the artifact diff. When a fork and upstream are both plausible, select the target with `--repo OWNER/REPOSITORY`. Choose `--harness codex`, `--harness claude`, or `--harness copilot` to override the harness. Use `--maintainers LOGIN,LOGIN` to propose human owners and `--project-owner LOGIN --project-number N` to bind an existing Project. Use `--revision SHA` or `--revision vX.X.X` to preview and apply a selected package. A 12-character SHA prefix for the running package remains supported. Use `--cwd PATH` before `init` to target another checkout.

The preview does not provision resources or write the target. Apply the plan by running:

```sh
grait init
```

For scripted use, pass the CLI's `--yes` after `grait init` to confirm the displayed plan and any explicit maintainer selection. GitHub App registration and installation still require human approval. Use `--no-browser` to print approval URLs on a remote host. A pinned npm invocation remains available for scripts and users without a global prefix on their `PATH`:

```sh
npm exec --yes --allow-git=all --ignore-scripts \\
  --package='git+https://github.com/rodush/grait.git#GIT_PIN' -- \\
  grait init --plan --repo OWNER/REPOSITORY --revision GIT_PIN \\
  --harness codex --maintainers OWNER
```

The installer reuses confirmed setup answers, verified writer and reviewer Apps, and the recorded Project on retry. It stages provisioning privately and then applies the generated harness instructions, `workflow.config.json`, human CODEOWNERS, `.github/workflows/grait.yml`, and `.grait/installation.json` together. Publishing keys and recovery state stay under private Git metadata. Preserve the metadata and retry from the same checkout after an interruption. A bare retry uses the original verified revision saved with the setup answers. The CLI gives a recovery command if it cannot read verified provenance.

Review `maxReady` in `workflow.config.json` before committing. It defaults to five, and matching your harness's maximum concurrent workers or subagents is a reasonable starting point. See [Ready queue capacity](setup.md#configure-ready-queue-capacity).

Once a human merges the configuration PR and GRAIT validation succeeds on the current default-branch head, switch to that branch, pull the merge, and run:

```sh
grait activate
```

Activation verifies the human merge, exact artifacts at the merge commit and current default-branch head, current CI, Project access, human CODEOWNERS, and both App installations. If the installation record reached the default branch by direct push, follow [direct-push recovery](#recover-a-direct-push-of-the-installation-record). The generated workflow runs `grait validate` for GRAIT configuration and managed content. Keep your application checks and configure the application runner and write scopes in `workflow.config.json` before starting testable work.

If a ruleset prompt pauses, follow the displayed GitHub settings instructions and rerun the same command. The separate `--acknowledge-unenforced-rules` confirms an unenforced ruleset. Ordinary `--yes` confirms the installation plan. Human approval and merge remain required. If activation is interrupted, it reports the active step and releases its local lock on Ctrl+C. Rerun `grait activate` to check the saved decision and remote settings. A retry can recover a private lock whose owner has stopped and leaves a lock held by a live process in place. If previously active rules cannot be verified, activation pauses automation while you reconcile them.

### Recover a direct push of the installation record

If activation reports **A configuration PR containing the installation record must be merged to the default branch by a human before activation**, check the record path and commit shown by the diagnostic. A later PR can list `.grait/installation.json` in its diff while the file is already identical on the default branch. The merge then leaves the record unchanged, and the earlier direct push remains the last commit that changed it.

If setup was pushed directly and your current repository rules permit the reviewed revert, use two configuration PRs:

1. Update the default branch and create a revert branch. Revert the direct setup commit and inspect the diff, especially if the commit includes other changes. Open a PR for the focused revert and have a human merge it.
2. Start a new integration branch from the updated default branch. Reapply the original generated setup files from the direct setup commit, accounting for any intentional intervening edits. Open a configuration PR and have a human merge it.
3. Wait for GRAIT validation on the current default-branch head, update the local checkout, and rerun `grait activate`.

The revert temporarily removes tracked setup files introduced by the direct push, which may include the generated validation workflow. Plan the two PRs when that gap is acceptable and the repository's current merge rules permit it. Keep the existing Apps, Project binding, and private setup state throughout. Reapplying the original artifacts leaves `.grait/installation.json` intact and preserves Git history.

## Existing template-based repository

### Migrate a configured template to the pinned CLI

In the existing configured repository, create an integration branch and stop the local orchestrator for the migration. Choose a reviewed package revision for `GIT_PIN` and the full SHA of the original GRAIT template commit for `TEMPLATE_SHA`.

```sh
git switch -c chore/migrate-grait
npm exec --yes --allow-git=root --ignore-scripts \
  --package='git+https://github.com/rodush/grait.git#GIT_PIN' -- \
  grait migrate --plan --revision GIT_PIN --legacy-revision TEMPLATE_SHA
```

The preview fetches the template pin from the canonical GRAIT repository into temporary storage. It shows additions, replacements, and removals without changing the target. A removable legacy file must match the selected template's path, tracked blob, executable mode, and worktree bytes. Migration keeps existing Codex settings and customized policy text and appends the packaged policy blocks. Literal references in retained project files keep the legacy tooling and its dependencies in place. The scan skips Markdown documentation and installed npm dependencies. The plan lists the referencing files. The pinned workflow takes over the legacy template validation check. Update references to the original stock workflow before migrating. If that workflow runs customized npm scripts or its inherited Node test command selects application tests, move the application checks to a dedicated workflow and retire the original workflow before retrying. Check dynamically constructed paths against the proposed removals before applying. Both preview and apply verify the running package revision using npm's lock metadata.

Repeat the command without `--plan` to confirm interactively, or use `--yes` after `migrate`. Use `--cwd PATH` before `migrate` to target another checkout. Migration adds the pinned validation workflow and installation record. It uses the current workflow configuration and CODEOWNERS and leaves the Git history, Project binding, publishing identities, and private host credentials in place. Commit the file changes together, open a PR for human merge, and verify the GRAIT and application checks before resuming operations with the pinned CLI.

If migration is interrupted during file application, preserve the recovery journal and retry with both original pins. Confirm that the previous process has stopped before removing a stale setup lock.

### Repair the source-based workflow

Use this path when installing or repairing the source-based template workflow.

1. Clone the target and create an integration branch. Preserve the existing application's code, history, and policies:

   ```sh
   gh repo clone OWNER/REPOSITORY
   cd REPOSITORY
   git switch -c chore/adopt-grait
   ```

2. Obtain a separate clone of this starter. Bring in `automation/`, `scripts/`, `config/`, `workflow.config.json`, and the engineering docs. Merge `AGENTS.md`, `CLAUDE.md`, `.github/`, `.agents/`, `.claude/`, `.codex/`, and the tooling configuration deliberately. In particular, merge npm scripts/dependencies, lint/format settings, CODEOWNERS, CI, and ignore files into existing equivalents. Do not replace the application's package manifest, lockfile, workflows, or ownership rules wholesale.
3. Keep this starter's `ci.yml` and **Template validation** job alongside application CI, or adjust the required-check rule in `scripts/lib/bootstrap.mjs` to your chosen equivalent. Link the application's stack and command reference from `AGENTS.md`; record working directories and distinguish application checks from GRAIT tooling checks, including any renamed npm scripts. Configure `allowedWritePaths`, `protectedPaths`, and `tdd` for the actual stack. The default writable paths are `src/`, `tests/`, `assets/`, and `docs/project/`.
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

1. **Preview the target and defaults.** You may edit `workflow.config.json` before setup; setup treats those edits as configuration input and includes the resulting file in its final configuration PR. Keep other files clean. You do not need to commit that config file separately:

   ```sh
   npm run setup -- --plan
   ```

   Use `--repo OWNER/REPOSITORY` to pin the target, `--harness claude` to choose Claude Code, `--harness copilot` for Copilot CLI, and `--maintainers alice,bob` to choose human owners. A plan with an explicit target needs no credentials or network access. An inferred target uses read-only GitHub CLI discovery.

2. **Run setup.** It displays one plan for acceptance, checks administrator access, guides native harness sign-in when needed, installs tooling, and opens the App registration flow:

   ```sh
   npm run setup
   ```

   `--yes` accepts the displayed plan for repeatable invocations. Each App still needs GitHub's human registration and repository-installation approvals. The manifests prefill permissions; no manual bot-account creation is needed. Setup verifies each App's actual owner, permissions, and installation. It creates exactly two publishing identities, writer and reviewer. Provider credentials remain with the official harness; publishing App keys stay in mode-600 files under private Git metadata, never GitHub Actions secrets.

3. **Let setup prepare the configuration PR.** It creates or reuses the recorded Project, configures its five statuses and board for a newly created Project, adds human CODEOWNERS without discarding application rules, stages repository rules, generates native adapters, runs configuration, formatting, and Markdown checks, and commits/pushes a focused configuration branch. GRAIT's development test suite runs during development and CI, rather than during setup. An existing Project is validated without resetting its statuses or views. To select one explicitly:

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

   Substitute the actual default branch. Activation checks the committed configuration, CI head, Project binding, both host-side App credentials, and human ownership before enabling this host. It attempts to activate delivery rules; if that fails, the same guided fallback applies.

5. **Start the orchestrator.**

   ```sh
   npm run orchestrator -- start
   ```

   This launches your chosen official CLI with the orchestrator skill. It manages local specialist sessions/worktrees and publishes branches/PRs to GitHub. Follow [operations](operations.md) for the first issue, triage, claims, review, and recovery. It runs while the harness session is active; it is not a GitHub daemon or an unlimited unattended service.

## Ruleset configuration fallback

Setup and activation manage **Required delivery gates**, **Release tag creation**, and **Immutable release tags**. The delivery gates require agent review, CI, CODEOWNERS approval, conversation resolution, and squash merges. The reviewer App posts the agent review. Human code owners approve and maintainers merge.

For existing installations with the legacy **Human merge authority** ruleset, open the repository ruleset settings at `https://github.com/OWNER/REPOSITORY/settings/rules` and set its enforcement to **Disabled**. Maintainers can then squash-merge after the required delivery gates pass. Setup and activation leave the legacy ruleset as configured.

If GitHub rejects a ruleset operation or the rulesets are unavailable, setup prints the repository settings URL and complete JSON configurations for the delivery and release-tag rules. It explains the failure and waits for your choice:

- Configure the rules manually where supported, then enter `completed` to have setup verify them and continue.
- Enter `continue` to acknowledge that GitHub rules are unenforced and continue setup. Agent instructions still require human PR approval and merge; agents never merge or release.
- Enter `pause` to stop and return later. Keep the existing Apps, Project, and setup state.

On GitHub Free private repositories, manual configuration cannot enable the unavailable feature. You can explicitly continue without enforcement, or enable rulesets through a supported GitHub plan or a deliberate visibility change. Setup never changes your subscription or repository visibility.

For a noninteractive run, read the printed configuration and explicitly acknowledge unenforced rules with:

```sh
npm run setup -- --yes --acknowledge-unenforced-rules
```

Repeat your original target, harness, and Project flags as needed. `--yes` accepts the ordinary setup plan only; it does not acknowledge unenforced rules. A ruleset pause restores setup's own preliminary configuration edit when it is unchanged, allowing you to rerun while preserving your original configuration input. Existing edits to `workflow.config.json` are accepted on retry without a separate commit. If other partial tracked changes remain, review and commit them before rerunning. Recorded Apps and Project bindings are reused. An interrupted process releases its local lock on normal exit; inspect any stale lock before removing it.

Activation needs its own acknowledgement if GitHub still cannot enforce the rules:

```sh
npm run setup -- --activate --acknowledge-unenforced-rules
```

Each invocation attempts automatic ruleset configuration again. The repository variable `RULESET_ENFORCEMENT` records `pending`, `staged`, `active`, or `unenforced`; acknowledgement never claims that rules are active. Other setup failures, including invalid credentials, Project permissions, CI, or configuration, still require correction.

## Upgrade an existing GRAIT installation

Use `grait upgrade` in a repository with an existing packaged GRAIT installation, from a host with the GRAIT CLI available. For first-time adoption, follow [installation for an existing repository](#existing-repository).

Start on an integration branch and pass the full Git SHA or its 12-character prefix with the required `--revision` option. Use `--plan` to preview the upgrade.

```sh
grait upgrade --revision GIT_PIN --plan
```

GRAIT fetches the target from its Git repository when the running package cannot be verified at that pin. The fetch uses a temporary directory and leaves the application's dependencies and package files untouched.

Review the proposed diff, then repeat the command without `--plan` and confirm, or use `--yes` for scripted application. The upgrade preserves your workflow configuration, CODEOWNERS, and text outside GRAIT-managed policy blocks. If managed content has changed, the command identifies the conflicting file before applying anything. Restore the recorded managed content and move any intended customization outside its managed block before retrying.

The upgrade updates the managed instructions, the validation workflow pin, and the installation record in one recoverable transaction. It reuses the installed harness, Project binding, and publishing Apps. Review and commit the complete diff in one PR. A repeat with the same pin and unchanged files reports no changes. If execution is interrupted, preserve the journal and retry from the same worktree with the same pin.

For a source-based installation, use [guided configuration](#guided-configuration). A repository that only records App logins or has incomplete numeric bindings requires clean setup before activation. Stop previous automation before configuring the repository.

## Resume, remote hosts, and credentials

Rerun setup after a pre-commit interruption from the same host and checkout. Edits to `workflow.config.json` are accepted as setup input without a separate commit; review and commit any other partial tracked changes before retrying. Saved App registrations and the recorded Project are reused. An uncertain manifest conversion or Project creation fails closed; recover the existing object before retrying. A stale lock requires stopping its process and inspecting/removing the lock manually; never delete a live lock to start a second instance.

App credentials and local activation state live in `<git-common-dir>/grait-setup/session.json`; this is outside tracked files and shared by linked worktrees. Back it up securely. On a second host, authenticate GitHub and the native harness there, securely transfer the private setup directory with mode 700 for the directory and 600 for files (excluding any lock), and activate that host. Alternatively, while automation is paused, import the original keys with `--writer-key PATH --reviewer-key PATH` during setup. Key import requires all four numeric publishing bindings to already be recorded in the repository. Each key must be a private regular file owned by you (mode 600). Do not commit or attach this directory to a PR.

For an SSH host, use `--no-browser` and forward the printed callback port to your browser machine, for example `ssh -L PORT:127.0.0.1:PORT HOST` in another terminal. Open the printed loopback URL, then finish GitHub's approvals. Setup uses the same saved port on retry.

Run **one orchestrator host per Project**. Local command locks do not coordinate separate clones or machines. Stop the old host before moving coordination to another host. Separate worktrees provide file/branch isolation, not OS security boundaries; use isolated users or containers for untrusted code. See [architecture](architecture.md) and [setup reference](setup.md).

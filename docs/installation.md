# Installation and configuration

Install GRAIT into a new or existing GitHub application repository with the prebuilt CLI at a Git commit you reviewed. One user-owned host runs the local harness. GitHub supplies issues, a Project, PRs, reviews, and deterministic CI.

## Host prerequisites

- Git, Node.js 24 or newer, npm 11.10.0 or newer, and a POSIX-compatible shell for the examples below. GitHub CLI (`gh`) manages GitHub access. Sign in with `gh auth login` before applying setup.
- One supported native harness with an eligible account. Use Codex CLI, Claude Code, or GitHub Copilot CLI. See [subscription authentication](setup.md#subscription-authentication).
- Administration access to the target GitHub repository for provisioning. The account that operates the queue also needs write access to the bound GitHub Project. See [ownership and access](#ownership-and-access).

Node.js and npm run the prebuilt CLI on the host. The application needs no GRAIT source checkout, npm manifest, GRAIT development dependencies, or local build.

## New repository

Create a regular GitHub repository and give it an initial default-branch commit. For example, choose your repository name and visibility, then run these commands from the parent directory:

```sh
gh repo create OWNER/REPOSITORY --private --clone --add-readme
cd REPOSITORY
```

Continue with [guided configuration](#guided-configuration) from the new checkout.

## Existing repository

Clone the target repository or update a clean checkout of its default branch. Keep its application manifests, CI, and instructions in place. Continue with [guided configuration](#guided-configuration). If it was created from the GRAIT template, follow [packaged migration](#existing-template-based-repository).

## Choose and run a pinned CLI

Pick a reviewed commit from the GRAIT repository and copy its full 40-character Git SHA. The example below uses a merged commit that includes installation, activation, validation, migration, upgrade, orchestration, and publishing. Retain the SHA in the configuration PR and use the same value for preview, apply, and activation.

Define this function in the shell from which you run the examples. If you start a new shell or switch to the administrator's host, define it there with the same pin.

```sh
GRAIT_REVISION=de8f47e87eea5e68c861e2dbf4855fbda5c56249
grait() {
  npm exec --yes --allow-git=all --ignore-scripts \
    --package="git+https://github.com/rodush/grait.git#$GRAIT_REVISION" -- grait "$@"
}
grait --help
```

npm puts the CLI in its cache and runs the committed bundle. The command permits Git packages for this invocation and disables package lifecycle scripts. The installer checks the running package's resolved Git revision and records the full SHA in `.grait/installation.json` and the generated validation workflow. The npm `--yes` flag accepts fetching the package. Use `--yes` after `grait init` only when you intend to accept GRAIT's configuration prompts.

## Guided configuration

1. **Prepare an integration branch.** Run `git switch -c chore/adopt-grait` from the target repository's default branch. Define the [pinned CLI function](#choose-and-run-a-pinned-cli). Replace `OWNER/REPOSITORY` with the target repository and `alice` with the GitHub login of the applying administrator. Leave `--maintainers` out to use that administrator as the default. If you specify multiple maintainers, use comma-separated logins that include the applying administrator.

2. **Preview.** Choose `codex` (the default), `claude`, or `copilot` with `--harness`. The preview reads the local target and shows the artifact diff without writing the checkout, creating private setup state, or calling GitHub APIs for provisioning. npm may fetch the CLI before the preview runs.

   ```sh
   grait init --plan --repo OWNER/REPOSITORY --revision "$GRAIT_REVISION" \
     --harness codex --maintainers alice
   ```

3. **Apply as an administrator.** Rerun the same command without `--plan`, and review the initial plan and resulting configuration diff.

   ```sh
   grait init --repo OWNER/REPOSITORY --revision "$GRAIT_REVISION" \
     --harness codex --maintainers alice
   ```

   For a scripted invocation, add `--yes` to the apply command to accept the configuration prompts. GitHub App registration and installation still require human approval. If you have an existing Project, add `--project-owner LOGIN --project-number N` to the plan and apply commands. Its Status field must include Backlog, Ready, In Progress, Review, and Done. On an SSH host, see [remote approval and recovery](#resume-remote-hosts-and-credentials) for `--no-browser`. To select a checkout from another directory, put `--cwd PATH` before `init`.

4. **Publish the reviewed configuration.** Setup creates or reuses the Project and two verified publishing Apps. It applies the selected harness files, `workflow.config.json`, CODEOWNERS, `.github/workflows/grait.yml`, and `.grait/installation.json` together. App keys and operational state stay in private Git metadata. Add your application-specific instructions and configure its write scopes and test runner before starting testable work. Run `grait validate`, review and commit the configuration together, then push the integration branch and open a configuration PR using your authorized GitHub account. Run your application checks alongside the generated GRAIT validation workflow.

5. **Activate after human merge and CI.** Update your checkout to the repository's default branch after a human merges the configuration PR and CI passes on that branch. With the same CLI pin, run:

   ```sh
   grait activate
   ```

   Activation checks human merge, the installed artifacts at the merge and current default-branch head, CI, the Project binding, CODEOWNERS, both App installations, and repository delivery rules. An administrator must resolve any failed check before retrying. Once activated, run `grait orchestrator start` and follow [operations](operations.md).

## Ownership and access

A contributor can run the read-only preview. Include its output, the target repository, the full GRAIT SHA, and the harness and Project choices in the integration proposal. An administrator repeats the preview and applies setup on an integration branch in a clone of the target repository. For a fork contribution, use the intended upstream in `--repo OWNER/REPOSITORY` when you prepare the plan. The upstream administrator applies setup against upstream, where the Apps, Project binding, and repository variables belong.

The runtime host needs the bound Project's write access and the publishing App keys. Keep the keys in the host's private Git metadata and share the plan through the PR.

## Existing template-based repository

### Migrate a configured template to the pinned CLI

Stop the local orchestrator and create an integration branch with `git switch -c chore/migrate-grait`. Define [the pinned CLI](#choose-and-run-a-pinned-cli) with the reviewed package SHA. Replace `FULL_TEMPLATE_SHA` below with the full SHA of the GRAIT template commit used when the repository was created.

```sh
TEMPLATE_REVISION=FULL_TEMPLATE_SHA
grait migrate --plan --revision "$GRAIT_REVISION" --legacy-revision "$TEMPLATE_REVISION"
```

Migration fetches the template pin into temporary storage and compares it with the target. A removable legacy file must match the selected template's path, tracked blob, mode, and worktree bytes. Migration keeps existing Codex settings and customized policy text and appends the packaged policy blocks. Literal references in retained files keep the legacy tooling and dependencies on which those files rely. The scan skips Markdown and installed npm dependencies. Check dynamically constructed paths against the proposed removals. If the stock workflow runs application tests or customized npm scripts, move those application checks to a dedicated workflow before retiring the stock check.

Review the plan, then rerun without `--plan`, or pass `--yes` after `migrate` for scripted application. Migration adds the pinned validation workflow and installation record, and retains the existing workflow configuration, CODEOWNERS, Project binding, publishing identities, and private host credentials. Open one PR for human merge. Confirm GRAIT and application CI before resuming operations with the pinned CLI. Check the staged [setup review command](operations.md#review-publication) if an existing rule requires agent review for the configuration PR before activation.

If a file transaction is interrupted, preserve the journal and retry with both original pins.

### Repair a legacy template checkout before migration

The source-checkout setup commands apply to a template repository that still includes GRAIT's legacy tooling. Use this path if migration requires repairing an unconfigured template or incomplete publishing bindings first. Stop its automation, review the existing Project and App bindings, and use the clean target branch for the repair.

```sh
npm run setup -- --plan --repo OWNER/REPOSITORY
npm run setup -- --repo OWNER/REPOSITORY
```

The legacy setup can publish its own configuration commit through the writer App. After an interrupted legacy publish, check the remote branch and PR first, then rerun `npm run setup -- --publish` on the exact clean configuration branch if publication needs to be retried. After human merge and successful default-branch CI, `npm run setup -- --activate` activates that legacy checkout. Return to [packaged migration](#migrate-a-configured-template-to-the-pinned-cli) once its configuration is sound.

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
grait init --repo OWNER/REPOSITORY --revision "$GRAIT_REVISION" \
  --yes --acknowledge-unenforced-rules
```

Repeat your original target, harness, and Project flags as needed. `--yes` accepts the ordinary setup plan only; it does not acknowledge unenforced rules. Keep the saved Apps, Project binding, and Git revision when retrying. A ruleset pause can leave provisioning state before the installation artifacts are applied. If the command leaves a stale lock, follow the [recovery instructions](#resume-remote-hosts-and-credentials).

Activation needs its own acknowledgement if GitHub still cannot enforce the rules:

```sh
grait activate --acknowledge-unenforced-rules
```

Each invocation attempts automatic ruleset configuration again. The repository variable `RULESET_ENFORCEMENT` records `pending`, `staged`, `active`, or `unenforced`; acknowledgement never claims that rules are active. Other setup failures, including invalid credentials, Project permissions, CI, or configuration, still require correction.

## Upgrade an existing GRAIT installation

From a packaged installation, create an integration branch and define [the pinned CLI](#choose-and-run-a-pinned-cli) with the current installation's SHA. Select a reviewed target SHA and replace `FULL_TARGET_SHA` below.

```sh
GRAIT_UPGRADE_REVISION=FULL_TARGET_SHA
grait upgrade --plan --revision "$GRAIT_UPGRADE_REVISION"
```

A running package with automatic upgrade fetching, introduced in GRAIT PR #58, fetches and verifies the requested revision when necessary. With an older running package, first set `GRAIT_REVISION` to the target SHA and use that package to preview and apply the upgrade. [Automatic revision fetching](https://github.com/rodush/grait/pull/58)

Review the diff and repeat without `--plan`, or use `--yes` after `upgrade` for scripted application. The transaction updates managed instructions, the validation workflow pin, and the installation record. It preserves the project-owned workflow configuration, CODEOWNERS, and text outside GRAIT-managed blocks. If a managed edit conflicts, restore the recorded managed content and move the customization outside its block before retrying.

Commit the complete upgrade in one PR. After human merge and CI, update `GRAIT_REVISION` to the SHA recorded in `.grait/installation.json` before running day-to-day commands. For a template installation, [migrate first](#existing-template-based-repository).

## Resume, remote hosts, and credentials

- **Interrupted setup.** Keep the private recovery state and retry `grait init` with the original package pin, repository, harness, and Project choices. An interrupted file transaction is reported by preview and recovered by a confirmed retry. If App registration or Project creation has an uncertain outcome, reconcile the recorded object before retrying. If activation failed, reconcile the cause and rerun `grait activate` at the same pin.
- **Interrupted configuration publication.** The packaged installer applies artifacts locally. Keep the configuration commit and check the remote branch and PR before retrying a push or PR creation with your authorized GitHub account. If the PR already exists, continue with it. For a claimed story, use [writer publication recovery](operations.md#pause-and-recovery).
- **Stale setup lock.** Confirm its recorded process has stopped, inspect the lock, and remove only that stale lock before retrying. Keep the journal and App credentials for recovery.
- **Another host.** Authenticate GitHub CLI and the native harness there, stop the old orchestrator, and securely transfer the private `<git-common-dir>/grait-setup/` directory with mode 700 for the directory and mode 600 for files. Exclude the old lock. Run `grait activate` on the new host after transferring setup state. For key import during initial provisioning, see the [publishing identity bindings](setup.md#publishing-identity-bindings).

On an SSH host, pass `--no-browser` to `grait init` and forward the printed callback port to your browser machine, for example `ssh -L PORT:127.0.0.1:PORT HOST`. Open the printed loopback URL and finish GitHub's approvals. Setup uses the saved port on retry.

Run **one orchestrator host per Project**. Command locks coordinate linked worktrees that share Git metadata. Keep private setup data out of commits and PRs. See [architecture](architecture.md), [setup reference](setup.md), and [Project access troubleshooting](project/setup-troubleshooting.md).

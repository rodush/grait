# Validate Git-pinned CLI adoption

This walkthrough covers a fresh installation, a Project status check, an upgrade, and migration from the source template. The acceptance run exercised the installed npm package in isolated shell and existing npm applications, using fake GitHub services for provisioning and publishing. In both applications, the existing manifests and CI stayed intact and adoption added no GRAIT source checkout or development dependencies.

Run the examples from the root of a GitHub application checkout. Use an integration branch and a clean working tree for each operation. The host needs Git, Node.js 24 or newer, npm 11.10.0 or newer, GitHub CLI, and the selected local harness. For live setup, sign in with `gh auth login` and use an account that can administer the target repository, approve the publishing Apps, and access the Project. [Installation and configuration](../installation.md)

## Pin the package and install

Replace `OWNER/REPOSITORY` with the target GitHub repository and `MAINTAINER` with the GitHub login of the human maintainer. Choose a reviewed GRAIT commit containing the prebuilt CLI and replace every `GIT_PIN` below with its full Git SHA. Define this shell function once in your terminal. It runs the package at `GRAIT_PACKAGE_REVISION` and disables npm lifecycle scripts for that invocation.

```sh
GRAIT_PACKAGE_REVISION=GIT_PIN
grait() {
  npm exec --yes --allow-git=all --ignore-scripts \
    --package="git+https://github.com/rodush/grait.git#$GRAIT_PACKAGE_REVISION" -- grait "$@"
}
```

Preview the changes, then apply the reviewed plan with the same pin. The examples select Codex as the local harness. `--yes` accepts the plan and artifact diff. GitHub App registration and installation still require human approval.

```sh
grait init --plan --repo OWNER/REPOSITORY --revision GIT_PIN --harness codex --maintainers MAINTAINER
grait init --yes --repo OWNER/REPOSITORY --revision GIT_PIN --harness codex --maintainers MAINTAINER
```

Check that `.grait/installation.json` records the selected SHA and the generated validation workflow uses that pin. Review the diff and open a configuration PR. After human merge and successful validation on the current default-branch head, update your local default branch. Run activation there with the same wrapper and pin, then check that the CLI can read the configured Project.

```sh
grait activate
grait orchestrator status
```

Check that your application test and CI commands still work. For a shell application, run its existing shell check without adding an npm manifest. For an npm application, run its existing test script with its original manifest and lockfile.

## Upgrade a packaged installation

Choose a reviewed target commit and replace `UPGRADE_PIN` with its full Git SHA. On a new integration branch, switch the wrapper to that same target pin before preview and apply.

```sh
GRAIT_PACKAGE_REVISION=UPGRADE_PIN
grait upgrade --plan --revision UPGRADE_PIN
grait upgrade --yes --revision UPGRADE_PIN
```

Review the new pin in the installation record and the validation workflow. Check that application files, workflow configuration, and custom policy outside managed blocks are preserved. Commit the changes together and submit a PR for human merge.

## Migrate a configured template repository

Use a separate checkout of the configured template-based application. Stop its local orchestrator and create an integration branch. Replace `TEMPLATE_SHA` with the full SHA of the original template commit and set the wrapper to the reviewed package revision selected for migration.

```sh
GRAIT_PACKAGE_REVISION=GIT_PIN
grait migrate --plan --revision GIT_PIN --legacy-revision TEMPLATE_SHA
grait migrate --yes --revision GIT_PIN --legacy-revision TEMPLATE_SHA
```

Inspect removals before applying the plan. Migration removes matching stock tooling when retained application files do not reference it. Review the diff for retained application checks, ownership rules, and configuration. Run the application checks and submit the changes together for human merge. Use the installed CLI on the configured host once the required checks pass. [Template migration](../installation.md#existing-template-based-repository)

## Resume an interrupted operation

Preserve the private Git metadata and any pending artifact transaction. Retry from the same checkout with the original package and command pins, including both pins for migration. Review any recovery conflict before retrying. If a lock remains, inspect its recorded process and confirm that it stopped before removing the stale lock. If GitHub creation or publication is uncertain, reconcile the recorded App, Project, branch, or PR before retrying. [Setup troubleshooting](setup-troubleshooting.md)

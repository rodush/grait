# Adopt the template

## Repository tooling runtime

Node.js 24 runs GRAIT's JavaScript scripts under `scripts/`: Project coordination, dependency and review-loop policy, bootstrap, activation, and releases. npm installs their locked dependencies and provides the formatter and Markdown linter. These are development and automation dependencies; application code may use Python, Go, Rust, or any other stack with separate install, build, test, and run commands.

GitHub Actions installs Node.js on hosted runners. Install Node.js 24 and npm locally when adopting the template, changing automation, regenerating workflows, or running template checks. Merely opening issues, reviewing PRs, or using the Project board requires no local Node.js installation. There is no application server or `npm start` command in this template.

Run the following from the repository root after installing the prerequisites below:

| Command                                   | When to use it                                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                  | Install the exact tooling dependencies from `package-lock.json` after cloning or a lockfile update.                                                                             |
| `npm run check`                           | Validate configuration, workflow boundaries, local documentation links, and generated harness adapters.                                                                         |
| `npm test`                                | Run deterministic controller, policy, API, and security tests without live GitHub credentials.                                                                                  |
| `npm run format` / `npm run format:check` | Apply formatting or check it without changing files.                                                                                                                            |
| `npm run lint:md`                         | Check Markdown conventions.                                                                                                                                                     |
| `npm run harness:generate`                | Regenerate native skills and agent definitions after editing their canonical sources.                                                                                           |
| `npm run compile`                         | Regenerate gh-aw workflow lockfiles and shared policy copies after changing workflow sources, imported policies, or engine configuration; requires the pinned `gh aw` compiler. |
| `npm run compile -- --check`              | Verify generated workflow files match their sources without modifying the checkout.                                                                                             |
| `npm run check:profiles`                  | Compile all six engine/authentication profiles in temporary directories.                                                                                                        |

The bootstrap and activation commands later in this guide change GitHub configuration and require operator credentials. Normal template tests do not invoke them. Commit source changes together with regenerated files. CI runs the template checks automatically; add your application's own checks when choosing its stack.

## Prerequisites and local harnesses

Before sharing the starter, its repository owner enables **Template repository** in Settings → General. A derived application repository does not need that setting.

Create a repository from this template, clone it, and install Node.js 24, npm 12.2.2, GitHub CLI, and the pinned compiler:

```sh
gh extension install github/gh-aw --pin v1.2.2
npm install --global npm@12.2.2 --ignore-scripts --min-release-age=3
npm ci
```

The canonical local Codex profile is `config/codex.toml`. It preserves `gpt-6.1-sol`, high reasoning, on-request approval, workspace-write, and the terminal-title item order. The template includes the matching `.codex/config.toml`; `npm run check` verifies that an installed copy matches the profile.

**Important note!** When copying the scaffold into an existing repository, inspect its configuration before installing a missing copy:

```sh
mkdir -p .codex
test ! -e .codex/config.toml && cp config/codex.toml .codex/config.toml
```

If `.codex` is protected by your execution environment, an operator must install that file. The template's compiler reads `config/codex.toml` directly to reuse the model and reasoning defaults for hosted Codex. Hosted sandboxing and noninteractive permissions are managed by gh-aw rather than the local interactive approval policy. See the [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Claude uses `CLAUDE.md`; Copilot uses `.github/copilot-instructions.md`. Both point to the shared guidance. Select `codex`, `claude`, or `copilot` in `workflow.config.json`, then recompile. Set an explicit `AGENT_MODEL` for the chosen engine; Codex defaults to the model from its profile. Add the application stack's commands and network requirements when introducing it. Default automated write scopes are `src/**`, `tests/**`, `assets/**`, and `docs/project/**`; root policy documents and automation remain protected. Configure additional exact file paths or `directory/**` scopes deliberately.

## Dependency maturity

The committed `.npmrc` requires releases to be at least **three days old** (`min-release-age=3`, in days), disables install scripts, and saves exact versions. npm 11.10.0 or newer is required for the age gate; CI pins the current stable npm 12.2.2. Use the newest stable release that satisfies the age gate, including for engine CLIs in `workflow.config.json`; do not bypass the gate to install a newer release. Dependency locks remain reproducible, so the age gate primarily protects new resolution, not previously committed lock entries. Dependabot uses a matching three-day cooldown. Regenerate and review lockfiles when updating dependencies. Hosted compiler-managed npm installers also enforce the three-day age gate.

The compiler is gh-aw 1.2.2 with its matching immutable runtime SHA. Do not downgrade below a security-fixed release. Regenerate all workflow lockfiles when upgrading; changing only the local compiler does not update the deployed runtime.

## Shared skills and agents

The template includes five reusable skills and matching agent definitions for Codex, Claude Code, and Copilot. See [the role catalog](agents.md) for invocation and execution boundaries. Edit `automation/skills/` or `automation/agents.json`, then regenerate with `npm run harness:generate`. Models and permissions remain inherited from the selected harness; local review requests route to GitHub Actions.

## Credentials and identities

Use separate writer and reviewer identities, neither of which is a human operator. GitHub Apps are the default. Create and install separate writer, reviewer, and release apps on the derived repository. Do not give any app a branch-ruleset bypass. The release app alone bypasses release-tag creation restrictions, never tag updates/deletions.

| Identity              | Permissions                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Writer/controller app | Contents, Issues, Pull requests, Actions, and Commit statuses: read/write; metadata: read                             |
| Reviewer app          | Contents: read; Issues and Pull requests: read/write                                                                  |
| Project credential    | Projects: read/write, plus read access to every repository represented on the board and Issues: read for dependencies |
| Release app           | Contents: read/write; metadata: read. Store its key only in the protected `release` environment                       |
| Bootstrap operator    | Repository administration, Actions variables, environments, and project administration                                |

For organization-owned Projects, the writer app may also have Organization projects read/write. For user-owned Projects, supply a suitable project token. Project reads must cover every story; inaccessible In Progress items count conservatively, and unknown dependencies block work. See [GitHub's project authentication guidance](https://github.github.com/gh-aw/reference/auth-projects/).

Repository variables:

- `AUTOMATION_APP_CLIENT_ID` and `REVIEW_APP_CLIENT_ID` for app mode.
- `AUTOMATION_LOGIN` and `REVIEW_LOGIN`: exact publishing identities, such as `my-writer[bot]` and `my-reviewer[bot]`.
- `PROJECT_ID`, `AGENT_MODEL`, `AUTOMATION_ENABLED`, `AUTOMATION_BUDGET_ISSUE`, and `AUTOMATION_BUDGET_LOGIN`, configured by bootstrap.
- `RELEASE_APP_CLIENT_ID` for the dedicated release app; bootstrap records its numeric `RELEASE_APP_ID` from `--release-app-id`.

Repository secrets:

- App mode: `AUTOMATION_APP_PRIVATE_KEY` and `REVIEW_APP_PRIVATE_KEY`.
- Token mode: select `"authentication": "token"` and supply `AUTOMATION_TOKEN` and `REVIEW_TOKEN`. Use distinct dedicated accounts or app tokens; refresh expiring supplied tokens yourself.
- `PROJECT_TOKEN` when project access is separate from writer authentication; also export it locally for bootstrap and activation if needed.
- Codex: `CODEX_API_KEY` or `OPENAI_API_KEY`; Claude: `ANTHROPIC_API_KEY`; Copilot: `COPILOT_GITHUB_TOKEN`.

Configure secrets with `gh secret set NAME --repo OWNER/REPO`; enter values interactively. Never put them in configuration files or command examples. The activation tool checks these repository-level secret names. Store **only** the release credential in the protected `release` environment: `gh secret set RELEASE_APP_PRIVATE_KEY --env release --repo OWNER/REPO` for App mode, or `RELEASE_TOKEN` for token mode. The release token must belong to a configured human operator, have Contents write, and must not be an implementation/reviewer token. The release app needs only Contents write; CI verification uses the job’s read-only token.

## Project and repository setup

Inspect the plan first, replacing the example identities:

```sh
npm run bootstrap -- --repo OWNER/REPO --project-owner OWNER --maintainers alice,bob --writer-login 'writer[bot]' --reviewer-login 'reviewer[bot]' --release-app-id 123456
```

Add `--apply` to apply that plan. It creates a project, changes its default view to Kanban, configures the five statuses, binds one controller, links the repository, creates labels and a release environment, and stages the two delivery/merge rulesets disabled, and activates two release-tag rulesets immediately. It also creates a dedicated budget issue and an initial ledger authored by the authenticated human operator. Keep that issue and its ledger comment; deleting either blocks dispatch rather than resetting the budget. In token mode omit `--release-app-id`; only configured human operators may create release tags. It writes the local controller identity and human CODEOWNERS. Automation remains disabled during setup. Reusing an existing project requires `--project-number N` and all five Status options already configured; an existing project's views and statuses are preserved.

Bootstrap requires GitHub features for rulesets, code-owner approval, and environment reviewers. If your account or repository plan does not support them, setup stops; decide how to provide equivalent controls before enabling automation. GRAIT's license is recorded in `LICENSE`; bootstrap does not change it.

## Compile, validate, and activate

```sh
npm run format
npm run harness:generate
npm run check
npm test
npm run lint:md
npm run compile -- --approve
npm run compile -- --check
```

Use `--approve` only after inspecting the compiler's changes to actions and secret bindings. It records the accepted manifest in each lockfile's header. Commit the sources, generated shared components, lockfiles, CODEOWNERS, and configured JSON to the default branch while the delivery rules are still staged. Run default-branch CI successfully before activation.

```sh
npm run activate
gh workflow run controller.yml
```

Activation checks the committed configuration, identities, credential names, project binding, and ownership before activating all four rulesets and enabling the controller. Confirm that the board groups by Status. For an outsider’s issue or fork PR, a maintainer must first apply `agent:admitted`; repository writers and configured identities are admitted automatically. This admission is separate from agent triage and Ready authorization. Add a small issue and verify triage, claiming, hosted implementation, CI, inline review, follow-up fixes, and human squash merge in GitHub. Repeat with a fork PR to verify the read-only review path. These hosted checks require real credentials and cannot be established by local unit tests.

The rulesets keep human merge authority separate from delivery gates: human operators may bypass only the update restriction through a PR; no identity bypasses the required checks or human code-owner approval. Add project-specific CI checks to the delivery rules once a stack exists.

## Adopt the TDD pipeline

Read [the tester-first protocol](tdd.md), configure `tdd.testPatterns`, implementation scopes, runner image/commands, and optional per-role model/reasoning settings before enabling automation. The Node reference runner verifies the template tests; replace its adapter/image when adopting another stack. New triage attestations must explicitly assess TDD applicability. Existing work without that assessment needs retriage. The independent `TDD verification` workflow is dispatched by the controller and consumes the same global concurrency budget; deterministic verification reserves one credit conservatively. Keep source and generated workflows together.

## CI publisher provenance

Bootstrap and activation resolve the GitHub Actions App ID from the authenticated GitHub API (`apps/github-actions`) before changing repository settings. The required `Template validation` check is bound to that publisher, so another integration cannot satisfy the gate merely by using the same check name. Missing or invalid publisher metadata stops setup without a hardcoded-ID fallback.

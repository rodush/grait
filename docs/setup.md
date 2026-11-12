# Adopt the template

## Prerequisites and local harnesses

Before sharing the starter, its repository owner enables **Template repository** in Settings → General. A derived application repository does not need that setting.

Create a repository from this template, clone it, and install Node.js 24, GitHub CLI, and the pinned compiler:

```sh
gh extension install github/gh-aw --pin v0.88.7
npm ci
```

The canonical local Codex profile is `config/codex.toml`, based on [expense-tracker PR #86](https://github.com/rodush/expense-tracker/pull/86). It preserves `gpt-6.1-sol`, high reasoning, on-request approval, workspace-write, and the terminal-title item order. The template includes the matching `.codex/config.toml`; `npm run check` verifies that an installed copy matches the profile. When copying the scaffold into an existing repository, inspect its configuration before installing a missing copy:

```sh
mkdir -p .codex
test ! -e .codex/config.toml && cp config/codex.toml .codex/config.toml
```

If `.codex` is protected by your execution environment, an operator must install that file. The template's compiler reads `config/codex.toml` directly to reuse the model and reasoning defaults for hosted Codex. Hosted sandboxing and noninteractive permissions are managed by gh-aw rather than the local interactive approval policy. See the [official Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

Claude uses `CLAUDE.md`; Copilot uses `.github/copilot-instructions.md`. Both point to the shared guidance. Select `codex`, `claude`, or `copilot` in `workflow.config.json`, then recompile. Set an explicit `AGENT_MODEL` for the chosen engine; Codex defaults to the model from its profile. Add the application stack's commands and network requirements when introducing it. Default automated write scopes are `src/**`, `tests/**`, `assets/**`, and `docs/project/**`; root policy documents and automation remain protected. Configure additional exact file paths or `directory/**` scopes deliberately.

## Shared skills and agents

The template includes four reusable skills and matching agent definitions for Codex, Claude Code, and Copilot. See [the role catalog](agents.md) for invocation and execution boundaries. Edit `automation/skills/` or `automation/agents.json`, then regenerate with `npm run harness:generate`. Models and permissions remain inherited from the selected harness; local review requests route to GitHub Actions.

## Credentials and identities

Use separate writer and reviewer identities, neither of which is a human operator. GitHub Apps are the default. Create and install a writer app and reviewer app on the derived repository. Do not give either app a branch-ruleset bypass.

| Identity              | Permissions                                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Writer/controller app | Contents, Issues, Pull requests, Actions, and Commit statuses: read/write; metadata: read                             |
| Reviewer app          | Contents: read; Issues and Pull requests: read/write                                                                  |
| Project credential    | Projects: read/write, plus read access to every repository represented on the board and Issues: read for dependencies |
| Bootstrap operator    | Repository administration, Actions variables, environments, and project administration                                |

For organization-owned Projects, the writer app may also have Organization projects read/write. For user-owned Projects, supply a suitable project token. Project reads must cover every story; inaccessible In Progress items count conservatively, and unknown dependencies block work. See [GitHub's project authentication guidance](https://github.github.com/gh-aw/reference/auth-projects/).

Repository variables:

- `AUTOMATION_APP_CLIENT_ID` and `REVIEW_APP_CLIENT_ID` for app mode.
- `AUTOMATION_LOGIN` and `REVIEW_LOGIN`: exact publishing identities, such as `my-writer[bot]` and `my-reviewer[bot]`.
- `PROJECT_ID`, `AGENT_MODEL`, and `AUTOMATION_ENABLED`, configured by bootstrap.

Repository secrets:

- App mode: `AUTOMATION_APP_PRIVATE_KEY` and `REVIEW_APP_PRIVATE_KEY`.
- Token mode: select `"authentication": "token"` and supply `AUTOMATION_TOKEN` and `REVIEW_TOKEN`. Use distinct dedicated accounts or app tokens; refresh expiring supplied tokens yourself.
- `PROJECT_TOKEN` when project access is separate from writer authentication; also export it locally for bootstrap and activation if needed.
- Codex: `CODEX_API_KEY` or `OPENAI_API_KEY`; Claude: `ANTHROPIC_API_KEY`; Copilot: `COPILOT_GITHUB_TOKEN`.

Configure secrets with `gh secret set NAME --repo OWNER/REPO`; enter values interactively. Never put them in configuration files or command examples. The initial activation tool checks repository-level secret names; configure them there for this baseline.

## Project and repository setup

Inspect the plan first, replacing the example identities:

```sh
npm run bootstrap -- --repo OWNER/REPO --project-owner OWNER --maintainers alice,bob --writer-login 'writer[bot]' --reviewer-login 'reviewer[bot]'
```

Add `--apply` to apply that plan. It creates a project, changes its default view to Kanban, configures the five statuses, binds one controller, links the repository, creates labels and a release environment, and stages two disabled rulesets. It writes the local controller identity and human CODEOWNERS. Automation remains disabled during setup. Reusing an existing project requires `--project-number N` and all five Status options already configured; an existing project's views and statuses are preserved.

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

Activation checks the committed configuration, identities, credential names, project binding, and ownership before activating both rulesets and enabling the controller. Confirm that the board groups by Status. Add a small issue and verify triage, claiming, hosted implementation, CI, inline review, follow-up fixes, and human squash merge in GitHub. Repeat with a fork PR to verify the read-only review path. These hosted checks require real credentials and cannot be established by local unit tests.

The rulesets keep human merge authority separate from delivery gates: human operators may bypass only the update restriction through a PR; no identity bypasses the required checks or human code-owner approval. Add project-specific CI checks to the delivery rules once a stack exists.

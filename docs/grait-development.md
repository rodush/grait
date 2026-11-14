# GRAIT development

Use this file when changing GRAIT's policy, automation scripts, reusable roles and skills, harness adapters, or tooling tests. It applies both to the template repository and to GRAIT tooling maintained inside an adopting project. For application features, use the application's own stack and command reference linked from `AGENTS.md`.

## Runtime and commands

GRAIT tooling uses Node.js 24 and the npm version recorded in its tooling `package.json`. This runtime supports the automation; the application may use any language. `.npmrc` keeps dependency install scripts disabled and requires package maturity.

Run commands from the tooling package directory, which is the repository root in the unmodified template. When integrating into an existing npm application, document any renamed tooling scripts and their working directory instead of replacing the application's scripts.

| Command                    | Purpose                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `npm ci`                   | Install locked tooling dependencies                                          |
| `npm run check`            | Check configuration, workflow policy, documentation links, and harness drift |
| `npm test`                 | Run GRAIT automation tests under `tests/*.test.mjs`                          |
| `npm run format:check`     | Check repository formatting                                                  |
| `npm run lint:md`          | Check Markdown                                                               |
| `npm run harness:generate` | Regenerate native adapters after canonical source changes                    |

Edit canonical sources first. Regenerate adapters after changing `automation/skills/`, `automation/agents.json`, or role profiles; edit `config/codex.toml` rather than its installed `.codex/config.toml` copy. Run the relevant checks above and report the commands actually run and any missing validation. Follow [the coding guidelines](coding-guidelines.md) for testing expectations.

## Application development in adopting projects

When choosing an application stack, document its runtime versions, command working directories, install, build, test, lint, and local-run commands under `docs/project/` and link that reference from `AGENTS.md`. Configure the corresponding TDD runner. Existing applications should retain and link their established documentation. The inherited GRAIT npm package does not establish the application stack.

GRAIT's checks validate the automation. Application behavior requires the application's own checks. For changes affecting both, run both sets of relevant checks and report their results separately. Preserve required repository-wide CI checks.

For installing and operating GRAIT rather than modifying it, see [installation](installation.md) and [the setup reference](setup.md).

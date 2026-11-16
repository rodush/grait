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

## Git distribution policy (Milestone 1)

[Milestone 1: Deliver workflow setup CLI](https://github.com/rodush/grait/milestone/1) establishes the move from a copied repository template to a versioned installer and runtime package. This section records the agreed development requirements. The current template has no packaged `grait` executable or bundle command yet; implement and document those through scoped issues before describing them as available.

### Install directly from Git

Support installation and execution from a remote Git revision without publishing to the npm registry. A development branch may be used to explore bleeding-edge changes; document full commit SHAs for reproducible trials and record the resolved revision in installation metadata. A branch name alone is not an immutable version. npm supports a commit suffix in [Git package references](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#git-urls-as-dependencies).

Once the executable exists, the intended usage is equivalent to:

```sh
npm exec --ignore-scripts --package='git+https://github.com/rodush/grait.git#COMMIT_SHA' -- grait init
```

Replace `COMMIT_SHA` with the selected full revision. This is a future interface example, not a command supported by the current template. The installer and ongoing runtime must resolve their implementation and bundled templates from the installed package, independently of the target repository's directory layout. The application must not need GRAIT's source checkout, npm manifest, lockfile, development dependencies, or copied implementation scripts.

### Commit the runnable distribution

Generate ready-to-run CLI code and required template assets under `dist/` and commit them alongside their source changes in GRAIT's own repository. The committed distribution is intentional executable output, similar to the distribution model of JavaScript GitHub Actions. Consumers must not need a local compiler, bundler, or GRAIT development dependencies.

Edit source and canonical templates first, then regenerate distribution output. Do not patch generated runtime files independently. Define an explicit package file allowlist and executable entrypoint so the installable package contains the required runtime/assets rather than the development repository. Make runtime dependencies explicit; do not rely on dependencies available only in the developer's checkout. Node.js and any other runtime prerequisites remain requirements and must be documented separately.

Distribute GRAIT through remote Git revisions and committed `dist/` files. Do not introduce `.tgz` archives as a local, CI, or user-facing delivery workflow, and do not commit or publish them. Keep credentials, setup journals, and target-project configuration out of `dist/`. Committing runnable files does not authorize npm publication, a release, or an automatic merge.

### Bundle explicitly; do not build on the user's machine

Provide an explicitly invoked developer/CI command such as `npm run bundle`. Preserve `ignore-scripts=true` and support Git installation with scripts disabled. Do not rely on `prepare`, `prepack`, or installation lifecycle hooks to build the consumer's package.

There is an additional npm Git-installation constraint: a root script named `build` can trigger package preparation even when artifacts are already committed. The [npm Git dependency documentation](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#git-urls-as-dependencies) lists `build`, `prepare`, `prepack`, `preinstall`, `install`, `postinstall`, and `workspaces` as preparation triggers. Keep these out of the Git-installable package manifest for the prebuilt distribution approach. If introducing a workspace layout or changing packaging, re-evaluate and test the no-consumer-build guarantee explicitly.

### Validate the artifact boundary

When implementing this architecture, add these checks to CI:

- Regenerate `dist/` using locked development dependencies and deterministic output. Fail on tracked differences, missing files, or unexpected untracked generated files. Source and committed artifacts must agree.
- Inspect the files included by Git installation to verify the executable, policy templates, and runtime assets are included while development scaffolding, temporary state, and secrets are excluded.
- Install from a remote Git revision and smoke-test with scripts disabled in an isolated environment without access to the development checkout or its `node_modules`.
- Verify that the selected commit's committed artifacts run without consumer-side preparation and that installation metadata records the resolved revision.
- Test both installation and ongoing runtime commands from another working directory. Verify that only intended durable workflow artifacts enter the target repository and that application manifests, existing instructions, and application CI are preserved.

These checks are requirements for future implementation, not checks claimed to exist today. Keep quick source-based development separate from distribution acceptance: a successful linked or source-checkout run is insufficient evidence that a Git-installed package works.

## Application development in adopting projects

When choosing an application stack, document its runtime versions, command working directories, install, build, test, lint, and local-run commands under `docs/project/` and link that reference from `AGENTS.md`. Configure the corresponding TDD runner. Existing applications should retain and link their established documentation. The inherited GRAIT npm package does not establish the application stack.

GRAIT's checks validate the automation. Application behavior requires the application's own checks. For changes affecting both, run both sets of relevant checks and report their results separately. Preserve required repository-wide CI checks.

For installing and operating GRAIT rather than modifying it, see [installation](installation.md) and [the setup reference](setup.md).

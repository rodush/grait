# Installed project policy

The project-artifact generator reads shared engineering policy from `automation/policy/shared.md`. It combines that policy with a project's name and context to produce `AGENTS.md`, then adds only the selected Codex, Claude Code, or Copilot integration. GRAIT's development tooling and development instructions stay in the source repository.

`src/project-policy.mjs` exports asynchronous `generateProjectArtifacts({ harness, version, project, existing })`. `project` accepts optional `name` and `context` strings; `existing` maps repository-relative paths to their current text. The function returns a path-to-text object without reading or writing the target repository. Callers collect current artifact text and pass the proposed result to the staging layer for review and application.

Every generated text section records its policy version between `grait:policy:start` and `grait:policy:end` markers. Markdown uses HTML comments; TOML uses line comments. Existing user text outside a managed section remains byte-for-byte intact. Repeat generation with the same inputs is stable. Missing, malformed, duplicated, or reversed boundaries require reconciliation rather than an automatic replacement. Managed-content drift and upgrade ownership are checked by the upgrade layer before applying generated output.

All six workflow roles receive instructions for local execution, readiness, tester/implementer ownership, independent review, and bounded fixes. Their instructions reference the packaged `grait orchestrator` and `grait github` commands. Skills and role adapters are installed only for the selected harness. The generator preserves model choices, permissions, and other existing harness settings. An existing named Codex role keeps its TOML settings; managed guidance is added as comments and its companion skill supplies the shared role instructions.

The generated instructions require project-specific runtime versions, working directories, and exact validation commands. They do not infer an application stack from GRAIT's own tooling. Application manifests, CI, and unrelated harness files are outside this generator's output.

For tooling maintenance commands and the package boundary, see [GRAIT development](grait-development.md).

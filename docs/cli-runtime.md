# Packaged workflow operations

The Git-installed CLI supplies ongoing workflow commands as well as its help and version interfaces. Run these commands in a configured, activated target repository; GRAIT's source tree and development dependencies are not needed in the application.

```sh
grait orchestrator status
grait orchestrator claim --issue 123
grait orchestrator worktree --issue 123
grait github push --issue 123
grait github pr --issue 123 --title 'feat: accepted behavior' --body-file /tmp/pr.md
grait github checks --pr 456
grait orchestrator review --pr 456 --file /tmp/review.json
```

Use `grait orchestrator --help` or `grait github --help` for the complete command options. Existing source-checkout npm commands remain available for GRAIT development.

## Select the target

The current Git worktree supplies `workflow.config.json`, the application test runner, and the issue branch. A command started in a nested directory resolves that worktree's root. To select another repository explicitly, put `--cwd PATH` before the command:

```sh
grait --cwd /work/application/src orchestrator status
```

Private App credentials and activation state remain in the target's Git common directory, shared by its linked worktrees. The installed package supplies runtime helpers and the Node test adapter; it never looks for a copied `scripts/` directory in the application. Native workers use the selected harness's installed skills.

## Delivery gates and identities

Packaged commands retain the existing readiness, dependency, pause, capacity, and Review priority checks. Implementation publishing uses the configured writer App; review publication uses the separate reviewer App. Normal PRs require independent Green for their exact committed head, and each review remains bound to the evaluated PR head. Human approval, merge, and release authority remain unchanged.

The runtime refuses unactivated hosts and paused repositories. It does not treat command installation as activation, replace publishing identities, bypass permission prompts, or enable API billing. See [operations](operations.md) for the complete lifecycle and [installation](installation.md) for the existing setup and recovery process.

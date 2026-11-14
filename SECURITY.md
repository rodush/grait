# Security policy

## Report a vulnerability

Use this repository's **Security → Report a vulnerability** feature when private vulnerability reporting is enabled. Do not open a public issue containing exploit details, credentials, or private data. If the feature is unavailable, contact the maintainer through the repository owner's published contact channel. Maintainer contact and supported release versions must be configured when adopting this template.

## Automation boundaries

Use separate implementation and review publishing identities. The official Codex or Claude Code harness owns provider authentication; GRAIT never collects its subscription tokens or silently switches to API billing. GitHub publishing keys stay in private Git metadata on the user host, and local commands mint repository-scoped short-lived installation tokens.

Worktrees are file/branch isolation, not security sandboxes. Any process running as the same OS user may access that user's files and credentials. Run untrusted code in an isolated user/container, and never execute PR code in a credentialed reviewer session. Stop the previous host before moving orchestration to another machine; local locks do not coordinate independent hosts.

Application CI runs with a read-only token and no repository secrets on pull requests, including forks. Workflow definitions and automation policy require human ownership. Do not give an automation app a branch-rule bypass or a role that can satisfy the required human approval.

Configure secret scanning, push protection, private vulnerability reporting, and dependency alerts where supported. Never place credentials in prompts, issue bodies, logs, or repository files. Review Dependabot changes through the same PR process.

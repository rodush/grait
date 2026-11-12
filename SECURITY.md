# Security policy

## Report a vulnerability

Use this repository's **Security → Report a vulnerability** feature when private vulnerability reporting is enabled. Do not open a public issue containing exploit details, credentials, or private data. If the feature is unavailable, contact the maintainer through the repository owner's published contact channel. Maintainer contact and supported release versions must be configured when adopting this template.

## Automation boundaries

Use separate implementation and review identities. Keep write credentials outside the agent sandbox; `gh-aw` applies writes through scoped safe-output jobs. The credentialed PR reviewer reads the diff through GitHub APIs and does not execute contributor code.

Application CI runs with a read-only token and no repository secrets on pull requests, including forks. Workflow definitions and automation policy require human ownership. Do not give an automation app a branch-rule bypass or a role that can satisfy the required human approval.

Configure secret scanning, push protection, private vulnerability reporting, and dependency alerts where supported. Never place credentials in prompts, issue bodies, logs, or repository files. Review Dependabot changes through the same PR process.

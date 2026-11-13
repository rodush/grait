# Tester-first local development

## Ownership and evidence

A testable issue follows **tester → independent Red verification → implementer → independent Green verification → reviewer**. Every AI role runs in the user's harness. A deterministic local verifier executes committed snapshots; GitHub CI remains a separate required delivery check.

The tester alone creates/edits/deletes/renames configured test files. The implementer alone changes production paths and treats test source, fixtures, and assertion internals as a black box. Both use the SAME issue worktree/branch sequentially at exact committed handoffs. The orchestrator owns an independent checkout and authorizes the next role only after verified evidence. See [worktrees](worktrees.md).

## Configure the application runner

`workflow.config.json` defines `allowedWritePaths`, `protectedPaths`, `tdd.testPatterns`, `tdd.implementationPaths`, and independent `tdd.profiles` for tester/implementer model/reasoning. Glob patterns allow collocated tests and take precedence over production scopes. Renames/deletions are writes to both affected paths; neither role may cross the other's boundary or protected automation policy.

`tdd.runner.install` and `.command` are explicit argument arrays for the application's local test runner. The default is `npm ci --ignore-scripts --no-audit --no-fund`, then `node {nodeAdapter} tests/*.test.mjs`. `{nodeAdapter}` resolves to the trusted Node JSON adapter. Other stacks supply an adapter emitting the same report: `passed` IDs, `failed` entries with stable `id`/`kind`, and `infrastructureErrors`. Use repository-relative identities without temporary paths or line numbers. No container image or hosted model credential is required.

The verifier archives baseline and candidate commits into disposable directories, strips process credentials, assigns a disposable HOME, installs dependencies with scripts disabled, and runs the configured command. This is process hygiene, not an OS sandbox: arbitrary test code still runs as the user. Use an isolated user/container/host for untrusted execution. Private dependencies may need a deliberate read-only dependency credential mechanism; do not expose publishing/model credentials to tests.

## Red and Green handoff

Prepare the issue worktree using the orchestrator. The initial accepted head is the known baseline. The tester commits acceptance tests and writes the expected failing IDs to a JSON file outside the worktree, for example `/tmp/expected-tests.json`:

```json
["tests/acceptance.test.mjs::accepted behavior"]
```

From the assigned worktree, independently run:

```sh
npm run orchestrator -- verify --issue 123 --phase red --expected /tmp/expected-tests.json
```

Red requires a passing/valid-empty baseline and exactly the named new assertion failures. Syntax/import errors, missing dependencies, unexpected regressions, and infrastructure errors never qualify. The verifier checks the tester-only diff, binds evidence to issue/digest/baseline/head, and transfers ownership to the implementer. It publishes hashes and source-free results in the writer-authenticated issue ledger.

The implementer verifies that accepted SHA and changes production only. It receives acceptance criteria, public interfaces, stable failing IDs, and explicitly public sanitized observations—never test code or raw fixture/stack output. After committing its implementation, the independent verifier runs:

```sh
npm run orchestrator -- verify --issue 123 --phase green
```

Green reruns the accepted Red baseline and the complete candidate suite. It must execute and pass all accepted tests with no infrastructure errors, and the diff must stay in implementer paths. The ledger moves to review ownership only after validation succeeds. Push the exact commit and use `orchestrator ready-pr --pr N` to mark the draft ready; a different head needs fresh evidence.

## Test corrections

An implementer with a contract-based test concern commits its allowed production changes and returns ownership:

```sh
npm run orchestrator -- handoff --issue 123 --reason 'Acceptance criterion, expected behavior, observed behavior, and requested clarification'
```

The tester independently evaluates that reason. It may revise tests but never production. Unresolved disagreement returns to triage or a human. The next Red uses the known Green baseline and checks only the new owner's changes for scope. Never weaken an assertion to bypass a failure. TDD handoffs are bounded to ten cycles; review rounds retain their separate lifetime limit.

After a published review calls for fixes, `orchestrator next --issue N --pr N` starts a new tester-first cycle at the accepted current PR head. Incremental work remains Review; redesign first reacquires In Progress capacity. Every stage checks pause state and current claim. A reasoned triage exemption can skip testing only when the accepted assessment explicitly declares testing inapplicable.

## Public feedback boundary

The Node adapter withholds raw assertion messages, stacks, source snippets, and complex objects. A tester may opt into a bounded `publicObservation` on the original assertion error, containing `operator`, `expected`, and `observed` scalar values for public behavior. Ordinary assertion `actual`/`expected` remain private. Other adapters must apply the same policy. These rules preserve independent reasoning; local prompts and worktrees are not a technical confidentiality boundary between arbitrary processes owned by the same user.

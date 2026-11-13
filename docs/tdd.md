# Tester-first development

## Roles and ownership

A testable Ready issue starts with the **tester**, followed by an independent hosted Red check, the **implementer**, and an independent hosted Green check. Only then does the controller make the draft PR ready for hosted review. The tester writes acceptance tests and never implementation. The implementer writes implementation and never tests, including deletions and renames. A separate reviewer evaluates the resulting PR; the tester is not the PR reviewer.

The coordinator has its own worktree. The tester and implementer for one issue share that issue’s worktree and branch sequentially, with one owner at a time. Hosted runners are ephemeral, so each job instead checks out the exact committed handoff SHA from that same branch. Follow `docs/worktrees.md` for assignment and cleanup.

## Configure classification and role models

`workflow.config.json` defines:

- `tdd.testPatterns`: explicit glob patterns with test precedence, initially `tests/**`, `**/test_*.py`, `**/*.spec.py`, and `**/*.test.*`. Tests may be collocated with implementation.
- `tdd.implementationPaths`: outer implementation scopes, still bounded by `allowedWritePaths`. A matching test file is excluded even when it lies inside an implementation scope.
- `tdd.profiles.tester` and `.implementer`: independent `model` and `reasoning` overrides. `null` inherits defaults. The selected engine remains the repository’s engine; use models supported by that engine. Hosted `TESTER_MODEL` and `IMPLEMENTER_MODEL` variables may override the inherited `AGENT_MODEL` when the profile has no explicit model. Codex uses its reasoning setting; Claude/Copilot use the engine’s effort option. Native definitions receive supported model settings only for the selected repository engine; other harness adapters inherit their parent settings, avoiding cross-provider model names; reasoning is enforced by the hosted profile and must be configured in the local harness when that harness does not expose a role-level reasoning field.

Tester safe-output allowlists intersect patterns with allowed scopes; implementation safe outputs exclude all test patterns. The controller independently validates every handoff diff, including both sides of renames. For safe compilation, a pattern must either start with `**/` or have a literal prefix within an allowed `directory/**` scope. Ambiguous intersections are rejected rather than widening access. Exact allowed files are supported. Protected policy and automation remain outside both roles’ authority.

Run `npm run harness:generate` and `npm run compile -- --approve` after changing role settings or scopes. Commit sources and generated files together. Role model/reasoning settings grant no additional permissions.

## Runner contract and evidence

`tdd.runner` selects an immutable digest-pinned container, an optional install command array, and a test command array. No shell interpolation is used. The supplied reference adapter runs Node’s tests and emits JSON; application projects may configure another language’s image and adapter. A missing command or unpinned image stops testable work; it is not grounds for exemption.

The command must emit exactly one JSON object on stdout:

```json
{
  "passed": ["stable test identity"],
  "failed": [{ "id": "new acceptance identity", "kind": "assertion" }],
  "infrastructureErrors": []
}
```

IDs must be unique, stable across line movement, and must not occur in both arrays. The Node adapter uses repository-relative file/suite/name identities and excludes skipped or TODO tests from passing evidence. Its `{nodeAdapter}` command argument points at the trusted adapter. `{reporter}` is available for custom Node commands. The install step and test adapter run in a disposable container with only source/trusted read-only mounts, writable temporary storage, restricted capabilities, resource/time bounds, and no GitHub/model credentials or Docker socket.

For **Red**, the baseline suite passes (a successful explicitly empty baseline is allowed before the first tests exist); the candidate fails exactly the tester-named new acceptance tests as assertion failures. Syntax/import/install errors, unrelated regressions, and timeouts stop the handoff. For **Green**, the baseline must reproduce accepted Red, and the candidate must execute and pass the complete suite, including every accepted failing test. The independent verifier validates the baseline’s expected state, not an agent’s claim of success.

A separate publisher job stores bounded proof. The controller checks the exact dispatched workflow, actor, attempt, operation, issue digest, baseline/head SHA, run ID, and unique artifact integrity before transferring ownership. A check name, comment, or locally reported success cannot authorize implementation or review. Agent jobs and verifier jobs reject Actions reruns; request a new controller operation after investigating a failure.

## Test revisions and follow-up fixes

An implementer that finds an incorrect or missing test returns ownership to the tester with `tests-needed` and a concrete reason. It never repairs tests itself. The tester receives the implementer’s committed head; the next Red check compares against the last known Green baseline. A cycle permits at most ten TDD iterations (the initial iteration plus nine handbacks). Review findings start a new tester → Red → implementer → Green cycle on the same PR. Follow-up work stays Review, unless the review explicitly requires a rethink and the controller reserves In Progress capacity. Existing ten-review-round and early-stop rules still apply.

Triage must record `tdd: {required: true, reason: null}` for testable work. It may explicitly exempt untestable work with `required: false` and a concrete reason. That exemption binds the current issue digest and does not permit an implementer to edit tests. Changed requirements invalidate the decision. Protected work still needs human handling.

## Local handoffs

Request `claim-local` through the controller. For a testable issue, the claim assigns the tester first and records the exact starting SHA. Create one `agent/issue-N` branch in the pair’s shared issue worktree at that SHA. The claim’s configured human operator owns local handoffs; the same actor must submit them. Push committed changes to that same branch and create a draft issue-linked PR with the `agent:managed` label before the first handoff.

```sh
gh workflow run controller.yml -f task=claim-local -f number=123
# Tester commits/pushes tests and opens the draft PR, then:
gh workflow run controller.yml -f task=handoff-local -f number=123 -f action=tests-ready -f head=TEST_COMMIT_SHA -f 'expected=["tests/acceptance.test.mjs::accepted behavior"]'
# Wait for the controller ledger to assign implementer after hosted Red.
# Implementer commits/pushes production only, then:
gh workflow run controller.yml -f task=handoff-local -f number=123 -f action=implemented -f head=IMPLEMENTATION_COMMIT_SHA
```

For a test correction, the implementer submits `action=tests-needed` and `reason=...` at its current committed head. For local follow-up review fixes, use `action=start-tests` at the current PR head after the previous cycle completed. Scope checks, exclusive ownership, and hosted verification still apply. Do not start the next role until the controller ledger names it as owner. Local agents do not get an exception to Red/Green evidence or human merge authority.

## Recover a partially pushed writer run

Do not rerun or blindly resume a stopped tester/implementer operation after its branch advanced. The controller leaves it paused. An operator first inspects the exact commit and role-scoped diff, waits for the old run to finish/cancel, and may explicitly adopt it with `gh workflow run controller.yml -f task=adopt-tdd -f number=123 -f head=ADVANCED_SHA`. Adoption validates the entire diff and transfers ownership to that operator for local reconciliation; it does not attest Red or Green. Submit the corresponding `handoff-local` command next to run independent verification. Scope violations require manual reconciliation rather than adoption. A stopped run with an unchanged branch may use normal `resume`.

## Black-box implementation and disputes

The implementer treats tests as a black box: it does not inspect test source, fixtures, or assertion internals or hardcode known test identities/inputs. It implements the acceptance criteria and public interface behavior. The runner publishes stable failure IDs and bounded sanitized scalar observations to the issue ledger. The Node adapter publishes expected/observed values only when the tester explicitly opts in through the original assertion error’s `publicObservation` object; ordinary assertion `actual`/`expected` fields remain private. Other language adapters must likewise publish only intentional public contract observations; raw assertion messages, stacks, source snippets, and complex fixture objects are withheld. This is role policy in local/hosted instructions; write scopes remain independently enforced by safe outputs and controller diffs.

Tester and implementer may negotiate a failure visibly on the issue. A test-revision handoff must cite the acceptance criterion and explain expected versus observed public behavior. Only the tester inspects or revises tests and records why the contract warrants that revision. If the contract is unclear or disagreement remains, `needs-triage` pauses automated work for triage/operator resolution. Neither side may bypass evidence, change tests to fit an arbitrary implementation, or reset iteration/review limits.

Implementer diff inspection is restricted to production paths and public interfaces. Full PR diffs, `git show` of tester commits, and repository API reads of test source or fixtures are outside its role. Ask the tester for public behavior clarification instead.

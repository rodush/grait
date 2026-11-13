import { parseArgs } from "node:util";
import { readFile, mkdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { command, withoutCredentials, requireSubscription } from "./lib/setup-process.mjs";
import { LocalOrchestrator } from "./lib/orchestrator.mjs";
import { localContext } from "./lib/local-context.mjs";
import {
  createHandoff,
  assertRoleChanges,
  handoffToImplementer,
  completeImplementation,
  returnToTester,
} from "./lib/tdd.mjs";
import { verifyCommits } from "./lib/verification.mjs";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      issue: { type: "string" },
      pr: { type: "string" },
      file: { type: "string" },
      role: { type: "string" },
      phase: { type: "string" },
      expected: { type: "string" },
      reason: { type: "string" },
      "setup-review": { type: "boolean" },
    },
  });
  const task = positionals[0] || "start";
  if (values.help) {
    console.log(
      "Local GRAIT orchestrator\n\nstart                         Launch the native subscription-backed harness\nready --issue N --file JSON    Accept current triage against native blockers\nclaim --issue N                Reserve one of five Project story slots\nworktree --issue N             Prepare/reuse the claimed issue branch\nworker --issue N --role test|implement|fix  Launch a native session at that worktree\nverify --issue N --phase red|green [--expected FILE]  Verify committed snapshots and hand off\nhandoff --issue N --reason TEXT   Return test ownership for a correction\nnext --issue N --pr N          Start an accepted fix/redesign cycle\nready-pr --pr N                Mark the exact Green head ready for review\nreview --pr N --file JSON      Publish exact-head review using the reviewer App\nsync --pr N                   Update Project status; Done requires a merged PR\nstatus                        Show the Project queue\n\nUse one orchestrator host per Project. See docs/operations.md.",
    );
    return;
  }
  if (
    ![
      "start",
      "ready",
      "claim",
      "worktree",
      "worker",
      "verify",
      "handoff",
      "next",
      "ready-pr",
      "review",
      "sync",
      "status",
    ].includes(task)
  )
    throw new Error("Unknown orchestrator operation; use --help");
  if (task === "start") {
    const context = await localContext();
    try {
      new LocalOrchestrator(context);
    } finally {
      await context.store.release();
    }
    const config = context.config;
    const env = withoutCredentials();
    await requireSubscription(config.engine);
    await command(
      config.engine,
      [
        ...(config.engine === "claude" ? ["--effort", config.orchestrator.reasoning] : []),
        "Apply the grait-orchestrator skill at automation/skills/grait-orchestrator/SKILL.md. Manage this repository's Project queue and delegate specialist sub-agents locally in assigned worktrees. Use the native subscription login. Check pause state before each stage; humans merge and release.",
      ],
      { interactive: true, env },
    );
    return;
  }
  const number = Number(values.issue || values.pr);
  if (
    task !== "status" &&
    (!/^[1-9]\d*$/.test(values.issue || values.pr || "") || !Number.isSafeInteger(number))
  )
    throw new Error("Provide a positive --issue or --pr number");
  if (values["setup-review"] && task !== "review")
    throw new Error(
      "--setup-review only publishes an operator-authorized setup review; it cannot start agent work",
    );
  const context = await localContext({
    reviewer: task === "review",
    setupReview: values["setup-review"],
  });
  let launch;
  try {
    const orchestrator = new LocalOrchestrator(context);
    let result;
    if (task === "status")
      result = context.project.items.map((item) => ({
        repository: item.content?.repository?.nameWithOwner,
        issue: item.content?.number,
        title: item.content?.title,
        status: item.status,
      }));
    else if (task === "ready" || task === "review") {
      if (!values.file) throw new Error("Provide --file with the triage assessment or review JSON");
      result = await orchestrator[task](number, JSON.parse(await readFile(values.file, "utf8")));
    } else if (["verify", "handoff", "next"].includes(task)) {
      await orchestrator.claim(number);
      const { state } = await orchestrator.ledger.load(number);
      const tdd = state.tdd;
      if (!tdd) throw new Error("Prepare the claimed worktree before TDD handoffs");
      const head = (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
      const branch = (await command("git", ["branch", "--show-current"])).stdout.trim();
      if (branch !== tdd.branch || (await command("git", ["status", "--porcelain"])).stdout.trim())
        throw new Error("A handoff requires a clean committed issue branch");
      await command("git", ["merge-base", "--is-ancestor", tdd.head, head]);
      const paths = (
        await command("git", ["diff", "--no-renames", "--name-only", "-z", tdd.head, head])
      ).stdout
        .split("\0")
        .filter(Boolean)
        .map((filename) => ({ filename }));
      if (task === "next") {
        if (!/^[1-9]\d*$/.test(values.pr || ""))
          throw new Error("Provide --pr for the accepted review");
        const pr = await context.api.request(`repos/${context.repo}/pulls/${values.pr}`);
        const { state: reviewState } = await orchestrator.ledger.load(pr.number);
        const decision = (await import("./lib/policy.mjs")).loopDecision(
          reviewState.reviews || [],
          context.config,
        );
        if (
          pr.head.sha !== head ||
          (pr.head.ref && pr.head.ref !== tdd.branch) ||
          (pr.head.repo?.full_name &&
            pr.head.repo.full_name.toLowerCase() !== context.repo.toLowerCase()) ||
          !(pr.body || "").match(
            new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${number}\\b`, "i"),
          ) ||
          !["fix", "rethink"].includes(decision.action) ||
          reviewState.paused ||
          tdd.phase !== "review" ||
          tdd.head !== head
        )
          throw new Error(
            "A new fix cycle needs an accepted current-head review and the previous Green handoff",
          );
        if (decision.action === "rethink") {
          const item = context.project.find(context.repo, number);
          const { availableSlots } = await import("./lib/policy.mjs");
          if (
            item.status !== context.config.statuses.inProgress &&
            !availableSlots(context.project.items, context.config)
          )
            throw new Error("Redesign is waiting for In Progress capacity");
          await context.project.move(item, context.config.statuses.inProgress);
        }
        state.tdd = createHandoff({
          issue: number,
          branch,
          head,
          baseline: head,
          acceptanceDigest: state.triagedDigest,
          cycle: tdd.cycle + 1,
        });
        state.fixPR = pr.number;
      } else {
        assertRoleChanges(paths, tdd.owner, context.config);
        if (task === "handoff") {
          state.tdd = returnToTester({ ...tdd, head }, values.reason);
        } else {
          const phase =
            tdd.owner === "tester" ? "red" : tdd.owner === "implementer" ? "green" : null;
          if (!phase || values.phase !== phase)
            throw new Error("Verification phase must match the current exclusive role owner");
          if (phase === "red" && !values.expected)
            throw new Error(
              "Provide --expected with the JSON array of named assertion-failing acceptance test IDs",
            );
          const expectedFailures =
            phase === "red"
              ? JSON.parse(await readFile(values.expected, "utf8"))
              : tdd.expectedFailures;
          const report = await verifyCommits({
            root: process.cwd(),
            issue: number,
            acceptanceDigest: tdd.acceptanceDigest,
            head,
            baseline: phase === "red" ? tdd.baseline : tdd.redHead,
            phase,
            expectedFailures,
            runner: context.config.tdd.runner,
          });
          state.tdd =
            phase === "red"
              ? handoffToImplementer({ ...tdd, head, expectedFailures }, report, expectedFailures)
              : completeImplementation({ ...tdd, head }, report);
          if (phase === "green" && state.fixPR) {
            const { state: reviewState } = await orchestrator.ledger.load(state.fixPR);
            reviewState.completedFixHeads ||= [];
            if (!reviewState.completedFixHeads.includes(head)) {
              reviewState.fixAttempts = (reviewState.fixAttempts || 0) + 1;
              reviewState.completedFixHeads.push(head);
            }
            await orchestrator.ledger.save(state.fixPR);
            delete state.fixPR;
          }
          result = { ...state.tdd, report };
        }
      }
      await orchestrator.ledger.save(number);
      result ||= state.tdd;
    } else if (task === "ready-pr") {
      const pr = await context.api.request(`repos/${context.repo}/pulls/${number}`);
      const match = (pr.body || "").match(/\bCloses #([1-9]\d*)\b/i);
      if (!match) throw new Error("PR must link its claimed issue with Closes #N");
      await orchestrator.claim(Number(match[1]));
      const { state } = await orchestrator.ledger.load(Number(match[1]));
      if (
        state.triage?.tdd?.required !== false &&
        (state.tdd?.phase !== "review" || state.tdd.head !== pr.head.sha)
      )
        throw new Error("Independent Green evidence for this exact PR head is required");
      if (pr.draft)
        await context.api.graphql(
          "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id } } }",
          { id: pr.node_id },
        );
      result = await orchestrator.sync(number);
    } else if (["worktree", "worker"].includes(task)) {
      const claim = await orchestrator.claim(number);
      const common = resolve(
        (
          await command("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"])
        ).stdout.trim(),
      );
      const path = join(
        dirname(common),
        "..",
        `${context.repo.split("/")[1]}-worktrees`,
        `issue-${number}`,
      );
      const worktrees = (await command("git", ["worktree", "list", "--porcelain"])).stdout;
      const existing = worktrees
        .split("\n\n")
        .find(
          (block) =>
            block.includes(`branch refs/heads/${claim.branch}\n`) ||
            block.endsWith(`branch refs/heads/${claim.branch}`),
        );
      let target = path;
      if (existing) target = existing.split("\n")[0].slice("worktree ".length);
      else {
        const repository = await context.api.request(`repos/${context.repo}`);
        await command(
          "git",
          ["fetch", `https://github.com/${context.repo}.git`, repository.default_branch],
          { env: withoutCredentials() },
        );
        await mkdir(dirname(path), { recursive: true });
        await command("git", ["worktree", "add", "-b", claim.branch, path, "FETCH_HEAD"]);
      }
      result = {
        ...claim,
        worktree: target,
        head: (await command("git", ["rev-parse", "HEAD"], { cwd: target })).stdout.trim(),
      };
      const { state } = await orchestrator.ledger.load(number);
      if (!state.tdd && state.triage?.tdd?.required !== false) {
        state.tdd = createHandoff({
          issue: number,
          branch: claim.branch,
          head: result.head,
          baseline: result.head,
          acceptanceDigest: claim.digest,
        });
        await orchestrator.ledger.save(number);
      }
      if (task === "worker") {
        if (!["test", "implement", "fix"].includes(values.role))
          throw new Error("Choose test, implement, or fix");
        if ((await command("git", ["status", "--porcelain"], { cwd: target })).stdout.trim())
          throw new Error("Commit the previous owner's changes before handing over this worktree");
        const expectedOwner = values.role === "test" ? "tester" : "implementer";
        if (state.tdd && state.tdd.owner !== expectedOwner)
          throw new Error("This role does not own the accepted TDD handoff");
        launch = {
          cwd: target,
          prompt: `Apply the grait-${values.role} skill at automation/skills/grait-${values.role}/SKILL.md for claimed issue #${number}. This is the assigned shared issue worktree. Verify the exact committed handoff and next owner in the issue ledger before writing. Use this branch and worktree for every command. Return committed changes and validation evidence to the orchestrator. Do not create another worktree or edit the other role's files.`,
        };
      }
    } else result = await orchestrator[task](number);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.store.release();
  }
  if (launch) {
    await requireSubscription(context.config.engine);
    const profile = context.config.tdd.profiles[values.role === "test" ? "tester" : "implementer"];
    const args = [
      ...(context.config.engine === "claude"
        ? [
            "--agent",
            `grait-${values.role}`,
            "--effort",
            profile.reasoning || context.config.orchestrator.reasoning,
          ]
        : profile.reasoning
          ? ["-c", `model_reasoning_effort=${JSON.stringify(profile.reasoning)}`]
          : []),
      ...(profile.model ? ["--model", profile.model] : []),
      launch.prompt,
    ];
    await command(context.config.engine, args, {
      cwd: launch.cwd,
      interactive: true,
      env: withoutCredentials(),
    });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

import { isEntrypoint } from "./lib/entrypoint.mjs";
import { bundledRuntime } from "./lib/runtime-resources.mjs";
import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { localContext } from "./lib/local-context.mjs";
import { LocalOrchestrator } from "./lib/orchestrator.mjs";
import { command, withoutCredentials } from "./lib/setup-process.mjs";
import { conventionalTitle } from "./lib/policy.mjs";
import { assertRoleChanges } from "./lib/tdd.mjs";

function requireGreen(state, head, operation) {
  if (state.tdd?.phase !== "review" || state.tdd.head !== head)
    throw new Error(`Independent Green evidence for this exact ${operation} head is required`);
}

export async function githubMain() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      draft: { type: "boolean" },
      issue: { type: "string" },
      pr: { type: "string" },
      title: { type: "string" },
      "body-file": { type: "string" },
    },
  });
  const task = positionals[0];
  if (values.help) {
    console.log(
      "Publish claimed issue branches and PRs:\n  grait github push --issue N\n  grait github pr --issue N --title 'feat: ...' --body-file PATH [--draft]\n  grait github checks --pr N\nThe writer App publishes PRs and ordinary pushes. GRAIT source workflow pushes require independent Green and a workflow-capable GH_TOKEN.\nPRs are normal by default and require independent Green for the exact head or an accepted triage TDD exemption. Use --draft only when the user explicitly requests work in progress or early feedback.\nReview waits for required CI on the exact PR head. Reviews use grait orchestrator review. Merge and release are human-only.",
    );
    return;
  }
  const target = task === "checks" ? values.pr : values.issue;
  if (
    !["push", "pr", "checks"].includes(task) ||
    !/^[1-9]\d*$/.test(target || "") ||
    !Number.isSafeInteger(Number(target))
  )
    throw new Error("Choose push or pr with --issue N, or checks with --pr N; use --help");
  const context = await localContext();
  try {
    const orchestrator = new LocalOrchestrator(context);
    if (task === "checks") {
      console.log(JSON.stringify(await orchestrator.checks(Number(target)), null, 2));
      return;
    }
    const claim = await orchestrator.claim(Number(target));
    const branch = (await command("git", ["branch", "--show-current"])).stdout.trim();
    if (branch !== claim.branch || (await command("git", ["status", "--porcelain"])).stdout.trim())
      throw new Error("Publish only committed changes from the claimed issue branch");
    const repository = await context.api.request(`repos/${context.repo}`);
    const head = (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
    if (task === "push") {
      const base = (
        await command("git", ["merge-base", head, `origin/${repository.default_branch}`])
      ).stdout.trim();
      const paths = (
        await command("git", ["diff", "--no-renames", "--name-only", "-z", base, head])
      ).stdout
        .split("\0")
        .filter(Boolean);
      if (!paths.length) throw new Error("No committed changes to publish");
      // Combined tester+implementer history is allowed; every file must still stay in
      // the repository write scope. Per-stage diffs are checked at handoff.
      for (const filename of paths) {
        try {
          assertRoleChanges([{ filename }], "tester", context.config);
        } catch {
          assertRoleChanges([{ filename }], "implementer", context.config);
        }
      }
      const sourceWorkflowPush =
        context.development && paths.some((path) => path.startsWith(".github/workflows/"));
      let token = context.api.token;
      if (sourceWorkflowPush) {
        const { state } = await orchestrator.ledger.load(claim.issue);
        requireGreen(state, head, "workflow push");
        token = process.env.GH_TOKEN;
        if (!token)
          throw new Error("Set GH_TOKEN with workflow write access to push GRAIT source workflows");
      }
      await command(
        "git",
        [
          "-c",
          "credential.helper=",
          "-c",
          "credential.helper=!gh auth git-credential",
          "push",
          `https://github.com/${context.repo}.git`,
          `${head}:refs/heads/${branch}`,
        ],
        {
          interactive: true,
          env: { ...withoutCredentials(), GH_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
        },
      );
      console.log(`Pushed ${branch} using ${sourceWorkflowPush ? "GH_TOKEN" : "the writer App"}.`);
    } else {
      if (!conventionalTitle(values.title) || !values["body-file"])
        throw new Error(
          "Provide a Conventional Commit --title and --body-file with validation evidence",
        );
      const body = await readFile(values["body-file"], "utf8");
      const remote = await context.api.request(`repos/${context.repo}/git/ref/heads/${branch}`);
      if (remote.object?.sha !== head)
        throw new Error("Push this exact commit before opening its PR");
      if (!values.draft) {
        const { state } = await orchestrator.ledger.load(Number(values.issue));
        if (state.triage?.tdd?.required !== false) requireGreen(state, head, "PR");
      }
      const pr = await context.api.request(`repos/${context.repo}/pulls`, {
        method: "POST",
        body: {
          title: values.title,
          body: `${body}\n\nCloses #${values.issue}`,
          head: branch,
          base: repository.default_branch,
          draft: Boolean(values.draft),
        },
      });
      console.log(pr.html_url);
    }
  } finally {
    await context.store.release();
  }
}
if (!bundledRuntime && isEntrypoint(import.meta.url))
  githubMain().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

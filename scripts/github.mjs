import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { localContext } from "./lib/local-context.mjs";
import { LocalOrchestrator } from "./lib/orchestrator.mjs";
import { command, withoutCredentials } from "./lib/setup-process.mjs";
import { conventionalTitle } from "./lib/policy.mjs";
import { assertRoleChanges } from "./lib/tdd.mjs";

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      issue: { type: "string" },
      title: { type: "string" },
      "body-file": { type: "string" },
    },
  });
  const task = positionals[0];
  if (values.help) {
    console.log(
      "Publish through the local writer App:\n  npm run github -- push --issue N\n  npm run github -- pr --issue N --title 'feat: ...' --body-file PATH\nReviews use npm run orchestrator -- review. Merge and release are human-only.",
    );
    return;
  }
  if (!["push", "pr"].includes(task) || !/^[1-9]\d*$/.test(values.issue || ""))
    throw new Error("Choose push or pr and provide --issue N; use --help");
  const context = await localContext();
  try {
    const orchestrator = new LocalOrchestrator(context);
    const claim = await orchestrator.claim(Number(values.issue));
    const branch = (await command("git", ["branch", "--show-current"])).stdout.trim();
    if (branch !== claim.branch || (await command("git", ["status", "--porcelain"])).stdout.trim())
      throw new Error("Publish only committed changes from the claimed issue branch");
    const repository = await context.api.request(`repos/${context.repo}`);
    if (task === "push") {
      const base = (
        await command("git", ["merge-base", "HEAD", `origin/${repository.default_branch}`])
      ).stdout.trim();
      const paths = (
        await command("git", ["diff", "--no-renames", "--name-only", "-z", base, "HEAD"])
      ).stdout
        .split("\0")
        .filter(Boolean);
      if (!paths.length) throw new Error("No committed changes to publish");
      // Combined tester+implementer history is allowed; every file must still stay in
      // the application allowlist. Per-stage diffs are checked at handoff.
      for (const filename of paths) {
        try {
          assertRoleChanges([{ filename }], "tester", context.config);
        } catch {
          assertRoleChanges([{ filename }], "implementer", context.config);
        }
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
          `HEAD:refs/heads/${branch}`,
        ],
        {
          interactive: true,
          env: { ...withoutCredentials(), GH_TOKEN: context.api.token, GIT_TERMINAL_PROMPT: "0" },
        },
      );
      console.log(`Pushed ${branch} as the writer App.`);
    } else {
      if (!conventionalTitle(values.title) || !values["body-file"])
        throw new Error(
          "Provide a Conventional Commit --title and --body-file with validation evidence",
        );
      const body = await readFile(values["body-file"], "utf8");
      const head = (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
      const remote = await context.api.request(`repos/${context.repo}/git/ref/heads/${branch}`);
      if (remote.object?.sha !== head)
        throw new Error("Push this exact commit before opening its PR");
      const pr = await context.api.request(`repos/${context.repo}/pulls`, {
        method: "POST",
        body: {
          title: values.title,
          body: `${body}\n\nCloses #${values.issue}`,
          head: branch,
          base: repository.default_branch,
          draft: true,
        },
      });
      console.log(pr.html_url);
    }
  } finally {
    await context.store.release();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(await readFile(join(root, "workflow.config.json"), "utf8"));
const temporary = await mkdtemp(join(tmpdir(), "agentic-profiles-"));
try {
  await execute("git", ["init", "--quiet"], { cwd: temporary });
  for (const path of [
    ".github",
    "AGENTS.md",
    "docs",
    "automation",
    "config",
    "scripts",
    "package.json",
    "workflow.config.json",
  ])
    await cp(join(root, path), join(temporary, path), { recursive: true });
  await symlink(join(root, "node_modules"), join(temporary, "node_modules"), "dir");
  for (const engine of config.supportedEngines) {
    for (const authentication of ["app", "token"]) {
      await writeFile(
        join(temporary, "workflow.config.json"),
        JSON.stringify({ ...config, engine, authentication }),
      );
      try {
        await execute(process.execPath, [join(temporary, "scripts/compile.mjs"), "--approve"], {
          cwd: temporary,
          maxBuffer: 8 * 1024 * 1024,
        });
      } catch (error) {
        throw new Error(
          `${engine}/${authentication} compilation failed:\n${error.stdout || ""}\n${error.stderr || error.message}`,
        );
      }
      for (const role of ["triage", "implement", "review", "fix"]) {
        const workflow = parse(
          await readFile(join(temporary, `.github/workflows/${role}.lock.yml`), "utf8"),
        );
        if (
          !workflow.jobs.agent.needs.includes("authorize") ||
          !workflow.jobs.safe_outputs.needs.includes("authorize")
        )
          throw new Error(`${engine}/${authentication}/${role}: missing authorization dependency`);
        for (const job of ["agent", "detection", "safe_outputs", "conclusion"])
          if (!workflow.jobs[job].if?.includes("github.run_attempt == 1"))
            throw new Error(
              `${engine}/${authentication}/${role}: ${job} permits unbudgeted reruns`,
            );
        if (workflow.env?.NPM_CONFIG_MIN_RELEASE_AGE !== "3")
          throw new Error(`${engine}/${authentication}/${role}: missing npm maturity policy`);
        for (const job of Object.values(workflow.jobs))
          for (const step of job.steps || [])
            if (
              /npm (?:install|exec)/.test(step.run || "") &&
              step.env?.NPM_CONFIG_MIN_RELEASE_AGE !== undefined &&
              Number(step.env.NPM_CONFIG_MIN_RELEASE_AGE) < 3
            )
              throw new Error(
                `${engine}/${authentication}/${role}: npm installer bypasses maturity policy`,
              );
        if (!workflow.concurrency.group.includes("inputs.number"))
          throw new Error(
            `${engine}/${authentication}/${role}: concurrency would serialize unrelated stories`,
          );
      }
      console.log(`Compiled and checked ${engine}/${authentication}: 4 workflows`);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, mkdtemp, cp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stringify } from "yaml";
import { parse as parseToml } from "smol-toml";
import { validateConfig } from "./lib/policy.mjs";
import { readSkill } from "./lib/harnesses.mjs";

const root = resolve(import.meta.dirname, "..");
const execute = promisify(execFile);
const config = validateConfig(
  JSON.parse(await readFile(join(root, "workflow.config.json"), "utf8")),
);
const codex = parseToml(await readFile(join(root, "config/codex.toml"), "utf8"));
const versionResult = await execute("gh", ["aw", "version"], { encoding: "utf8" });
const version = `${versionResult.stdout}${versionResult.stderr}`.trim();
if (version !== `gh aw version v${config.ghAwVersion}`)
  throw new Error(`Install gh-aw v${config.ghAwVersion}; found ${version}`);
if (!["app", "token"].includes(config.authentication))
  throw new Error("Select app or token authentication in workflow.config.json");

function auth(prefix) {
  return config.authentication === "app"
    ? {
        "github-app": {
          "client-id": `\${{ vars.${prefix}_APP_CLIENT_ID }}`,
          "private-key": `\${{ secrets.${prefix}_APP_PRIVATE_KEY }}`,
        },
      }
    : { "github-token": `\${{ secrets.${prefix}_TOKEN }}` };
}

export function generatedComponents() {
  return {
    "runtime.md": {
      "inlined-imports": true,
      engine:
        config.engine === "codex"
          ? {
              id: "codex",
              args: [
                "--config",
                `model_reasoning_effort=${JSON.stringify(codex.model_reasoning_effort)}`,
              ],
            }
          : config.engine,
      model:
        config.engine === "codex"
          ? `\${{ vars.AGENT_MODEL || '${codex.model}' }}`
          : "${{ vars.AGENT_MODEL }}",
      "max-turns": 60,
      "max-ai-credits": 1000,
      permissions: { contents: "read", issues: "read", "pull-requests": "read", actions: "read" },
      network: { allowed: ["defaults", "github", "node"] },
      "safe-outputs": {
        "threat-detection": { "continue-on-error": false },
        "max-patch-files": 50,
        "max-patch-size": 2048,
        "report-failure-as-issue": false,
      },
    },
    "writer-auth.md": { "safe-outputs": auth("AUTOMATION") },
    "reviewer-auth.md": { "safe-outputs": auth("REVIEW") },
    "implementation-output.md": {
      "safe-outputs": {
        "create-pull-request": {
          max: 1,
          draft: false,
          "branch-prefix": "agent/",
          "preserve-branch-name": true,
          labels: [config.labels.automated],
          "allowed-files": config.allowedWritePaths,
          "protected-files": "blocked",
          "fallback-as-issue": false,
          "auto-merge": false,
          "github-token-for-extra-empty-commit":
            config.authentication === "app" ? "app" : "${{ secrets.AUTOMATION_TOKEN }}",
        },
      },
    },
    "fix-output.md": {
      "safe-outputs": {
        "push-to-pull-request-branch": {
          max: 1,
          target: "${{ inputs.number }}",
          "required-labels": [config.labels.automated],
          "allowed-files": config.allowedWritePaths,
          "protected-files": "blocked",
          "fallback-as-pull-request": false,
          "check-branch-protection": false,
          "github-token-for-extra-empty-commit":
            config.authentication === "app" ? "app" : "${{ secrets.AUTOMATION_TOKEN }}",
        },
      },
    },
  };
}

const sharedDocuments = {
  "policy-agents.md": "AGENTS.md",
  "policy-coding.md": "docs/coding-guidelines.md",
  "policy-workflow.md": "docs/workflow.md",
  "policy-review.md": "docs/review-guidelines.md",
  ...Object.fromEntries(
    ["triage", "implement", "review", "fix"].map((role) => [
      `skill-grait-${role}.md`,
      `automation/skills/grait-${role}/SKILL.md`,
    ]),
  ),
  ...Object.fromEntries(
    ["triage", "implement", "review", "fix"].map((role) => [
      `prompt-${role}.md`,
      `automation/prompts/${role}.md`,
    ]),
  ),
};

async function compile(directory) {
  const shared = join(directory, ".github/workflows/shared");
  await mkdir(shared, { recursive: true });
  for (const [name, content] of Object.entries(generatedComponents())) {
    await writeFile(
      join(shared, name),
      `---\n${stringify(content)}---\n\nGenerated from workflow.config.json by scripts/compile.mjs.\n`,
    );
  }
  for (const [name, source] of Object.entries(sharedDocuments)) {
    const original = await readFile(join(directory, source), "utf8");
    const content = source.endsWith("/SKILL.md")
      ? readSkill(original, source.split("/").at(-2)).body
      : original;
    await writeFile(
      join(shared, name),
      `<!-- Generated from ${source}; edit the source and run npm run compile. -->\n\n${content}`,
    );
  }
  try {
    const args = [
      "aw",
      "compile",
      "--no-check-update",
      "--action-mode",
      "action",
      "--action-tag",
      config.ghAwActionsSha,
      "--schedule-seed",
      "template/repository",
    ];
    if (process.argv.includes("--approve")) args.push("--approve");
    const result = await execute("gh", args, { cwd: directory, maxBuffer: 8 * 1024 * 1024 });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  } catch (error) {
    process.stdout.write(error.stdout || "");
    process.stderr.write(error.stderr || "");
    throw new Error("gh-aw compilation failed");
  }
}

if (process.argv.includes("--check")) {
  const temporary = await mkdtemp(join(tmpdir(), "agentic-compile-"));
  try {
    await execute("git", ["init", "--quiet"], { cwd: temporary });
    for (const path of [
      ".github",
      "AGENTS.md",
      "docs",
      "automation",
      "config",
      "workflow.config.json",
    ])
      await cp(join(root, path), join(temporary, path), { recursive: true });
    await compile(temporary);
    const paths = [
      ...(await readdir(join(temporary, ".github/workflows")))
        .filter((name) => name.endsWith(".lock.yml"))
        .map((name) => `.github/workflows/${name}`),
      ...Object.keys(generatedComponents()).map((name) => `.github/workflows/shared/${name}`),
      ...Object.keys(sharedDocuments).map((name) => `.github/workflows/shared/${name}`),
    ];
    for (const path of paths) {
      const expected = await readFile(join(temporary, path), "utf8");
      const actual = await readFile(join(root, path), "utf8").catch(() => "");
      if (expected !== actual)
        throw new Error(`Generated file is stale: ${path}; run npm run compile`);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
} else await compile(root);

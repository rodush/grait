import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { parse } from "yaml";
import { parse as parseToml } from "smol-toml";
import { conventionalTitle, validateConfig } from "./lib/policy.mjs";

const failures = [];
const assert = (condition, message) => {
  if (!condition) failures.push(message);
};
const config = validateConfig(JSON.parse(await readFile("workflow.config.json", "utf8")));
const npmrc = await readFile(".npmrc", "utf8");
assert(/^min-release-age=3$/m.test(npmrc), "npm packages must mature for at least three days");
assert(/^engine-strict=true$/m.test(npmrc), "npm must enforce engine support for the age gate");
assert(/^ignore-scripts=true$/m.test(npmrc), "Dependency install scripts must stay disabled");
const codexText = await readFile("config/codex.toml", "utf8");
const codex = parseToml(codexText);
const installedCodex = await readFile(".codex/config.toml", "utf8").catch((error) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
if (installedCodex !== null)
  assert(installedCodex === codexText, "Installed .codex/config.toml must match config/codex.toml");
assert(typeof codex.model === "string" && !!codex.model, "Codex needs an explicit model");
assert(
  codex.model_reasoning_effort === "high",
  "Codex reasoning must match the selected high default",
);
assert(
  codex.approval_policy === "on-request" && codex.sandbox_mode === "workspace-write",
  "Local Codex must preserve the selected approval and sandbox defaults",
);

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", ".aws", ".agents", ".codex", ".cache"].includes(entry.name))
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

function inspectActions(value, path) {
  if (!value || typeof value !== "object") return;
  if (typeof value.uses === "string")
    assert(
      value.uses.startsWith("./") || /@[0-9a-f]{40}$/.test(value.uses),
      `Action must be SHA pinned: ${path}: ${value.uses}`,
    );
  for (const child of Object.values(value)) inspectActions(child, path);
}

for (const path of await files(".")) {
  const text = await readFile(path, "utf8");
  try {
    if (path.endsWith(".json")) JSON.parse(text);
    if (/\.ya?ml$/.test(path)) inspectActions(parse(text), path);
    if (path.endsWith(".md")) {
      if (text.startsWith("---\n")) parse(text.split("\n---")[0].slice(4));
      for (const match of text.matchAll(/\[[^\]]+\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
        const link = match[1].replace(/^<|>$/g, "");
        if (/^[a-z]+:|^#|^\$\{|^\//i.test(link)) continue;
        const target = decodeURIComponent(link.split("#")[0]);
        if (target)
          assert(
            await stat(resolve(dirname(path), target))
              .then(() => true)
              .catch(() => false),
            `Broken local link: ${path} -> ${link}`,
          );
      }
    }
  } catch (error) {
    failures.push(`${path}: ${error.message}`);
  }
}

for (const role of ["triage", "test", "develop", "implement", "review", "fix"]) {
  const text = await readFile(`.github/workflows/${role}.md`, "utf8");
  const workflow = parse(text.split("\n---")[0].slice(4));
  assert(workflow.strict === true, `${role}: strict mode is required`);
  assert(
    workflow.on.workflow_dispatch && Object.keys(workflow.on).length === 1,
    `${role}: only controller dispatch is allowed`,
  );
  assert(
    workflow.imports.includes("shared/authorize.md"),
    `${role}: controller authorization is required`,
  );
  assert(
    !Object.values(workflow.permissions).includes("write"),
    `${role}: agent token must remain read-only`,
  );
  if (["review", "triage"].includes(role))
    assert(
      workflow.checkout === false && workflow.tools.bash === false,
      `${role}: no code checkout or shell execution`,
    );
  assert(
    !JSON.stringify(workflow["safe-outputs"] || {}).includes("merge-pull-request"),
    `${role}: agents cannot merge`,
  );
}
const eventPath = process.env.GITHUB_EVENT_PATH;
if (eventPath && process.env.GITHUB_EVENT_NAME === "pull_request") {
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  assert(conventionalTitle(event.pull_request.title), "PR title must use Conventional Commits");
}
if (config.controllerRepository)
  assert(config.humanOperators.length > 0, "Configured repositories require human operators");
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log("Configuration, workflow boundaries, action pins, and documentation links passed.");

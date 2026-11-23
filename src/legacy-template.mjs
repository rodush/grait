import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { join, posix } from "node:path";
import { command, withoutCredentials } from "../scripts/lib/setup-process.mjs";
import { privateStagingDirectory } from "./installer-services.mjs";

const templateRemote = "https://github.com/rodush/grait.git";
const role = "(?:fix|implement|orchestrator|review|test|triage)";
const rolePath = new RegExp(
  `^(?:(?:automation|\\.agents|\\.claude|\\.github)/skills/grait-${role}/SKILL\\.md|\\.claude/agents/grait-${role}\\.md|\\.codex/agents/grait-${role}\\.toml|\\.github/agents/grait-${role}\\.agent\\.md)$`,
);
const legacyScripts = new Set([
  "activate",
  "bootstrap",
  "bundle",
  "check",
  "github",
  "harnesses",
  "orchestrator",
  "setup",
  "adapters/node-suite",
  "adapters/node-test-reporter",
  "adapters/test-observation",
  "lib/bootstrap",
  "lib/entrypoint",
  "lib/harness-runtime",
  "lib/harnesses",
  "lib/ledger",
  "lib/local-auth",
  "lib/local-context",
  "lib/orchestrator",
  "lib/policy",
  "lib/project",
  "lib/role-profiles",
  "lib/ruleset-setup",
  "lib/runtime-resources",
  "lib/setup-apps",
  "lib/setup-process",
  "lib/setup-state",
  "lib/tdd",
  "lib/verification",
]);
export const legacyValidationWorkflow = ".github/workflows/ci.yml";
const legacyFiles = new Set([
  legacyValidationWorkflow,
  "automation/agents.json",
  "automation/policy/shared.md",
  "config/codex.toml",
  "dist/artifact-stage.mjs",
  "dist/cli.mjs",
  "dist/project-policy.mjs",
  ...[...legacyScripts].map((name) => `scripts/${name}.mjs`),
]);

export function isLegacyScaffold(path) {
  return legacyFiles.has(path) || rolePath.test(path);
}

export function validateLegacyRevision(revision) {
  if (!/^[a-f0-9]{40}$/i.test(revision ?? ""))
    throw new Error("Provide a full GRAIT template commit SHA with --legacy-revision");
  return revision.toLowerCase();
}

function gitEnvironment() {
  const env = withoutCredentials();
  for (const name of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_QUARANTINE_PATH",
    "GIT_WORK_TREE",
  ])
    delete env[name];
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" };
}

function parseEntries(output, pattern) {
  const entries = new Map();
  for (const entry of output.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("\t");
    const object = entry.slice(0, separator).match(pattern);
    if (object) entries.set(entry.slice(separator + 1), { mode: object[1], oid: object[2] });
  }
  return entries;
}

/** Resolve the explicitly selected template pin without fetching into the target. */
export async function loadLegacyTemplate(root, revision) {
  const cwd = await privateStagingDirectory(root, "grait-template-");
  const env = gitEnvironment();
  const git = (args) => command("git", args, { cwd, env });
  try {
    await git(["init", "--bare", "--object-format=sha1", "--template="]);
    await git([
      "-c",
      "credential.helper=",
      "-c",
      "http.extraHeader=",
      "fetch",
      "--depth=1",
      "--no-tags",
      templateRemote,
      revision,
    ]).catch(() => {
      throw new Error("Could not fetch --legacy-revision from the canonical GRAIT Git repository");
    });
    const { stdout: fetched } = await git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
    if (fetched.trim() !== revision)
      throw new Error("The fetched GRAIT template commit does not match --legacy-revision");
    const { stdout } = await git(["ls-tree", "-r", "-z", "--full-tree", revision]);
    const files = parseEntries(stdout, /^(100(?:644|755)) blob ([a-f0-9]{40})$/);
    const manifest = files.get("package.json");
    const manifestContents =
      manifest && files.has(legacyValidationWorkflow)
        ? (await git(["cat-file", "blob", manifest.oid])).stdout
        : null;
    return { files, manifestContents };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function indexedFiles(root) {
  const { stdout } = await command("git", ["ls-files", "--stage", "-z"], {
    cwd: root,
    env: gitEnvironment(),
  });
  return parseEntries(stdout, /^(100(?:644|755)) ([a-f0-9]{40}) 0$/);
}

async function grepReferences(root, patterns, pathspecs) {
  const result = await command(
    "git",
    ["grep", "--untracked", "-I", "-l", "-z", "-F", "-f", "-", "--", ...pathspecs],
    { cwd: root, env: gitEnvironment(), input: [...patterns].join("\n"), allowFailure: true },
  );
  if (result.code !== 0 && result.code !== 1)
    throw new Error("Could not check retained project files for legacy dependencies");
  return result.stdout.split("\0").filter(Boolean);
}

/** Find retained repository files with literal references to legacy scaffolding. */
export async function retainedLegacyReferences(root, candidates, superseded) {
  if (!candidates.length) return [];
  const exclusions = superseded.map((path) => `:(top,exclude,literal)${path}`);
  const basenames = new Set(candidates.map((path) => posix.basename(path)));
  const paths = new Set([...candidates, ...[...basenames].map((name) => `/${name}`)]);
  // Retained workflows may use a filename relative to a step or job working directory.
  const [references, workflowReferences] = await Promise.all([
    grepReferences(root, paths, [
      ":(exclude,glob)**/*.md",
      ":(exclude,glob)**/node_modules/**",
      ...exclusions,
    ]),
    grepReferences(root, basenames, [
      ":(top,glob).github/workflows/*.yml",
      ":(top,glob).github/workflows/*.yaml",
      ...exclusions,
    ]),
  ]);
  return [...new Set([...references, ...workflowReferences])].sort();
}

export async function verifiedTemplateFile(root, path, template, indexed) {
  if (!template || indexed?.oid !== template.oid || indexed.mode !== template.mode) return null;
  const destination = join(root, path);
  try {
    const info = await lstat(destination);
    const mode = info.mode & 0o777;
    const gitMode = mode & 0o100 ? "100755" : "100644";
    if (
      !info.isFile() ||
      gitMode !== template.mode ||
      (await realpath(destination)) !== destination
    )
      return null;
    const bytes = await readFile(destination);
    const oid = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    const content = bytes.toString("utf8");
    if (oid !== template.oid || !Buffer.from(content).equals(bytes)) return null;
    return { content, mode };
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) return null;
    throw error;
  }
}

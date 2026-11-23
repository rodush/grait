import { digest, sameLogin, validateConfig } from "../scripts/lib/policy.mjs";
import { readArtifact } from "./artifact-stage.mjs";
import { managedRoleFrontmatter } from "./role-frontmatter.mjs";

export const installationPath = ".grait/installation.json";
export const installerWorkflow = "grait.yml";
export const installers = ["codex", "claude", "copilot"];
export const projectOwnedPaths = new Set(["workflow.config.json", ".github/CODEOWNERS"]);

const revisionPattern = /^[a-f0-9]{40}$/;
const versionPattern = /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;
const repoPattern = /^[\w.-]+\/[\w.-]+$/;
const hashPattern = /^[a-f0-9]{64}$/;
const mandatoryArtifacts = [
  "AGENTS.md",
  "workflow.config.json",
  ".github/CODEOWNERS",
  `.github/workflows/${installerWorkflow}`,
];

export function validateRevision(revision) {
  if (typeof revision !== "string" || !revisionPattern.test(revision))
    throw new Error(
      "An immutable full 40-character Git revision is required (--revision COMMIT_SHA)",
    );
  return revision;
}

export function validateTarget({ repository, harness, version }) {
  if (typeof repository !== "string" || !repoPattern.test(repository))
    throw new Error("Provide --repo OWNER/REPOSITORY");
  if (!installers.includes(harness)) throw new Error("Choose codex, claude, or copilot");
  if (typeof version !== "string" || !versionPattern.test(version))
    throw new Error("Invalid installed GRAIT package version");
}

function managedText(content) {
  const markdown = content.match(
    /<!-- grait:policy:start version=[^\r\n<>]+ -->\r?\n[\s\S]*?<!-- grait:policy:end -->/,
  );
  const comments = content.match(
    /^# grait:policy:start version=[^\r\n]+\r?\n[\s\S]*?^# grait:policy:end$/m,
  );
  return markdown?.[0] || comments?.[0] || content;
}

export function artifactOwnership(path, content) {
  const profile = /^\.(?:claude|github)\/agents\/.+\.md$/.test(path)
    ? managedRoleFrontmatter(content)
    : undefined;
  const managed = projectOwnedPaths.has(path) ? content : managedText(content);
  return {
    hash: digest(content),
    managedHash: digest(profile ? JSON.stringify([managed, profile]) : managed),
  };
}

export async function readInstallation(root) {
  const content = await readArtifact(root, installationPath);
  if (content === null) return null;
  const record = JSON.parse(content);
  if (
    record?.schemaVersion !== 1 ||
    !record.artifacts ||
    typeof record.artifacts !== "object" ||
    Array.isArray(record.artifacts) ||
    !mandatoryArtifacts.every((path) => Object.hasOwn(record.artifacts, path))
  )
    throw new Error("Malformed GRAIT installation record; reconcile it before continuing");
  validateTarget(record);
  validateRevision(record.revision);
  for (const [path, ownership] of Object.entries(record.artifacts)) {
    if (
      !path ||
      path === installationPath ||
      path.startsWith("/") ||
      /^[a-z]:/i.test(path) ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => ["", ".", "..", ".git"].includes(part.toLowerCase())) ||
      !hashPattern.test(ownership?.hash || "") ||
      !hashPattern.test(ownership?.managedHash || "")
    )
      throw new Error("Invalid installed artifact ownership record");
  }
  return { record, content };
}

export function verifyOwnership(record, artifacts) {
  for (const [path, expected] of Object.entries(record.artifacts)) {
    const content = artifacts[path];
    if (content === null || content === undefined)
      throw new Error(`Installed artifact is missing: ${path}`);
    if (
      !projectOwnedPaths.has(path) &&
      artifactOwnership(path, content).managedHash !== expected.managedHash
    )
      throw new Error(
        `Installed managed content has drifted: ${path}. Resolve the conflict before installation or activation.`,
      );
  }
}

export async function validateInstallation(root) {
  const installation = await readInstallation(root);
  if (!installation) throw new Error("Install GRAIT before validating or activating it");
  const { record, content } = installation;
  const artifacts = Object.fromEntries(
    await Promise.all(
      Object.keys(record.artifacts).map(async (path) => [path, await readArtifact(root, path)]),
    ),
  );
  verifyOwnership(record, artifacts);
  const config = validateConfig(JSON.parse(artifacts["workflow.config.json"]));
  if (
    !sameLogin(config.controllerRepository, record.repository) ||
    config.engine !== record.harness
  )
    throw new Error("Installation metadata and workflow configuration disagree");
  return { record, config, artifacts: { ...artifacts, [installationPath]: content } };
}

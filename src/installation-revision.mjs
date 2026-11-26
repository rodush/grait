import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { parseArgs } from "node:util";
import { command, withoutCredentials } from "../scripts/lib/setup-process.mjs";
import { bundledRuntime, runtimeFile } from "../scripts/lib/runtime-resources.mjs";

export const canonicalPackage = "git+https://github.com/rodush/grait.git";
export const globalInstallCommand =
  "npm exec --yes --allow-git=all --ignore-scripts --package='" +
  canonicalPackage +
  "#main' -- grait install-global";
const gitSource =
  /^git\+(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com[:/])rodush\/grait(?:\.git)?#([a-f0-9]{40})$/i;
const fullSha = /^[a-f0-9]{40}$/i;
const pinPattern = /^(?:[a-f0-9]{12}|[a-f0-9]{40})$/i;
const tagPattern = /^v\d+\.\d+\.\d+$/;
const receiptName = "grait-provenance.json";

function cliDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function resolvedFromLock(lockPath, lockRoot, packageRoot) {
  let text;
  try {
    text = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
  const key = relative(lockRoot, packageRoot).split(sep).join("/");
  const { packages } = JSON.parse(text);
  return packages && Object.hasOwn(packages, key) ? (packages[key]?.resolved ?? null) : undefined;
}

async function readReceipt(packageRoot, cliPath) {
  const path = join(packageRoot, receiptName);
  const info = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return undefined;
  if (!info.isFile() || info.mode & 0o022 || info.size > 1024)
    throw new Error("Unsafe GRAIT global installation provenance");
  const { source, sha256 } = JSON.parse(await readFile(path, "utf8"));
  const match = typeof source === "string" && source.match(gitSource);
  if (!match || typeof sha256 !== "string" || sha256 !== cliDigest(await readFile(cliPath)))
    throw new Error("GRAIT global installation provenance does not match the running executable");
  return match[1].toLowerCase();
}

export async function installedProvenance({
  cliPath = bundledRuntime ? runtimeFile : undefined,
  searchParents = true,
} = {}) {
  if (!cliPath) return undefined;
  const packageRoot = dirname(dirname(cliPath));
  const modules = dirname(packageRoot);
  if (basename(packageRoot) !== "grait" || basename(modules) !== "node_modules") return undefined;
  const receipt = await readReceipt(packageRoot, cliPath);
  if (receipt) return { revision: receipt, kind: "global" };
  const root = dirname(modules);
  let resolved = await resolvedFromLock(join(modules, ".package-lock.json"), root, packageRoot);
  // npm can omit its hidden lock, for example after a different client handles node_modules.
  for (let dir = root; resolved === undefined; dir = dirname(dir)) {
    resolved = await resolvedFromLock(join(dir, "npm-shrinkwrap.json"), dir, packageRoot);
    if (resolved === undefined)
      resolved = await resolvedFromLock(join(dir, "package-lock.json"), dir, packageRoot);
    if (!searchParents || dirname(dir) === dir) break;
  }
  const match = typeof resolved === "string" && resolved.match(gitSource);
  return match ? { revision: match[1].toLowerCase(), kind: "npm" } : undefined;
}

export async function installedRevision(options) {
  return (await installedProvenance(options))?.revision;
}

export function revisionPin(requested) {
  if (typeof requested !== "string" || !pinPattern.test(requested))
    throw new Error("Provide a full Git commit SHA or its 12-character prefix with --revision");
  return requested.toLowerCase();
}

export function provenanceError(
  message = "Cannot verify the running GRAIT package's Git revision.",
) {
  return new Error(
    message + "\nRecover the verified global installation with:\n  " + globalInstallCommand,
  );
}

export async function requireInstalledProvenance() {
  let provenance;
  try {
    provenance = await installedProvenance();
  } catch {
    throw provenanceError(
      "GRAIT installation provenance is invalid or does not match the running package.",
    );
  }
  if (!provenance) throw provenanceError();
  return provenance;
}

export async function resolveInstallRevision(requested, { requireInstalled } = {}) {
  const pin = revisionPin(requested);
  const revision = await installedRevision().catch(() => {
    throw provenanceError("Could not read the installed GRAIT Git revision.");
  });
  if (!revision) {
    if (!requireInstalled && pin.length === 40) return pin;
    throw provenanceError();
  }
  if (!revision.startsWith(pin))
    throw new Error(
      "Requested Git revision " +
        pin +
        " does not match the running GRAIT package (" +
        revision +
        ").",
    );
  return revision;
}

export function initSelector(requested) {
  if (requested === undefined || tagPattern.test(requested)) return requested;
  return revisionPin(requested);
}

export async function fetchInitRevision({ stage, selector }) {
  const cliPath = join(stage, "node_modules", "grait", "dist", "cli.mjs");
  try {
    await command(
      "npm",
      [
        "install",
        "--prefix",
        stage,
        "--no-global",
        "--ignore-scripts",
        "--allow-git=root",
        "--package-lock",
        "--no-audit",
        "--no-fund",
        canonicalPackage + "#" + selector,
      ],
      { cwd: stage, env: withoutCredentials() },
    );
    const resolved = await installedProvenance({ cliPath, searchParents: false });
    if (
      resolved?.kind !== "npm" ||
      (!tagPattern.test(selector) && !resolved.revision.startsWith(selector)) ||
      (await realpath(cliPath)) !== cliPath ||
      !(await lstat(cliPath)).isFile()
    )
      throw new Error("Unverified Git installation");
    return { cliPath, revision: resolved.revision };
  } catch {
    throw new Error(
      "Could not fetch and verify GRAIT at " +
        selector +
        " from the canonical Git repository. Check the revision, npm, and GitHub connectivity.",
    );
  }
}

export async function installGlobal({ args, cwd }) {
  const { values } = parseArgs({
    args,
    options: { help: { type: "boolean", short: "h" }, prefix: { type: "string" } },
  });
  if (values.help) {
    console.log(
      "Run install-global from a canonical Git-pinned npm exec package. Set --prefix PATH to use an isolated npm prefix.",
    );
    return 0;
  }
  const { kind, revision } = await requireInstalledProvenance();
  if (kind !== "npm" || !fullSha.test(revision))
    throw provenanceError(
      "Run the Git bootstrap to select the revision before installing globally.",
    );
  const npmOptions = ["--global", ...(values.prefix ? ["--prefix", values.prefix] : [])];
  const env = withoutCredentials();
  const expected = await readFile(runtimeFile);
  const root = await command("npm", ["root", ...npmOptions], { cwd, env });
  const modules = root.stdout.trim();
  if (!modules || /[\r\n]/.test(modules))
    throw new Error("npm did not report a global package directory");
  await command(
    "npm",
    [
      "install",
      ...npmOptions,
      "--ignore-scripts",
      "--allow-git=root",
      "--no-audit",
      "--no-fund",
      canonicalPackage + "#" + revision,
    ],
    { cwd, env },
  );
  const packageRoot = join(modules, "grait");
  const cliPath = join(packageRoot, "dist", "cli.mjs");
  if (!(await lstat(cliPath)).isFile() || !(await readFile(cliPath)).equals(expected))
    throw provenanceError("The global GRAIT executable does not match the verified Git package.");
  const temp = join(packageRoot, receiptName + "." + randomUUID());
  try {
    await writeFile(
      temp,
      JSON.stringify({
        source: canonicalPackage + "#" + revision,
        sha256: cliDigest(expected),
      }) + "\n",
      { flag: "wx", mode: 0o644 },
    );
    await rename(temp, join(packageRoot, receiptName));
  } finally {
    await rm(temp, { force: true });
  }
  console.log(
    "Installed GRAIT globally at " + revision + ". Run grait init in your target checkout.",
  );
  return 0;
}

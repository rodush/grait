import { readFile } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { bundledRuntime, runtimeFile } from "../scripts/lib/runtime-resources.mjs";

const gitSource =
  /^git\+(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com[:/])rodush\/grait(?:\.git)?#([a-f0-9]{40})$/i;
const pinPattern = /^(?:[a-f0-9]{12}|[a-f0-9]{40})$/i;

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

export async function installedRevision({
  cliPath = bundledRuntime ? runtimeFile : undefined,
  searchParents = true,
} = {}) {
  if (!cliPath) return undefined;
  const packageRoot = dirname(dirname(cliPath));
  const modules = dirname(packageRoot);
  if (basename(packageRoot) !== "grait" || basename(modules) !== "node_modules") return undefined;
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
  return match ? match[1].toLowerCase() : undefined;
}

export function revisionPin(requested) {
  if (typeof requested !== "string" || !pinPattern.test(requested))
    throw new Error("Provide a full Git commit SHA or its 12-character prefix with --revision");
  return requested.toLowerCase();
}

export async function resolveInstallRevision(requested, { requireInstalled } = {}) {
  const pin = revisionPin(requested);
  let revision;
  try {
    revision = await installedRevision();
  } catch {
    throw new Error(
      "Could not read npm's installed GRAIT Git pin. Rerun the Git-pinned npm exec command.",
    );
  }
  if (!revision) {
    if (!requireInstalled && pin.length === 40) return pin;
    throw new Error(
      "Cannot verify the running GRAIT package's Git revision. Use npm exec with the pinned GRAIT Git package and its npm lockfile.",
    );
  }
  if (!revision.startsWith(pin))
    throw new Error(
      `Requested Git revision ${pin} does not match the running GRAIT package (${revision}).`,
    );
  return revision;
}

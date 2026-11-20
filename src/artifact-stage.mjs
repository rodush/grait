import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rmdir,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";

const idPattern = /^[a-f0-9]{32}$/;

async function info(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function inside(root, path) {
  const suffix = relative(root, path);
  return !suffix || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
}

async function regularAncestors(path, { directory = false } = {}) {
  const absolute = resolve(path);
  const parts = [];
  let current = absolute;
  while (dirname(current) !== current) {
    parts.unshift(current);
    current = dirname(current);
  }
  for (const candidate of parts) {
    const value = await info(candidate);
    if (!value) continue;
    if (value.isSymbolicLink()) throw new Error(`Refusing symbolic link path: ${candidate}`);
    if ((candidate !== absolute || directory) && !value.isDirectory())
      throw new Error(`Expected directory: ${candidate}`);
    if (candidate === absolute && !directory && !value.isFile())
      throw new Error(`Expected regular file: ${candidate}`);
  }
  return absolute;
}

function artifactPath(path) {
  if (
    typeof path !== "string" ||
    !path ||
    isAbsolute(path) ||
    /^[a-zA-Z]:/.test(path) ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.split("/").some((part) => !part || [".", "..", ".git"].includes(part))
  )
    throw new Error("Artifact paths must be safe relative paths outside Git metadata");
  return path;
}

async function locations(root, stateDirectory, create = false) {
  if (typeof root !== "string" || typeof stateDirectory !== "string")
    throw new Error("Provide a project root and private state directory");
  await regularAncestors(root, { directory: true });
  const project = await realpath(root);
  const state = await regularAncestors(stateDirectory, { directory: true });
  // Ancestor checks reject symlink aliases even when the final directory is new.
  if (inside(project, state))
    throw new Error("Artifact staging must remain outside the project worktree");
  if (create) await mkdir(state, { recursive: true, mode: 0o700 });
  const metadata = await info(state);
  if (metadata && (metadata.mode & 0o077 || (process.getuid && metadata.uid !== process.getuid())))
    throw new Error("Artifact staging storage must be private and owned by you");
  return { root: project, stateDirectory: state };
}

async function contents(root, path) {
  const destination = join(root, artifactPath(path));
  await regularAncestors(destination);
  const value = await info(destination);
  if (!value) return { content: null, mode: null };
  return { content: await readFile(destination, "utf8"), mode: value.mode & 0o777 };
}

/** Read current artifact text using the same path checks as staging. */
export async function readArtifact(root, path) {
  return (await contents(root, path)).content;
}

async function atomicWrite(path, content, mode = 0o600, hooks = {}) {
  await regularAncestors(path);
  const temporary = join(dirname(path), `.grait-${randomBytes(16).toString("hex")}.tmp`);
  await hooks.prepareTemporary?.(temporary);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    mode,
  );
  try {
    await hooks.openedTemporary?.(temporary, await file.stat());
    await file.writeFile(content);
    await file.sync();
    await file.close();
    await hooks.beforeRename?.({ path, temporaryPath: temporary });
    await rename(temporary, path);
  } finally {
    await file.close();
    if (!hooks.prepareTemporary)
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
  }
}

async function save(path, value) {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function load(path) {
  await regularAncestors(path);
  const value = await info(path);
  if (!value || value.size > 32 * 1024 * 1024)
    throw new Error("Missing or oversized artifact transaction record");
  return JSON.parse(await readFile(path, "utf8"));
}

function recordPath(directory, id, kind) {
  if (!idPattern.test(id || "")) throw new Error("Invalid artifact transaction ID");
  return join(directory, `${kind}-${id}.json`);
}

function validatePlan(plan, root, id) {
  if (plan.version !== 1 || plan.id !== id || plan.root !== root || !Array.isArray(plan.changes))
    throw new Error("Artifact plan does not match this project and transaction");
  const seen = new Set();
  for (const change of plan.changes) {
    artifactPath(change.path);
    if (
      seen.has(change.path) ||
      ![change.before, change.after].every((text) => text === null || typeof text === "string")
    )
      throw new Error("Invalid artifact plan contents");
    if (
      change.mode !== null &&
      (!Number.isInteger(change.mode) || change.mode < 0 || change.mode > 0o777)
    )
      throw new Error("Invalid artifact file permissions");
    seen.add(change.path);
  }
  for (const path of seen)
    if ([...seen].some((other) => other !== path && other.startsWith(`${path}/`)))
      throw new Error("An artifact cannot also be another artifact's parent");
  return plan;
}

async function acquire(directory, { recover = false } = {}) {
  const path = join(directory, "lock");
  if (recover && (await info(path))) {
    const lock = await load(path);
    if (!Number.isSafeInteger(lock.pid) || lock.pid < 1)
      throw new Error("Invalid artifact transaction lock");
    try {
      process.kill(lock.pid, 0);
      throw new Error("An artifact transaction is still running");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    await unlink(path);
  }
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  await handle.writeFile(JSON.stringify({ pid: process.pid }));
  await handle.sync();
  await handle.close();
  return async () => unlink(path);
}

async function missingParents(root, changes) {
  const missing = new Set();
  for (const change of changes) {
    if (change.after === null) continue;
    let parent = dirname(join(root, change.path));
    while (parent !== root && inside(root, parent)) {
      if (!(await info(parent))) missing.add(relative(root, parent));
      parent = dirname(parent);
    }
  }
  return [...missing].sort(
    (a, b) => a.split(sep).length - b.split(sep).length || a.localeCompare(b),
  );
}

function transactionWriter(root, journal, journalPath) {
  return async (path, content, mode, beforeRename) => {
    let entry;
    await atomicWrite(path, content, mode, {
      prepareTemporary: async (temporary) => {
        entry = {
          path: relative(root, temporary),
          artifact: relative(root, path),
          content,
          identity: null,
        };
        journal.temporaryFiles.push(entry);
        await save(journalPath, journal);
      },
      openedTemporary: async (_temporary, metadata) => {
        entry.identity = { dev: metadata.dev, ino: metadata.ino };
        await save(journalPath, journal);
      },
      beforeRename,
    });
  };
}

async function temporaryFiles(root, plan, journal, remove = false) {
  for (const entry of journal.temporaryFiles) {
    artifactPath(entry.path);
    const artifact = plan.changes.find((change) => change.path === entry.artifact);
    if (
      !artifact ||
      dirname(entry.path) !== dirname(entry.artifact) ||
      !/^\.grait-[a-f0-9]{32}\.tmp$/.test(entry.path.split(sep).at(-1)) ||
      ![artifact.before, artifact.after].includes(entry.content)
    )
      throw new Error("Invalid transaction-owned temporary path");
    const destination = join(root, entry.path);
    await regularAncestors(destination);
    const metadata = await info(destination);
    if (!metadata) continue;
    const current = await readFile(destination);
    // An exclusive-create collision or later replacement is not our file.
    // A known inode may contain a prefix if interrupted during its write.
    if (
      !entry.identity ||
      metadata.dev !== entry.identity.dev ||
      metadata.ino !== entry.identity.ino ||
      typeof entry.content !== "string" ||
      !Buffer.from(entry.content).subarray(0, current.length).equals(current)
    )
      throw new Error(`Recovery conflicts with an unowned or edited temporary file: ${entry.path}`);
    if (remove) await unlink(destination);
  }
}

async function restore(root, plan, journal, journalPath) {
  // Preflight every affected file before rollback, so recovery never silently
  // replaces an edit made after the interrupted process exited.
  for (const change of plan.changes.slice(0, journal.attempted)) {
    const current = await contents(root, change.path);
    if (current.content !== change.before && current.content !== change.after)
      throw new Error(`Recovery conflicts with a later project edit: ${change.path}`);
  }
  await temporaryFiles(root, plan, journal);
  const writeSnapshot = transactionWriter(root, journal, journalPath);
  for (const change of plan.changes.slice(0, journal.attempted).reverse()) {
    const destination = join(root, change.path);
    if (change.before === null) {
      await unlink(destination).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    } else {
      await regularAncestors(dirname(destination), { directory: true });
      await mkdir(dirname(destination), { recursive: true });
      await writeSnapshot(destination, change.before, change.mode ?? 0o644);
    }
  }
  await temporaryFiles(root, plan, journal, true);
  for (const path of [...journal.createdDirectories].reverse()) {
    const destination = join(root, artifactPath(path));
    await regularAncestors(destination, { directory: true });
    await rmdir(destination).catch((error) => {
      if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw error;
    });
  }
}

/** Prepare a durable preview outside the target; no target writes occur here. */
export async function stageArtifacts({ root, artifacts, stateDirectory }) {
  const location = await locations(root, stateDirectory, true);
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts))
    throw new Error("Artifacts must map relative paths to text or null for deletion");
  const changes = [];
  for (const path of Object.keys(artifacts).sort()) {
    artifactPath(path);
    const after = artifacts[path];
    if (after !== null && typeof after !== "string")
      throw new Error("Artifact contents must be text or null");
    const before = await contents(location.root, path);
    if (before.content !== after)
      changes.push({ path, before: before.content, after, mode: before.mode });
  }
  const id = randomBytes(16).toString("hex");
  const plan = validatePlan({ version: 1, id, root: location.root, changes }, location.root, id);
  await save(recordPath(location.stateDirectory, id, "plan"), plan);
  return plan;
}

/** Apply a reviewed preview, recording rollback intent before each target write. */
export async function applyArtifacts({ root, stateDirectory, id, writeFile, beforeRename }) {
  const location = await locations(root, stateDirectory);
  const release = await acquire(location.stateDirectory);
  try {
    const planPath = recordPath(location.stateDirectory, id, "plan");
    const journalPath = recordPath(location.stateDirectory, id, "journal");
    const plan = validatePlan(await load(planPath), location.root, id);
    const journalExists = await info(journalPath);
    if (journalExists) {
      const journal = await load(journalPath);
      if (journal.status === "applying")
        throw new Error("An interrupted application requires recoverArtifacts before retrying");
      if (journal.status === "applied") {
        for (const change of plan.changes)
          if ((await contents(location.root, change.path)).content !== change.after)
            throw new Error(`Applied artifacts have changed: ${change.path}`);
        return { id, applied: true, changes: [] };
      }
      if (journal.status !== "rolled-back") throw new Error("Invalid artifact journal state");
    }
    for (const change of plan.changes)
      if ((await contents(location.root, change.path)).content !== change.before)
        throw new Error(`Artifact changed since preview: ${change.path}`);
    const journal = {
      version: 1,
      id,
      root: location.root,
      status: "applying",
      attempted: 0,
      createdDirectories: await missingParents(location.root, plan.changes),
      temporaryFiles: [],
    };
    await save(journalPath, journal);
    const writeSnapshot = transactionWriter(location.root, journal, journalPath);
    try {
      for (let index = 0; index < plan.changes.length; index++) {
        const change = plan.changes[index];
        const destination = join(location.root, change.path);
        await regularAncestors(destination);
        if ((await contents(location.root, change.path)).content !== change.before)
          throw new Error(`Artifact changed during application: ${change.path}`);
        journal.attempted = index + 1;
        await save(journalPath, journal);
        if (change.after === null) await unlink(destination);
        else {
          await mkdir(dirname(destination), { recursive: true });
          await regularAncestors(destination);
          if (writeFile) {
            await writeFile(destination, change.after);
            await regularAncestors(destination);
            await chmod(destination, change.mode ?? 0o644);
          } else await writeSnapshot(destination, change.after, change.mode ?? 0o644, beforeRename);
        }
      }
      journal.status = "applied";
      await save(journalPath, journal);
    } catch (error) {
      try {
        await restore(location.root, plan, journal, journalPath);
        journal.status = "rolled-back";
        await save(journalPath, journal);
      } catch {
        throw new Error(
          "Artifact application failed and rollback is incomplete; preserve the transaction and run recoverArtifacts",
          { cause: error },
        );
      }
      throw error;
    }
    return { id, applied: true, changes: plan.changes };
  } finally {
    await release();
  }
}

/** Explicitly roll back a process-interrupted transaction before applying again. */
export async function recoverArtifacts({ root, stateDirectory, id }) {
  const location = await locations(root, stateDirectory);
  const release = await acquire(location.stateDirectory, { recover: true });
  try {
    const plan = validatePlan(
      await load(recordPath(location.stateDirectory, id, "plan")),
      location.root,
      id,
    );
    const journalPath = recordPath(location.stateDirectory, id, "journal");
    if (!(await info(journalPath))) return { id, recovered: false, changes: [] };
    const journal = await load(journalPath);
    if (
      journal.version !== 1 ||
      journal.id !== id ||
      journal.root !== location.root ||
      !Number.isInteger(journal.attempted) ||
      journal.attempted < 0 ||
      journal.attempted > plan.changes.length ||
      !Array.isArray(journal.createdDirectories)
    )
      throw new Error("Invalid artifact recovery journal");
    if (["applied", "rolled-back"].includes(journal.status))
      return { id, recovered: false, changes: [] };
    if (journal.status !== "applying") throw new Error("Invalid artifact recovery state");
    if (journal.temporaryFiles === undefined) journal.temporaryFiles = [];
    if (!Array.isArray(journal.temporaryFiles))
      throw new Error("Invalid artifact temporary-file journal");
    await restore(location.root, plan, journal, journalPath);
    journal.status = "rolled-back";
    await save(journalPath, journal);
    return { id, recovered: true, changes: plan.changes.slice(0, journal.attempted) };
  } finally {
    await release();
  }
}

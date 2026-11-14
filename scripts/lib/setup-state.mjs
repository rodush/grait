import { mkdir, open, readFile, rename, unlink, lstat, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { command } from "./setup-process.mjs";

const roles = new Set(["writer", "reviewer", "release"]);

function validate(state, repo) {
  if (
    state.version !== 1 ||
    state.repo?.toLowerCase() !== repo.toLowerCase() ||
    !state.apps ||
    typeof state.apps !== "object" ||
    Array.isArray(state.apps)
  )
    throw new Error(
      "Setup recovery state is malformed or belongs to another target; inspect Git metadata before continuing",
    );
  if (state.enabled !== undefined && typeof state.enabled !== "boolean")
    throw new Error("Local activation state must be boolean");
  if (
    state.port !== undefined &&
    (!Number.isInteger(state.port) || state.port < 1024 || state.port > 65535)
  )
    throw new Error("Invalid setup callback port in recovery state");
  for (const [role, app] of Object.entries(state.apps)) {
    if (
      !roles.has(role) ||
      !app ||
      typeof app !== "object" ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(app.name || "")
    )
      throw new Error("Invalid App recovery state; refusing to provision replacements");
    if (
      app.id !== undefined &&
      (!Number.isSafeInteger(app.id) ||
        app.id < 1 ||
        !/^[a-z0-9-]+$/.test(app.slug || "") ||
        typeof app.clientId !== "string")
    )
      throw new Error("Invalid App identity in setup recovery state");
    if (
      app.pem !== undefined &&
      (typeof app.pem !== "string" || !app.pem.startsWith("-----BEGIN ") || app.pem.length > 20000)
    )
      throw new Error("Invalid private credential in setup recovery state");
    if (app.state !== undefined && !/^[a-f0-9]{64}$/.test(app.state))
      throw new Error("Invalid browser state in setup checkpoint");
  }
  return state;
}

export class SetupState {
  static async location(cwd = process.cwd()) {
    const result = await command("git", ["rev-parse", "--git-common-dir"], { cwd });
    return join(resolve(cwd, result.stdout.trim()), "grait-setup");
  }

  static async read(repo, cwd = process.cwd()) {
    const directory = await SetupState.location(cwd);
    const path = join(directory, "session.json");
    try {
      const directoryInfo = await lstat(directory);
      const info = await lstat(path);
      if (
        !directoryInfo.isDirectory() ||
        directoryInfo.isSymbolicLink() ||
        !info.isFile() ||
        info.isSymbolicLink() ||
        directoryInfo.mode & 0o077 ||
        info.mode & 0o077 ||
        (directoryInfo.uid !== undefined &&
          process.getuid &&
          directoryInfo.uid !== process.getuid()) ||
        (info.uid !== undefined && process.getuid && info.uid !== process.getuid())
      )
        throw new Error(
          "Setup recovery files must be private, owned by you, and not symbolic links",
        );
      if (info.size > 200000) throw new Error("Setup recovery state exceeds the supported size");
      return { directory, state: validate(JSON.parse(await readFile(path, "utf8")), repo) };
    } catch (error) {
      if (error.code === "ENOENT") return { directory, state: { version: 1, repo, apps: {} } };
      if (error instanceof SyntaxError)
        throw new Error(
          "Setup recovery state is malformed; inspect Git metadata before continuing",
        );
      throw error;
    }
  }

  constructor(directory, state) {
    this.directory = directory;
    this.state = state;
    this.lock = null;
  }

  async acquire() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Setup metadata directory must be private and not a symbolic link");
    const path = join(this.directory, "lock");
    try {
      this.lock = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      await this.lock.writeFile(String(process.pid));
    } catch (error) {
      if (this.lock) {
        await this.lock.close();
        this.lock = null;
        await unlink(path);
      }
      if (error.code !== "EEXIST") throw error;
      throw new Error(
        "Setup/orchestrator lock already exists. Stop the owning process first; inspect and remove a stale lock manually before retrying.",
      );
    }
    try {
      try {
        const info = await lstat(join(this.directory, "session.json"));
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.mode & 0o077 ||
          (process.getuid && info.uid !== process.getuid())
        )
          throw new Error("Unsafe setup checkpoint path");
        const current = validate(
          JSON.parse(await readFile(join(this.directory, "session.json"), "utf8")),
          this.state.repo,
        );
        if (JSON.stringify(current) !== JSON.stringify(this.state))
          throw new Error(
            "Setup state changed before the lock was acquired; reload and retry instead of overwriting another session",
          );
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new Error(
            "Setup recovery state is malformed; inspect Git metadata before continuing",
          );
        if (error.code !== "ENOENT") throw error;
      }
      await this.save();
    } catch (error) {
      await this.release();
      throw error;
    }
  }

  async save() {
    validate(this.state, this.state.repo);
    const path = join(this.directory, "session.json");
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe setup checkpoint path");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = join(this.directory, `session-${randomBytes(12).toString("hex")}.tmp`);
    const file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(`${JSON.stringify(this.state, null, 2)}\n`);
      await file.sync();
      await file.close();
      await rename(temporary, path);
      await chmod(path, 0o600);
    } finally {
      await file.close();
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async release() {
    if (!this.lock) return;
    await this.lock.close();
    this.lock = null;
    await unlink(join(this.directory, "lock"));
  }
}

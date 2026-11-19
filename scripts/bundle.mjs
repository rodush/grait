import { readdir, readFile, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "dist");
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--check") || args.length > 1)
  throw new Error("Usage: node scripts/bundle.mjs [--check]");

async function files(directory, prefix = "") {
  const result = new Map();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return result;
    throw error;
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const path = join(directory, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink())
      throw new Error(`Distribution input/output cannot be a symlink: ${relative}`);
    if (entry.isDirectory()) {
      for (const [name, contents] of await files(path, relative)) result.set(name, contents);
    } else if (entry.isFile()) {
      result.set(relative, await readFile(path));
    } else {
      throw new Error(`Unsupported distribution file: ${relative}`);
    }
  }
  return result;
}

// Copy dependency-free ESM modules without machine paths, timestamps, or install hooks.
const expected = await files(join(root, "src"));
if (!expected.has("cli.mjs")) throw new Error("The CLI source entrypoint is missing");
if (args.includes("--check")) {
  const actual = await files(output);
  const changed = [...new Set([...expected.keys(), ...actual.keys()])]
    .sort()
    .filter(
      (path) =>
        !expected.has(path) || !actual.has(path) || !expected.get(path).equals(actual.get(path)),
    );
  if (changed.length)
    throw new Error(
      `Committed distribution is stale: ${changed.join(", ")}. Run npm run bundle and commit dist/.`,
    );
  console.log("Committed distribution matches source.");
} else {
  await rm(output, { recursive: true, force: true });
  for (const [path, contents] of expected) {
    const target = join(output, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await chmod(join(output, "cli.mjs"), 0o755);
  console.log(`Bundled ${expected.size} file(s) into dist/.`);
}

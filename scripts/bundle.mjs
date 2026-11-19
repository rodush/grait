import { readdir, readFile, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname, relative } from "node:path";
import { build } from "esbuild";
import { format, resolveConfig } from "prettier";

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

// Compile each public/process entry and its dependency graph. Runtime adapters
// are executable package resources; repository tests and helper source trees
// are never distribution inputs.
const entries = new Map();
for (const entry of await readdir(join(root, "src")))
  if (entry.endsWith(".mjs")) entries.set(entry, `src/${entry}`);
if (!entries.has("cli.mjs")) throw new Error("The CLI source entrypoint is missing");
for (const entry of ["orchestrator.mjs", "github.mjs", "bootstrap.mjs", "activate.mjs"])
  entries.set(`scripts/${entry}`, `scripts/${entry}`);
entries.set("scripts/lib/verification.mjs", "scripts/lib/verification.mjs");
for (const entry of ["node-suite.mjs", "node-test-reporter.mjs"])
  entries.set(`scripts/adapters/${entry}`, `scripts/adapters/${entry}`);

const formatting = await resolveConfig(join(root, "package.json"));
const expected = new Map();
for (const [name, entry] of entries) {
  const base = relative(dirname(join(output, name)), output).replaceAll("\\", "/");
  const result = await build({
    absWorkingDir: root,
    entryPoints: [entry],
    outfile: join(output, name),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    write: false,
    legalComments: "none",
    define: { GRAIT_RUNTIME_BASE: JSON.stringify(base ? `${base}/` : "./") },
  });
  expected.set(
    name,
    Buffer.from(await format(result.outputFiles[0].text, { ...formatting, filepath: name })),
  );
}
// Only explicitly owned static runtime resources are copied.
for (const [name, contents] of await files(join(root, "automation", "policy")))
  expected.set(`automation/policy/${name}`, contents);
try {
  expected.set(
    "defaults/workflow.config.json",
    await readFile(join(root, "config", "project-workflow.json")),
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
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

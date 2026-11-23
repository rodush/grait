import { readdir, readFile, mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { build } from "esbuild";

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

// One Node.js entry embeds all executable helpers, policy, and version data.
// Imports and subprocess adapters reuse this file without package siblings.
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const policy = await readFile(join(root, "automation/policy/shared.md"), "utf8");
const notices = await Promise.all(
  ["smol-toml", "yaml"].map(async (name) => {
    const license = await readFile(join(root, "node_modules", name, "LICENSE"), "utf8");
    return `/*! ${name}\n${license.trimEnd().replaceAll("*/", "* /")}\n*/`;
  }),
);
const result = await build({
  absWorkingDir: root,
  entryPoints: ["src/cli.mjs"],
  outfile: join(output, "cli.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  // Bundled CommonJS dependencies can still load Node built-ins from the ESM entry.
  banner: {
    js: [
      ...notices,
      'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    ].join("\n"),
  },
  target: "node24",
  minify: true,
  write: false,
  legalComments: "none",
  define: {
    GRAIT_BUNDLED: "true",
    GRAIT_VERSION: JSON.stringify(version),
    GRAIT_SHARED_POLICY: JSON.stringify(policy),
  },
});
const expected = new Map([["cli.mjs", Buffer.from(result.outputFiles[0].contents)]]);
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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateHarnessFiles } from "./lib/harnesses.mjs";

const root = resolve(import.meta.dirname, "..");
const check = process.argv.includes("--check");
const files = await generateHarnessFiles(root);
for (const [path, expected] of files) {
  const target = resolve(root, path);
  if (check) {
    const actual = await readFile(target, "utf8").catch(() => null);
    if (actual !== expected)
      throw new Error(`Generated harness file is stale: ${path}; run npm run harness:generate`);
  } else {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, expected);
  }
}
console.log(
  `${check ? "Checked" : "Generated"} ${files.size} skill and agent adapters from shared sources.`,
);

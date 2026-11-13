import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp, cp, rm } from "node:fs/promises";
import { join, matchesGlob } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { parse as parseToml } from "smol-toml";
import { generateHarnessFiles } from "../scripts/lib/harnesses.mjs";

const root = new URL("..", import.meta.url).pathname;
const frontmatter = async (path) =>
  parse((await readFile(new URL(path, import.meta.url), "utf8")).split("\n---")[0].slice(4));

test("tester safe outputs accept collocated test globs while implementer excludes every test glob", async () => {
  const create = (await frontmatter("../.github/workflows/shared/tester-output.md"))[
    "safe-outputs"
  ]["create-pull-request"];
  const develop = (await frontmatter("../.github/workflows/shared/developer-output.md"))[
    "safe-outputs"
  ]["push-to-pull-request-branch"];
  assert.equal(create.draft, true);
  const accepts = (output, path) =>
    output["allowed-files"].some((pattern) => matchesGlob(path, pattern)) &&
    !output["excluded-files"].some((pattern) => matchesGlob(path, pattern));
  for (const path of [
    "tests/direct.py",
    "src/test_feature.py",
    "src/feature.spec.py",
    "src/nested/feature.test.mjs",
  ]) {
    assert.equal(accepts(create, path), true, path);
    assert.equal(accepts(develop, path), false, path);
  }
  assert.equal(accepts(create, "src/feature.py"), false);
  assert.equal(accepts(develop, "src/feature.py"), true);
  for (const output of [create, develop])
    for (const path of [
      ".github/workflows/ci.yml",
      "scripts/authorize.mjs",
      "workflow.config.json",
    ])
      assert.equal(accepts(output, path), false, path);
});

test("native tester and implementer profiles independently apply configured models and reasoning", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "grait-role-profiles-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const config = JSON.parse(await readFile(join(root, "workflow.config.json"), "utf8"));
  config.tdd.profiles.tester = { model: "tester-model", reasoning: "high" };
  config.tdd.profiles.implementer = { model: "implementer-model", reasoning: "medium" };
  await cp(join(root, "automation"), join(temporary, "automation"), { recursive: true });
  for (const engine of ["codex", "claude", "copilot"]) {
    config.engine = engine;
    await writeFile(join(temporary, "workflow.config.json"), JSON.stringify(config));
    const files = await generateHarnessFiles(temporary);
    for (const [name, profile] of [
      ["grait-test", config.tdd.profiles.tester],
      ["grait-implement", config.tdd.profiles.implementer],
      ["grait-fix", config.tdd.profiles.implementer],
    ]) {
      const codex = parseToml(files.get(`.codex/agents/${name}.toml`));
      assert.equal(codex.model, engine === "codex" ? profile.model : undefined);
      assert.equal(
        codex.model_reasoning_effort,
        engine === "codex" ? profile.reasoning : undefined,
      );
      assert.equal(codex.sandbox_mode, undefined);
      assert.equal(codex.approval_policy, undefined);
      for (const [provider, path, suffix] of [
        ["claude", ".claude/agents", ".md"],
        ["copilot", ".github/agents", ".agent.md"],
      ]) {
        const body = files.get(`${path}/${name}${suffix}`);
        const metadata = parse(body.split("\n---")[0].slice(4));
        assert.equal(metadata.model, engine === provider ? profile.model : undefined);
        assert.equal(metadata.tools, undefined);
        assert.equal(metadata.permissions, undefined);
      }
    }
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const moduleUrl = new URL("../src/project-policy.mjs", import.meta.url);
const start = "<!-- grait:policy:start version=0.1.0 -->";
const end = "<!-- grait:policy:end -->";
const integrations = {
  codex: [".agents/skills/grait-orchestrator/SKILL.md", ".codex/config.toml"],
  claude: ["CLAUDE.md", ".claude/skills/grait-orchestrator/SKILL.md"],
  copilot: [".github/copilot-instructions.md", ".github/agents/grait-orchestrator.agent.md"],
};

async function generator() {
  const present = await access(moduleUrl).then(
    () => true,
    () => false,
  );
  assert.ok(present, "The project policy generator must be available");
  const module = await import(moduleUrl);
  assert.equal(typeof module.generateProjectArtifacts, "function");
  return module.generateProjectArtifacts;
}

function asObject(artifacts) {
  return artifacts instanceof Map ? Object.fromEntries(artifacts) : artifacts;
}

for (const harness of Object.keys(integrations)) {
  test(`project policy generates only the selected ${harness} integration`, async () => {
    const generate = await generator();
    const files = asObject(
      await generate({
        harness,
        version: "0.1.0",
        project: { name: "Orchard", context: "Kotlin project; run ./gradlew test from mobile/." },
      }),
    );
    assert.equal(typeof files["AGENTS.md"], "string");
    assert.ok(files["AGENTS.md"].includes(start));
    assert.ok(files["AGENTS.md"].includes(end));
    assert.match(files["AGENTS.md"], /Orchard/);
    assert.match(files["AGENTS.md"], /Kotlin project; run \.\/gradlew test from mobile\//);
    for (const path of integrations[harness]) assert.equal(typeof files[path], "string", path);
    for (const [other, paths] of Object.entries(integrations)) {
      if (other === harness) continue;
      for (const path of paths) assert.equal(files[path], undefined, path);
    }
    const output = Object.values(files).join("\n");
    assert.match(output, /grait orchestrator/);
    for (const role of ["orchestrator", "triage", "test", "implement", "review", "fix"])
      assert.ok(output.includes(`grait-${role}`), `Missing selected-harness ${role} role`);
    assert.doesNotMatch(output, /npm run (?:orchestrator|github|harness:generate|check)/);
    assert.doesNotMatch(output, /scripts\/(?:orchestrator|github|harnesses)\.mjs/);
    assert.doesNotMatch(output, /tests\/\*\.test\.mjs|GRAIT development|npm run bundle/);
    assert.equal(files["package.json"], undefined);
    assert.equal(files["package-lock.json"], undefined);
  });

  test(`project policy preserves existing ${harness} instructions and repeats stably`, async () => {
    const generate = await generator();
    const existing = {
      "AGENTS.md": "# Orchard rules\n\nPreserve public API compatibility.\n",
      [integrations[harness][0]]:
        "# Local conventions\n\nUse our established application commands.\n",
      [integrations[harness][1]]:
        harness === "codex"
          ? 'model = "custom-model"\n\n[projects."/work/orchard"]\ntrust_level = "trusted"\n'
          : "# Additional local guidance\n\nKeep review notes concise.\n",
      "mobile/build.gradle.kts": 'plugins { kotlin("jvm") }\n',
      "package.json": '{"name":"existing-application","scripts":{"test":"app-test"}}\n',
    };
    const before = structuredClone(existing);
    const options = { harness, version: "0.1.0", project: { name: "Orchard" }, existing };
    const files = asObject(await generate(options));
    assert.deepEqual(existing, before, "generation must not mutate caller-owned content");
    for (const path of ["AGENTS.md", ...integrations[harness]]) {
      assert.ok(files[path].includes(before[path]), `${path} lost user-owned content`);
    }
    const repeated = asObject(await generate({ ...options, existing: { ...existing, ...files } }));
    assert.deepEqual(repeated, files);
    assert.equal((files["AGENTS.md"].match(/grait:policy:start/g) || []).length, 1);
    assert.equal(files["mobile/build.gradle.kts"], undefined);
    assert.equal(files["package.json"], undefined);
  });
}

test("project policy includes the canonical shared engineering rules", async () => {
  const generate = await generator();
  const canonicalUrl = new URL("../automation/policy/shared.md", import.meta.url);
  const canonicalExists = await access(canonicalUrl).then(
    () => true,
    () => false,
  );
  assert.ok(canonicalExists, "Shared policy must have a canonical source");
  const canonical = (await readFile(canonicalUrl, "utf8")).trim();
  assert.ok(canonical.length > 100);
  const files = asObject(await generate({ harness: "codex", version: "0.1.0" }));
  assert.ok(files["AGENTS.md"].includes(canonical));
  for (const rule of [
    /human/i,
    /merge/i,
    /release/i,
    /issue/i,
    /dependenc/i,
    /review/i,
    /tester/i,
    /implementer/i,
    /credential|secret/i,
    /(?:five|5)/i,
    /readiness|ready/i,
    /priority|prioriti|before.*(?:new|claim)/i,
    /separate|independent/i,
    /(?:ten|10)|bounded/i,
  ]) {
    assert.match(canonical, rule);
  }
});

const backgroundTriage =
  /\b(?:triage\b[^.!?\n]*\b(?:background|concurrent(?:ly)?|parallel)|(?:background|concurrent(?:ly)?|parallel)\b[^.!?\n]*\btriage)\b/i;
const completedWorkerCapacity =
  /\b(?:release|free|return|reuse|reclaim|remove|exclude)\w*\b[^.!?\n]*\b(?:slots?|capacity|worker count)\b/i;

function assertTriageLifecycle(instructions, destination) {
  assert.ok(backgroundTriage.test(instructions), `${destination} must describe background triage`);
  assert.ok(
    completedWorkerCapacity.test(instructions),
    `${destination} must release capacity when a triage assignment completes`,
  );
}

test("repository orchestrator instructions and operator docs explain background triage and worker release", async () => {
  for (const destination of [
    "automation/skills/grait-orchestrator/SKILL.md",
    ".agents/skills/grait-orchestrator/SKILL.md",
    ".claude/skills/grait-orchestrator/SKILL.md",
    ".github/skills/grait-orchestrator/SKILL.md",
    "docs/operations.md",
  ]) {
    const instructions = await readFile(new URL(`../${destination}`, import.meta.url), "utf8");
    assertTriageLifecycle(instructions, destination);
  }
});

test("installed orchestrator instructions explain background triage and worker release for each harness", async () => {
  const generate = await generator();
  for (const [harness, root] of [
    ["codex", ".agents"],
    ["claude", ".claude"],
    ["copilot", ".github"],
  ]) {
    const files = asObject(await generate({ harness, version: "0.1.0" }));
    const destination = `${root}/skills/grait-orchestrator/SKILL.md`;
    assertTriageLifecycle(files[destination], destination);
  }
});

test("project policy rejects malformed or duplicate managed policy boundaries", async () => {
  const generate = await generator();
  for (const agents of [
    `${start}\nInterrupted managed text\n`,
    `${end}\nUser text\n`,
    `${start}\nA\n${end}\n${start}\nB\n${end}\n`,
    `${end}\nReversed\n${start}\n`,
  ]) {
    await assert.rejects(async () => {
      await generate({ harness: "codex", version: "0.1.0", existing: { "AGENTS.md": agents } });
    });
  }
});

test("project policy rejects unsupported harnesses and unsafe version markers", async () => {
  const generate = await generator();
  await assert.rejects(async () => {
    await generate({ harness: "unknown", version: "0.1.0" });
  });
  await assert.rejects(async () => {
    await generate({ harness: "codex", version: "0.1.0 -->\nInjected unmanaged text" });
  });
});

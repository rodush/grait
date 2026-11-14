import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
const moduleUrl = new URL("../scripts/lib/harness-runtime.mjs", import.meta.url);
const runtime = existsSync(moduleUrl) ? await import(moduleUrl) : {};
const { harnessArguments } = runtime;
const available = typeof harnessArguments === "function";
const value = (args, flag) => args[args.indexOf(flag) + 1];

test("native harness launch arguments are available for all supported local engines", () => {
  assert.equal(typeof harnessArguments, "function");
});

test(
  "Copilot launch selects the native role effort explicit built-in model and interactive prompt",
  { skip: !available },
  () => {
    const prompt = "Coordinate the accepted local issue";
    const defaultArgs = harnessArguments("copilot", { prompt });
    assert.equal(value(defaultArgs, "--agent"), "grait-orchestrator");
    assert.equal(value(defaultArgs, "--effort"), "medium");
    assert.equal(value(defaultArgs, "--model"), "auto");
    assert.equal(value(defaultArgs, "--interactive"), prompt);
    const selected = harnessArguments("copilot", {
      prompt,
      role: "review",
      profile: { model: "gpt-5", reasoning: "high" },
      reasoning: "medium",
    });
    assert.equal(value(selected, "--agent"), "grait-review");
    assert.equal(value(selected, "--effort"), "high");
    assert.equal(value(selected, "--model"), "gpt-5");
    assert.equal(value(selected, "--interactive"), prompt);
    assert.ok(!selected.includes("--allow-all-tools"));
    assert.ok(!selected.includes("--yolo"));
    assert.throws(() =>
      harnessArguments("copilot", { prompt, profile: { model: "external-provider/gpt-5" } }),
    );
  },
);

test(
  "Codex and Claude launch arguments keep their native profile meanings",
  { skip: !available },
  () => {
    const prompt = "Implement the accepted public behavior";
    const codex = harnessArguments("codex", {
      prompt,
      role: "implement",
      profile: { model: "codex-selected-model", reasoning: "high" },
      reasoning: "medium",
    });
    assert.ok(codex.includes(prompt));
    assert.ok(codex.some((arg) => arg.includes("codex-selected-model")));
    assert.ok(codex.some((arg) => arg.includes("model_reasoning_effort") && arg.includes("high")));
    const claude = harnessArguments("claude", {
      prompt,
      role: "implement",
      profile: { model: "claude-selected-model", reasoning: "high" },
      reasoning: "medium",
    });
    assert.ok(claude.includes(prompt));
    assert.equal(value(claude, "--model"), "claude-selected-model");
    assert.equal(value(claude, "--effort"), "high");
  },
);

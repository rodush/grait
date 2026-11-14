// CLI arguments are kept separate from GitHub publishing credentials and from
// native permission controls. No engine receives automatic approval-bypass flags.
export function harnessArguments(harness, { prompt, role, profile = {}, reasoning = "medium" }) {
  if (typeof prompt !== "string" || !prompt.trim())
    throw new Error("A native harness prompt is required");
  if (role && !["orchestrator", "triage", "test", "implement", "review", "fix"].includes(role))
    throw new Error("Unknown native role");
  const effort = profile.reasoning || reasoning;
  const model = profile.model ? ["--model", profile.model] : [];
  if (harness === "codex")
    return [
      ...(profile.reasoning
        ? ["-c", `model_reasoning_effort=${JSON.stringify(profile.reasoning)}`]
        : []),
      ...model,
      prompt,
    ];
  if (harness === "claude")
    return [...(role ? ["--agent", `grait-${role}`] : []), "--effort", effort, ...model, prompt];
  if (harness === "copilot") {
    if (profile.model?.includes("/"))
      throw new Error("Choose a Copilot-served model, not a provider-qualified BYOK model");
    return [
      "--agent",
      `grait-${role || "orchestrator"}`,
      "--effort",
      effort,
      "--model",
      profile.model || "auto",
      "--interactive",
      prompt,
    ];
  }
  throw new Error("Unsupported native harness");
}

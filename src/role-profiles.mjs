export const workflowRoles = ["orchestrator", "triage", "test", "implement", "review", "fix"];

const sharedEfforts = ["low", "medium", "high", "xhigh", "max"];
const nativeEfforts = {
  codex: ["none", "minimal", ...sharedEfforts, "ultra"],
  claude: sharedEfforts,
  copilot: sharedEfforts,
};
const nativeEffortKeys = {
  codex: "model_reasoning_effort",
  claude: "effort",
  copilot: "reasoningEffort",
};
const legacyRoles = { test: "tester", implement: "implementer", fix: "implementer" };

function profileEntries(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${path} must be an object`);
  return Object.entries(value);
}

export function validateRoleProfiles(profiles) {
  if (profiles === undefined) return;
  for (const [engine, roles] of profileEntries(profiles, "roleProfiles")) {
    if (!Object.hasOwn(nativeEfforts, engine))
      throw new Error(`Unknown roleProfiles engine: ${engine}`);
    for (const [role, settings] of profileEntries(roles, `roleProfiles.${engine}`)) {
      const path = `roleProfiles.${engine}.${role}`;
      if (!workflowRoles.includes(role)) throw new Error(`Unknown roleProfiles role: ${path}`);
      for (const [field, value] of profileEntries(settings, path)) {
        if (field === "model") {
          const modelPattern =
            engine === "claude" ? /^[\w][\w./:-]*(?:\[1m\])?$/ : /^[\w][\w./:-]*$/;
          if (
            value !== null &&
            (typeof value !== "string" ||
              !modelPattern.test(value) ||
              (engine === "copilot" && value.includes("/")))
          )
            throw new Error(`Invalid native model at ${path}.model`);
        } else if (field === "reasoning") {
          if (value !== null && !nativeEfforts[engine].includes(value))
            throw new Error(
              `Unsupported reasoning effort at ${path}.reasoning. Choose ${nativeEfforts[engine].join(", ")}.`,
            );
        } else {
          throw new Error(`Unknown roleProfiles field: ${path}.${field}`);
        }
      }
    }
  }
}

export function resolveRoleProfile(config, engine, role) {
  const selected = config.engine === engine;
  const override = selected ? config.roleProfiles?.[engine]?.[role] : undefined;
  const legacy = selected ? config.tdd?.profiles?.[legacyRoles[role]] : undefined;
  const orchestratorEffort = config.orchestrator?.reasoning ?? "medium";
  const defaultEffort =
    role === "review"
      ? "high"
      : role === "orchestrator" || engine !== "codex"
        ? orchestratorEffort
        : undefined;
  return {
    model: override?.model ?? legacy?.model,
    reasoning: override?.reasoning ?? legacy?.reasoning ?? defaultEffort,
  };
}

export function nativeRoleFields(engine, { model, reasoning }) {
  return {
    ...(model ? { model } : {}),
    ...(reasoning ? { [nativeEffortKeys[engine]]: reasoning } : {}),
  };
}

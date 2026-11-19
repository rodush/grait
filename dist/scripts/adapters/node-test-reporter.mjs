// scripts/adapters/test-observation.mjs
function scalar(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[non-finite value]";
  if (typeof value !== "string") return "[non-scalar value withheld]";
  if (
    /\b(?:function|class|import|require|assert|const|let|return)\b|=>|\bat\s+\S+\s*\(|[\\/][\w.-]+[\\/]|:\d+:\d+/i.test(
      value,
    )
  )
    return "[source or path-like value withheld]";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
}
function sanitizeObservation(value) {
  if (!value || typeof value !== "object") return void 0;
  return {
    operator:
      typeof value.operator === "string" && /^[\w=!<>-]{1,40}$/.test(value.operator)
        ? value.operator
        : "assertion",
    expected: scalar(value.expected),
    observed: scalar(value.observed),
  };
}

// scripts/adapters/node-test-reporter.mjs
import { isAbsolute, relative } from "node:path";
async function* reporter(source) {
  const passed = [],
    failed = [],
    infrastructureErrors = [];
  const parents = /* @__PURE__ */ new Map();
  for await (const event of source) {
    const data = event.data;
    if (!data?.file) continue;
    const normalized = data.file.replaceAll("\\", "/").replace(/^\/work\/project\//, "");
    const file = (
      isAbsolute(normalized) ? relative(process.cwd(), normalized) : normalized
    ).replaceAll("\\", "/");
    const stack = parents.get(file) || [];
    if (event.type === "test:start") {
      stack[data.nesting || 0] = data.name;
      stack.length = (data.nesting || 0) + 1;
      parents.set(file, stack);
    }
    const name = [...stack.slice(0, data.nesting || 0), data.name].join(" / ");
    const id = `${file}::${name}`;
    if (event.type === "test:pass" && data.details?.type !== "suite" && !data.skip && !data.todo)
      passed.push(id);
    if (event.type === "test:fail" && data.details?.type !== "suite") {
      const error = data.details?.error;
      if (error?.failureType === "subtestsFailed") continue;
      const cause = error?.cause || error;
      if (cause?.code === "ERR_ASSERTION")
        failed.push({
          id,
          kind: "assertion",
          ...(cause.publicObservation
            ? { observation: sanitizeObservation(cause.publicObservation) }
            : {}),
        });
      else
        infrastructureErrors.push(
          `${id}: ${cause?.code || error?.failureType || "test execution error"}`,
        );
    }
  }
  yield JSON.stringify({ passed, failed, infrastructureErrors });
}
export { reporter as default };

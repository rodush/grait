// Only bounded scalar behavioral observations cross the test black-box boundary.
// Raw assertion messages, stack traces, objects and fixture/source text do not.
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
export function sanitizeObservation(value) {
  if (!value || typeof value !== "object") return undefined;
  return {
    operator:
      typeof value.operator === "string" && /^[\w=!<>-]{1,40}$/.test(value.operator)
        ? value.operator
        : "assertion",
    expected: scalar(value.expected),
    observed: scalar(value.observed),
  };
}

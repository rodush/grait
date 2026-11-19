import { sanitizeObservation } from "./test-observation.mjs";
import { isAbsolute, relative } from "node:path";
// Emit stable repository-relative identities. A test name must be unique within
// its file/suite; line numbers deliberately do not enter handoff identities.
export default async function* reporter(source) {
  const passed = [],
    failed = [],
    infrastructureErrors = [];
  const parents = new Map();
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

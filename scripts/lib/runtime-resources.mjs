import { join } from "node:path";
import { fileURLToPath } from "node:url";

// esbuild binds this relative base separately for every compiled entrypoint.
// Source commands remain self-contained under scripts/ during development.
export const runtimeDirectory =
  typeof GRAIT_RUNTIME_BASE === "string"
    ? fileURLToPath(new URL(GRAIT_RUNTIME_BASE, import.meta.url))
    : fileURLToPath(new URL("../../", import.meta.url));

export function packageResource(path) {
  return join(runtimeDirectory, path);
}

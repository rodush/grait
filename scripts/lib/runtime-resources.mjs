import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const bundledRuntime = typeof GRAIT_BUNDLED === "boolean" && GRAIT_BUNDLED;
export const runtimeFile = fileURLToPath(import.meta.url);
export const runtimeDirectory = bundledRuntime
  ? fileURLToPath(new URL("./", import.meta.url))
  : fileURLToPath(new URL("../../", import.meta.url));

export function packageResource(path) {
  return join(runtimeDirectory, path);
}

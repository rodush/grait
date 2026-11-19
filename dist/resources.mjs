// scripts/lib/runtime-resources.mjs
import { join } from "node:path";
import { fileURLToPath } from "node:url";
var runtimeDirectory = true
  ? fileURLToPath(new URL("./", import.meta.url))
  : fileURLToPath(new URL("../../", import.meta.url));
function packageResource(path) {
  return join(runtimeDirectory, path);
}
export { packageResource, runtimeDirectory };

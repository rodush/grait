import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(directory);
// Source development and the committed package keep the same resource layout.
// Only the distribution directory is shipped to adopting repositories.
export const runtimeDirectory = directory === join(packageRoot, "src") ? packageRoot : directory;
export function packageResource(path) {
  return join(runtimeDirectory, path);
}

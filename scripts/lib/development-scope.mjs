import { sameLogin, validateConfig } from "./policy.mjs";

const sourceRepository = "rodush/grait";
const scopePath = "config/grait-development.json";

export async function repositoryDevelopmentConfig(config, api) {
  if (!sameLogin(config.controllerRepository, sourceRepository))
    return { config, development: false };

  // The Contents API uses the repository's default branch when no ref is supplied.
  let file;
  try {
    file = await api.request(`repos/${sourceRepository}/contents/${scopePath}`);
  } catch (error) {
    if (error?.status === 404) return { config, development: false };
    throw error;
  }

  if (file?.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string")
    throw new Error(`Cannot read ${scopePath} from the GRAIT default branch`);

  try {
    const content = file.content.replace(/\r?\n/g, "");
    const bytes = Buffer.from(content, "base64");
    if (bytes.toString("base64") !== content) throw new Error("Invalid base64 content");
    const { allowedWritePaths, protectedPaths } = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (
      !Array.isArray(allowedWritePaths) ||
      !allowedWritePaths.length ||
      !Array.isArray(protectedPaths) ||
      protectedPaths.some(
        (path) =>
          typeof path !== "string" ||
          !/^(?:[\w.-]+\/)*[\w.-]+\/?$/.test(path) ||
          path.includes(".."),
      )
    )
      throw new Error("Explicit write and protected path arrays are required");

    return {
      config: validateConfig({
        ...config,
        allowedWritePaths,
        protectedPaths,
        tdd: { ...config.tdd, implementationPaths: allowedWritePaths },
      }),
      development: true,
    };
  } catch (cause) {
    throw new Error(`Invalid GRAIT development scope in ${scopePath}`, { cause });
  }
}

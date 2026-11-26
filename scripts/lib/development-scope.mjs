import { sameLogin, validateConfig } from "./policy.mjs";
import { assertApplicationRunner } from "./verification.mjs";

const sourceRepository = "rodush/grait";
const configPath = "workflow.config.json";

export async function repositoryDevelopmentConfig(config, api) {
  if (!sameLogin(config.controllerRepository, sourceRepository))
    return { config, development: false };

  // The Contents API uses the repository's default branch when no ref is supplied.
  let file;
  try {
    file = await api.request(`repos/${sourceRepository}/contents/${configPath}`);
  } catch (error) {
    if (error?.status === 404)
      throw new Error(`Missing trusted ${configPath} on the GRAIT default branch`, {
        cause: error,
      });
    throw error;
  }

  if (file?.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string")
    throw new Error(`Cannot read ${configPath} from the GRAIT default branch`);

  try {
    const content = file.content.replace(/\r?\n/g, "");
    const bytes = Buffer.from(content, "base64");
    if (bytes.toString("base64") !== content) throw new Error("Invalid base64 content");
    const trusted = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!trusted || typeof trusted !== "object" || Array.isArray(trusted))
      throw new Error("Expected repository configuration");
    if (!sameLogin(trusted.controllerRepository, sourceRepository))
      throw new Error("Trusted configuration must identify the GRAIT source repository");
    const sourceConfig = validateConfig(
      Object.hasOwn(trusted, "sourceCi") ? { ...trusted, ci: trusted.sourceCi } : trusted,
    );
    assertApplicationRunner(sourceConfig.tdd?.runner);
    if (!Object.hasOwn(trusted, "developmentWriteScope"))
      return { config: sourceConfig, development: false };

    const { allowedWritePaths, protectedPaths } = trusted.developmentWriteScope ?? {};
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
        ...sourceConfig,
        allowedWritePaths,
        protectedPaths,
        tdd: { ...sourceConfig.tdd, implementationPaths: allowedWritePaths },
      }),
      development: true,
    };
  } catch (cause) {
    throw new Error(`Invalid trusted ${configPath} on the GRAIT default branch`, { cause });
  }
}

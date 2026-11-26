import { readFile } from "node:fs/promises";
import { repositoryDevelopmentConfig } from "./development-scope.mjs";
import { GitHub } from "./github.mjs";
import { Project } from "./project.mjs";
import { validateConfig } from "./policy.mjs";
import {
  assertPublishingBindings,
  humanToken,
  publishingVariableMap,
  verifyPublishingIdentity,
} from "./local-auth.mjs";
import { SetupState } from "./setup-state.mjs";

export async function localContext({ reviewer = false, setupReview = false } = {}) {
  const repositoryConfig = validateConfig(
    JSON.parse(await readFile("workflow.config.json", "utf8")),
  );
  const repo = repositoryConfig.controllerRepository;
  if (!repo) throw new Error("Run npm run setup first");
  const { directory, state } = await SetupState.read(repo);
  if (!state.enabled && !setupReview)
    throw new Error("This host is not activated. Follow docs/installation.md");
  const store = new SetupState(directory, state);
  await store.acquire();
  try {
    const humanApi = new GitHub(await humanToken());
    const { config, development } = await repositoryDevelopmentConfig(repositoryConfig, humanApi);
    if (setupReview) {
      const actor = await humanApi.request("user");
      if (
        !reviewer ||
        actor.type !== "User" ||
        !config.humanOperators.some((login) => login.toLowerCase() === actor.login.toLowerCase())
      )
        throw new Error(
          "Staged setup review requires a configured human operator and the reviewer publishing operation",
        );
    }
    const variables = publishingVariableMap(
      await humanApi.list(`repos/${repo}/actions/variables`, "variables"),
    );
    assertPublishingBindings(variables, state.apps);
    if (variables.get("AUTOMATION_ENABLED") !== "true" && !setupReview)
      throw new Error("Repository automation is paused");
    const project = await new Project(
      new GitHub(process.env.PROJECT_TOKEN || (await humanToken())),
      variables.get("PROJECT_ID"),
      config.statuses,
    ).load();
    const writer = await verifyPublishingIdentity(state.apps.writer, {
      repo,
      role: "writer",
    });
    const reviewerIdentity = reviewer
      ? await verifyPublishingIdentity(state.apps.reviewer, {
          repo,
          role: "reviewer",
        })
      : undefined;
    return {
      config,
      development,
      repo,
      api: new GitHub(writer.token),
      humanApi,
      project,
      writer: writer.login,
      reviewer: reviewerIdentity?.login,
      writerId: writer.botUserId,
      reviewerId: state.apps.reviewer.botUserId,
      reviewerApi: reviewerIdentity ? new GitHub(reviewerIdentity.token) : undefined,
      store,
    };
  } catch (error) {
    await store.release();
    throw error;
  }
}

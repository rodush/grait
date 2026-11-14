import { readFile } from "node:fs/promises";
import { GitHub } from "./github.mjs";
import { Project } from "./project.mjs";
import { sameLogin, validateConfig } from "./policy.mjs";
import { humanToken, roleToken } from "./local-auth.mjs";
import { SetupState } from "./setup-state.mjs";

export async function localContext({ reviewer = false, setupReview = false } = {}) {
  const config = validateConfig(JSON.parse(await readFile("workflow.config.json", "utf8")));
  const repo = config.controllerRepository;
  if (!repo) throw new Error("Run npm run setup first");
  const { directory, state } = await SetupState.read(repo);
  if (!state.enabled && !setupReview)
    throw new Error("This host is not activated. Follow docs/installation.md");
  const store = new SetupState(directory, state);
  await store.acquire();
  try {
    const humanApi = new GitHub(await humanToken());
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
    const variables = new Map(
      (await humanApi.list(`repos/${repo}/actions/variables`, "variables")).map((item) => [
        item.name,
        item.value,
      ]),
    );
    if (
      ![
        ["writer", "AUTOMATION_LOGIN"],
        ["reviewer", "REVIEW_LOGIN"],
      ].every(
        ([role, name]) =>
          state.apps[role]?.slug && sameLogin(`${state.apps[role].slug}[bot]`, variables.get(name)),
      )
    )
      throw new Error(
        "Host publishing identities differ from the repository's recorded Apps; reconcile before starting work",
      );
    if (variables.get("AUTOMATION_ENABLED") !== "true" && !setupReview)
      throw new Error("Repository automation is paused");
    const project = await new Project(
      new GitHub(process.env.PROJECT_TOKEN || (await humanToken())),
      variables.get("PROJECT_ID"),
      config.statuses,
    ).load();
    const api = new GitHub(await roleToken(repo, "writer"));
    return {
      config,
      repo,
      api,
      humanApi,
      project,
      writer: variables.get("AUTOMATION_LOGIN"),
      reviewer: variables.get("REVIEW_LOGIN"),
      reviewerApi: reviewer ? new GitHub(await roleToken(repo, "reviewer")) : undefined,
      store,
    };
  } catch (error) {
    await store.release();
    throw error;
  }
}

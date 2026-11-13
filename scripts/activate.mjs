import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitHub } from "./lib/github.mjs";
import { SetupState } from "./lib/setup-state.mjs";
import { roleToken } from "./lib/local-auth.mjs";
import { Project } from "./lib/project.mjs";
import { digest, sameLogin, validateConfig } from "./lib/policy.mjs";
import { repositoryRules, resolveActionsAppId } from "./lib/bootstrap.mjs";

let store;
try {
  const localText = await readFile("workflow.config.json", "utf8");
  const config = validateConfig(JSON.parse(localText));
  if (!config.controllerRepository || !config.humanOperators.length)
    throw new Error("Run bootstrap and configure human operators first");
  const { directory, state } = await SetupState.read(config.controllerRepository);
  store = new SetupState(directory, state);
  await store.acquire();
  const token =
    process.env.GH_TOKEN ||
    (await promisify(execFile)("gh", ["auth", "token"], { encoding: "utf8" })).stdout.trim();
  const api = new GitHub(token);
  const actionsAppId = await resolveActionsAppId(api);
  const repo = config.controllerRepository;
  const repository = await api.request(`repos/${repo}`);
  const operator = await api.request("user");
  if (
    operator.type !== "User" ||
    !config.humanOperators.some((login) => sameLogin(login, operator.login)) ||
    !repository.permissions?.admin
  )
    throw new Error("Activation requires a configured human repository administrator");
  const head = await api.request(
    `repos/${repo}/commits/${encodeURIComponent(repository.default_branch)}`,
  );
  const ci = await api.list(
    `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${head.sha}&event=push`,
    "workflow_runs",
  );
  if (!ci.some((run) => run.head_sha === head.sha && run.conclusion === "success"))
    throw new Error(
      "Successful CI on the current default-branch head is required before activation",
    );
  const remote = await api.request(
    `repos/${repo}/contents/workflow.config.json?ref=${encodeURIComponent(repository.default_branch)}`,
  );
  if (digest(Buffer.from(remote.content, "base64")) !== digest(localText))
    throw new Error("Commit the configured files to the default branch before activation");
  const variables = new Map(
    (await api.list(`repos/${repo}/actions/variables`, "variables")).map((item) => [
      item.name,
      item.value,
    ]),
  );
  for (const name of ["PROJECT_ID", "AUTOMATION_LOGIN", "REVIEW_LOGIN"])
    if (!variables.get(name)) throw new Error(`Missing repository variable ${name}`);
  if (
    ![
      ["writer", "AUTOMATION_LOGIN"],
      ["reviewer", "REVIEW_LOGIN"],
    ].every(
      ([role, name]) =>
        state.apps[role]?.slug && sameLogin(`${state.apps[role].slug}[bot]`, variables.get(name)),
    )
  )
    throw new Error("Host publishing identities differ from the repository's recorded Apps");
  if (
    sameLogin(variables.get("AUTOMATION_LOGIN"), variables.get("REVIEW_LOGIN")) ||
    config.humanOperators.some(
      (login) =>
        sameLogin(login, variables.get("AUTOMATION_LOGIN")) ||
        sameLogin(login, variables.get("REVIEW_LOGIN")),
    )
  )
    throw new Error("Human, implementation, and review identities must be separate");
  // Credentials stay on the user host. Mint each scoped App token to verify both installations.
  await roleToken(repo, "writer");
  await roleToken(repo, "reviewer");
  const projectToken = process.env.PROJECT_TOKEN || token;
  const project = await new Project(
    new GitHub(projectToken),
    variables.get("PROJECT_ID"),
    config.statuses,
  ).load();
  if (!sameLogin(project.controller, repo))
    throw new Error("Project is bound to a different orchestrator");
  const owners = await api.request(
    `repos/${repo}/contents/.github/CODEOWNERS?ref=${encodeURIComponent(repository.default_branch)}`,
  );
  const ownerText = Buffer.from(owners.content, "base64").toString();
  if (
    !config.humanOperators.every((login) =>
      ownerText
        .split("\n")
        .some((line) => !line.startsWith("#") && line.split(/\s+/).includes(`@${login}`)),
    )
  )
    throw new Error("Committed CODEOWNERS must include the human operators");
  const actors = [];
  for (const login of config.humanOperators) {
    const user = await api.request(`users/${encodeURIComponent(login)}`);
    if (user.type !== "User") throw new Error("A configured operator is a bot account");
    actors.push(user);
  }
  const writer = variables.get("AUTOMATION_LOGIN");
  const appId = writer.endsWith("[bot]")
    ? (await api.request(`apps/${writer.replace(/\[bot\]$/, "")}`)).id
    : null;
  const rules = await api.list(`repos/${repo}/rulesets`);
  for (const expected of repositoryRules(
    actors,
    appId,
    variables.get("RELEASE_APP_ID"),
    actionsAppId,
  )) {
    const rule = rules.find((item) => item.name === expected.name && sameLogin(item.source, repo));
    if (!rule) throw new Error(`Missing staged ruleset ${expected.name}`);
    await api.request(`repos/${repo}/rulesets/${rule.id}`, { method: "PUT", body: expected });
  }
  await api.request(`repos/${repo}/actions/variables/AUTOMATION_ENABLED`, {
    method: "PATCH",
    body: { name: "AUTOMATION_ENABLED", value: "true" },
  });
  store.state.enabled = true;
  await store.save();
  console.log(
    "Delivery rules are active. Start the subscription-backed local orchestrator with npm run orchestrator -- start.",
  );
} catch (error) {
  console.error(error.message);
  console.error(
    "Activation did not complete. Inspect rulesets and AUTOMATION_ENABLED before retrying.",
  );
  process.exitCode = 1;
} finally {
  await store?.release();
}

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitHub } from "./lib/github.mjs";
import { Ledger } from "./lib/ledger.mjs";
import { Project } from "./lib/project.mjs";
import { digest, sameLogin, validateConfig } from "./lib/policy.mjs";
import { repositoryRules, resolveActionsAppId } from "./lib/bootstrap.mjs";

try {
  const localText = await readFile("workflow.config.json", "utf8");
  const config = validateConfig(JSON.parse(localText));
  if (!config.controllerRepository || !config.humanOperators.length)
    throw new Error("Run bootstrap and configure human operators first");
  const token =
    process.env.GH_TOKEN ||
    (await promisify(execFile)("gh", ["auth", "token"], { encoding: "utf8" })).stdout.trim();
  const api = new GitHub(token);
  const actionsAppId = await resolveActionsAppId(api);
  const repo = config.controllerRepository;
  const repository = await api.request(`repos/${repo}`);
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
  for (const name of [
    "PROJECT_ID",
    "AUTOMATION_LOGIN",
    "REVIEW_LOGIN",
    "AGENT_MODEL",
    "AUTOMATION_BUDGET_ISSUE",
    "AUTOMATION_BUDGET_LOGIN",
  ])
    if (!variables.get(name)) throw new Error(`Missing repository variable ${name}`);
  if (
    sameLogin(variables.get("AUTOMATION_LOGIN"), variables.get("REVIEW_LOGIN")) ||
    config.humanOperators.some(
      (login) =>
        sameLogin(login, variables.get("AUTOMATION_LOGIN")) ||
        sameLogin(login, variables.get("REVIEW_LOGIN")),
    )
  )
    throw new Error("Human, implementation, and review identities must be separate");
  const secrets = new Set(
    (await api.list(`repos/${repo}/actions/secrets`, "secrets")).map((item) => item.name),
  );
  const required =
    config.authentication === "app"
      ? ["AUTOMATION_APP_PRIVATE_KEY", "REVIEW_APP_PRIVATE_KEY"]
      : ["AUTOMATION_TOKEN", "REVIEW_TOKEN"];
  if (config.authentication === "app")
    for (const name of ["AUTOMATION_APP_CLIENT_ID", "REVIEW_APP_CLIENT_ID"])
      if (!variables.get(name)) throw new Error(`Missing repository variable ${name}`);
  if (config.engine === "codex" && !secrets.has("OPENAI_API_KEY")) required.push("CODEX_API_KEY");
  if (config.engine === "claude") required.push("ANTHROPIC_API_KEY");
  if (config.engine === "copilot") required.push("COPILOT_GITHUB_TOKEN");
  for (const name of required)
    if (!secrets.has(name)) throw new Error(`Missing repository secret ${name}`);
  const projectToken = process.env.PROJECT_TOKEN || token;
  const project = await new Project(
    new GitHub(projectToken),
    variables.get("PROJECT_ID"),
    config.statuses,
  ).load();
  if (!sameLogin(project.controller, repo))
    throw new Error("Project is bound to a different controller");
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
  const budgetNumber = Number(variables.get("AUTOMATION_BUDGET_ISSUE"));
  if (!Number.isSafeInteger(budgetNumber) || budgetNumber < 1)
    throw new Error("Invalid budget issue");
  if (
    !config.humanOperators.some((login) =>
      sameLogin(login, variables.get("AUTOMATION_BUDGET_LOGIN")),
    )
  )
    throw new Error("Budget ledger must originate from a configured bootstrap operator");
  const budget = await new Ledger(api, repo, variables.get("AUTOMATION_BUDGET_LOGIN")).load(
    budgetNumber,
  );
  if (!budget.comment || !Array.isArray(budget.state.reservations))
    throw new Error("Missing initialized budget ledger");
  const releaseSecrets = new Set(
    (await api.list(`repos/${repo}/environments/release/secrets`, "secrets")).map(
      (item) => item.name,
    ),
  );
  if (config.authentication === "app") {
    if (
      !variables.get("RELEASE_APP_ID") ||
      !variables.get("RELEASE_APP_CLIENT_ID") ||
      !releaseSecrets.has("RELEASE_APP_PRIVATE_KEY")
    )
      throw new Error("Configure the dedicated release App and its release-environment secret");
    const writerApp = await api.request(`apps/${writer.replace(/\[bot\]$/, "")}`);
    const reviewerLogin = variables.get("REVIEW_LOGIN");
    const reviewerApp = await api.request(`apps/${reviewerLogin.replace(/\[bot\]$/, "")}`);
    if ([writerApp.id, reviewerApp.id].includes(Number(variables.get("RELEASE_APP_ID"))))
      throw new Error("Release App must be separate from implementation and review Apps");
  } else if (!releaseSecrets.has("RELEASE_TOKEN"))
    throw new Error("Configure RELEASE_TOKEN in the release environment");
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
  console.log(
    "Delivery rules and human merge authority are active. Project automation is enabled.",
  );
} catch (error) {
  console.error(error.message);
  console.error(
    "Activation did not complete. Inspect rulesets and AUTOMATION_ENABLED before retrying.",
  );
  process.exitCode = 1;
}

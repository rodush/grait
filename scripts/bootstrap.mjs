import { parseArgs, promisify } from "node:util";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { Ledger } from "./lib/ledger.mjs";
import { GitHub } from "./lib/github.mjs";
import { repositoryRules, repositorySettings, resolveActionsAppId } from "./lib/bootstrap.mjs";
import { sameLogin } from "./lib/policy.mjs";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    "project-owner": { type: "string" },
    "project-number": { type: "string" },
    maintainers: { type: "string" },
    "writer-login": { type: "string" },
    "reviewer-login": { type: "string" },
    "release-app-id": { type: "string" },
    "status-app-id": { type: "string" },
    model: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});
const config = JSON.parse(await readFile("workflow.config.json", "utf8"));
const codex = parseToml(await readFile("config/codex.toml", "utf8"));
const repo = values.repo || config.controllerRepository;
const projectOwner = values["project-owner"] || repo?.split("/")[0];
const maintainers = (values.maintainers || "")
  .split(",")
  .map((name) => name.trim().replace(/^@/, ""))
  .filter(Boolean);
const model = values.model || (config.engine === "codex" ? codex.model : null);
const plan = {
  repository: repo || "UNCONFIGURED",
  projectOwner: projectOwner || "UNCONFIGURED",
  project: values["project-number"]
    ? `Bind project ${values["project-number"]}`
    : "Create a project with a default Kanban view",
  statuses: config.statuses,
  maxInProgress: config.maxInProgress,
  maxReviewRounds: config.maxReviewRounds,
  engine: config.engine,
  model: model || "UNCONFIGURED",
  authentication: config.authentication,
  maintainers,
  writer: values["writer-login"] || "UNCONFIGURED",
  reviewer: values["reviewer-login"] || "UNCONFIGURED",
  repositorySettings,
  rulesets: [
    "Required delivery gates (staged disabled until activation)",
    "Human merge authority (staged disabled until activation)",
    "Release tag creation and immutability (active immediately)",
  ],
  releaseEnvironment:
    "Selected human maintainers approve releases; the requesting human may approve",
  automationEnabled: false,
};

if (!values.apply) {
  console.log(JSON.stringify(plan, null, 2));
  console.log(
    "Plan only. Supply all identities and use --apply to configure a derived repository.",
  );
} else {
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "") || !/^[\w-]+$/.test(projectOwner || ""))
      throw new Error("Provide --repo owner/repo and a valid --project-owner");
    if (!maintainers.length || !model || !values["writer-login"] || !values["reviewer-login"])
      throw new Error("Maintainers, model, writer login, and reviewer login are required");
    if (
      sameLogin(values["writer-login"], values["reviewer-login"]) ||
      maintainers.some(
        (name) =>
          sameLogin(name, values["writer-login"]) || sameLogin(name, values["reviewer-login"]),
      )
    )
      throw new Error(
        "Human operators, implementation identity, and reviewer identity must be separate",
      );
    if (values["project-number"] && !/^[1-9]\d*$/.test(values["project-number"]))
      throw new Error("Invalid project number");
    const token =
      process.env.GH_TOKEN ||
      (await promisify(execFile)("gh", ["auth", "token"], { encoding: "utf8" })).stdout.trim();
    if (config.authentication === "app" && !/^[1-9]\d*$/.test(values["release-app-id"] || ""))
      throw new Error(
        "App mode requires a dedicated --release-app-id (numeric App ID, not client ID)",
      );
    const api = new GitHub(token);
    const actionsAppId = await resolveActionsAppId(api);
    const projectApi = new GitHub(process.env.PROJECT_TOKEN || token);
    const actors = [];
    for (const login of maintainers) {
      const user = await api.request(`users/${encodeURIComponent(login)}`);
      if (user.type !== "User") throw new Error(`Maintainer ${login} is not a human user account`);
      actors.push(user);
    }
    const repository = await api.request(`repos/${repo}`);
    const currentVariables = await api.list(`repos/${repo}/actions/variables`, "variables");
    if (
      currentVariables.some((item) => item.name === "AUTOMATION_ENABLED" && item.value === "true")
    )
      throw new Error("Disable automation before reconfiguring a live repository");
    if (!currentVariables.some((item) => item.name === "AUTOMATION_ENABLED")) {
      await api.request(`repos/${repo}/actions/variables`, {
        method: "POST",
        body: { name: "AUTOMATION_ENABLED", value: "false" },
      });
      currentVariables.push({ name: "AUTOMATION_ENABLED", value: "false" });
    }
    const owner = await api.request(`users/${projectOwner}`);
    let project;
    if (values["project-number"]) {
      const result = await projectApi.graphql(
        `query($owner: String!, $number: Int!) {
        repositoryOwner(login: $owner) {
          ... on User { projectV2(number: $number) { id number url shortDescription } }
          ... on Organization { projectV2(number: $number) { id number url shortDescription } }
        }
      }`,
        { owner: projectOwner, number: Number(values["project-number"]) },
      );
      project = result.repositoryOwner?.projectV2;
      if (!project) throw new Error("Existing project is inaccessible");
    } else {
      const result = await projectApi.graphql(
        `mutation($owner: ID!, $title: String!) {
        createProjectV2(input: { ownerId: $owner, title: $title }) { projectV2 { id number url shortDescription } }
      }`,
        { owner: owner.node_id, title: `${repository.name} development` },
      );
      project = result.createProjectV2.projectV2;
      console.log(
        `Created ${project.url}; if setup fails, rerun with --project-number ${project.number}`,
      );
    }
    const binding = `[agent-controller:${repo}]`;
    const previousBinding = project.shortDescription?.match(/\[agent-controller:([^\]]+)\]/)?.[1];
    if (previousBinding && !sameLogin(previousBinding, repo))
      throw new Error("Project is already bound to another controller repository");
    const description = previousBinding
      ? project.shortDescription
      : [project.shortDescription, binding].filter(Boolean).join(" ");
    if (description.length > 256)
      throw new Error("Shorten the project description to make room for its controller binding");
    const details = await projectApi.graphql(
      `query($id: ID!) {
      node(id: $id) { ... on ProjectV2 {
        fields(first: 100) { nodes { ... on ProjectV2SingleSelectField { id name options { name } } } }
        views(first: 100) { nodes { id name layout } }
      } }
    }`,
      { id: project.id },
    );
    const status = details.node.fields.nodes.find((field) => field.name === "Status");
    if (!status) throw new Error("Project has no Status field");
    const names = Object.values(config.statuses);
    if (
      values["project-number"] &&
      names.some((name) => !status.options.some((option) => option.name === name))
    )
      throw new Error(
        "Configure all five Status options on the existing project before binding it",
      );
    if (!values["project-number"]) {
      const colors = ["GRAY", "BLUE", "YELLOW", "PURPLE", "GREEN"];
      await projectApi.graphql(
        `mutation($field: ID!, $options: [ProjectV2SingleSelectFieldOptionInput!]!) {
        updateProjectV2Field(input: { fieldId: $field, singleSelectOptions: $options }) { projectV2Field { ... on ProjectV2SingleSelectField { id } } }
      }`,
        {
          field: status.id,
          options: names.map((name, index) => ({ name, color: colors[index], description: name })),
        },
      );
      const firstView = details.node.views.nodes[0];
      if (firstView)
        await projectApi.graphql(
          `mutation($id: ID!) { updateProjectV2View(input: { viewId: $id, name: "Kanban", layout: BOARD_LAYOUT }) { projectV2View { id } } }`,
          { id: firstView.id },
        );
      else
        await projectApi.graphql(
          `mutation($id: ID!) { createProjectV2View(input: { projectId: $id, name: "Kanban", layout: BOARD_LAYOUT }) { projectV2View { id } } }`,
          { id: project.id },
        );
    }
    await projectApi.graphql(
      `mutation($id: ID!, $description: String!) { updateProjectV2(input: { projectId: $id, shortDescription: $description }) { projectV2 { id } } }`,
      { id: project.id, description },
    );
    await projectApi.graphql(
      `mutation($project: ID!, $repository: ID!) { linkProjectV2ToRepository(input: { projectId: $project, repositoryId: $repository }) { repository { id } } }`,
      { project: project.id, repository: repository.node_id },
    );
    await api.request(`repos/${repo}`, { method: "PATCH", body: repositorySettings });
    const existingRules = await api.list(`repos/${repo}/rulesets`);
    const statusAppId =
      values["status-app-id"] ||
      (values["writer-login"].endsWith("[bot]")
        ? (await api.request(`apps/${values["writer-login"].replace(/\[bot\]$/, "")}`)).id
        : null);
    if (config.authentication === "app") {
      const reviewerApp = await api.request(
        `apps/${values["reviewer-login"].replace(/\[bot\]$/, "")}`,
      );
      if ([Number(statusAppId), reviewerApp.id].includes(Number(values["release-app-id"])))
        throw new Error("Release App must be separate from implementation and review Apps");
    }
    for (const rule of repositoryRules(
      actors,
      statusAppId,
      values["release-app-id"],
      actionsAppId,
    )) {
      const existing = existingRules.find(
        (item) => item.name === rule.name && sameLogin(item.source, repo),
      );
      rule.enforcement = rule.target === "tag" ? "active" : existing?.enforcement || "disabled";
      await api.request(
        existing ? `repos/${repo}/rulesets/${existing.id}` : `repos/${repo}/rulesets`,
        { method: existing ? "PUT" : "POST", body: rule },
      );
    }
    for (const [name, color] of [
      [config.labels.automated, "0E8A16"],
      [config.labels.admitted, "1D76DB"],
      [config.labels.paused, "FBCA04"],
      [config.labels.needsHuman, "B60205"],
    ]) {
      const labels = await api.list(`repos/${repo}/labels`);
      if (!labels.some((label) => label.name === name))
        await api.request(`repos/${repo}/labels`, { method: "POST", body: { name, color } });
    }
    await api.request(`repos/${repo}/environments/release`, {
      method: "PUT",
      body: {
        prevent_self_review: false,
        reviewers: actors.map((actor) => ({ type: "User", id: actor.id })),
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      },
    });
    let budgetNumber = currentVariables.find(
      (item) => item.name === "AUTOMATION_BUDGET_ISSUE",
    )?.value;
    let budgetLogin = currentVariables.find(
      (item) => item.name === "AUTOMATION_BUDGET_LOGIN",
    )?.value;
    if (!budgetNumber) {
      const operator = await api.request("user");
      if (!actors.some((actor) => sameLogin(actor.login, operator.login)))
        throw new Error(
          "Bootstrap must authenticate as a configured human operator to initialize the budget",
        );
      const issue = await api.request(`repos/${repo}/issues`, {
        method: "POST",
        body: {
          title: "Automation budget ledger — do not delete",
          body: "Internal rolling credit reservations. Do not edit or delete the ledger comment; it is not a development story.",
        },
      });
      budgetNumber = String(issue.number);
      budgetLogin = operator.login;
      const ledger = new Ledger(api, repo, budgetLogin);
      const { state } = await ledger.load(issue.number);
      state.reservations = [];
      await ledger.save(issue.number);
    }
    const variables = {
      AUTOMATION_BUDGET_ISSUE: budgetNumber,
      AUTOMATION_BUDGET_LOGIN: budgetLogin,
      ...(values["release-app-id"] ? { RELEASE_APP_ID: values["release-app-id"] } : {}),
      PROJECT_ID: project.id,
      AUTOMATION_LOGIN: values["writer-login"],
      REVIEW_LOGIN: values["reviewer-login"],
      AGENT_MODEL: model,
      AUTOMATION_ENABLED: "false",
    };
    for (const [name, value] of Object.entries(variables))
      await api.request(
        currentVariables.some((item) => item.name === name)
          ? `repos/${repo}/actions/variables/${name}`
          : `repos/${repo}/actions/variables`,
        {
          method: currentVariables.some((item) => item.name === name) ? "PATCH" : "POST",
          body: { name, value },
        },
      );
    config.controllerRepository = repo;
    config.humanOperators = actors.map((actor) => actor.login);
    await writeFile("workflow.config.json", `${JSON.stringify(config, null, 2)}\n`);
    await writeFile(
      ".github/CODEOWNERS",
      `# Human ownership is required for every change.\n* ${actors.map((actor) => `@${actor.login}`).join(" ")}\n`,
    );
    console.log(
      `Configured ${project.url}. Automation remains disabled. Commit the local configuration, install credentials, and follow docs/setup.md before enabling.`,
    );
  } catch (error) {
    console.error(error.message);
    console.error(
      "Setup can be partially applied. Inspect the repository and project before rerunning; automation has not been enabled.",
    );
    process.exitCode = 1;
  }
}

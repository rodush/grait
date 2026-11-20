import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { GitHub } from "./lib/github.mjs";
import { SetupState } from "./lib/setup-state.mjs";
import { roleToken } from "./lib/local-auth.mjs";
import { Project } from "./lib/project.mjs";
import { digest, sameLogin, validateConfig } from "./lib/policy.mjs";
import { repositoryRules, resolveActionsAppId } from "./lib/bootstrap.mjs";
import { configureRepositoryRules } from "./lib/ruleset-setup.mjs";
import { isEntrypoint } from "./lib/entrypoint.mjs";
import { bundledRuntime } from "./lib/runtime-resources.mjs";

export async function activateMain(
  args = process.argv.slice(2),
  { readInstalled, verifyMerge, workflow = "ci.yml" } = {},
) {
  let store;
  try {
    const { values } = parseArgs({
      args,
      options: { "acknowledge-unenforced-rules": { type: "boolean" } },
    });
    const packaged = Boolean(readInstalled);
    const installed = packaged ? await readInstalled(process.cwd()) : null;
    const configPath = "workflow.config.json";
    const localText = installed
      ? installed.artifacts[configPath]
      : await readFile(configPath, "utf8");
    const config = installed?.config || validateConfig(JSON.parse(localText));
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
      `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${head.sha}&event=push`,
      "workflow_runs",
    );
    if (!ci.some((run) => run.head_sha === head.sha && run.conclusion === "success"))
      throw new Error(
        "Successful CI on the current default-branch head is required before activation",
      );
    const ref = packaged ? head.sha : repository.default_branch;
    const committedFiles = installed?.artifacts || { [configPath]: localText };
    async function verifyCommittedFiles(at) {
      for (const [path, text] of Object.entries(committedFiles)) {
        const remote = await api
          .request(
            `repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(at)}`,
          )
          .catch((error) => {
            if (error.status !== 404 || !packaged) throw error;
            return null;
          });
        if (remote && digest(Buffer.from(remote.content, "base64")) === digest(text)) continue;
        if (packaged)
          throw new Error(
            `Human merge of the current installed artifact is required before activation: ${path} does not match at ${at}`,
          );
        throw new Error("Commit the configured files to the default branch before activation");
      }
    }
    await verifyCommittedFiles(ref);
    if (packaged) {
      const mergeSha = await verifyMerge({
        api,
        repo,
        defaultBranch: repository.default_branch,
        head,
      });
      if (mergeSha !== head.sha) await verifyCommittedFiles(mergeSha);
    }
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
    let ownerText = installed?.artifacts[".github/CODEOWNERS"];
    if (!installed) {
      const owners = await api.request(
        `repos/${repo}/contents/.github/CODEOWNERS?ref=${encodeURIComponent(ref)}`,
      );
      ownerText = Buffer.from(owners.content, "base64").toString();
    }
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
    async function recordEnforcement(value) {
      await api.request(
        variables.has("RULESET_ENFORCEMENT")
          ? `repos/${repo}/actions/variables/RULESET_ENFORCEMENT`
          : `repos/${repo}/actions/variables`,
        {
          method: variables.has("RULESET_ENFORCEMENT") ? "PATCH" : "POST",
          body: { name: "RULESET_ENFORCEMENT", value },
        },
      );
      variables.set("RULESET_ENFORCEMENT", value);
      store.state.rulesetEnforcement = value;
      await store.save();
    }
    await recordEnforcement("pending");
    const { enforcement } = await configureRepositoryRules({
      api,
      repo,
      rules: repositoryRules(
        actors,
        state.apps.writer.id,
        variables.get("RELEASE_APP_ID"),
        actionsAppId,
      ),
      phase: "activate",
      acknowledgeUnenforced: Boolean(values["acknowledge-unenforced-rules"]),
    });
    await recordEnforcement(enforcement);
    await api.request(`repos/${repo}/actions/variables/AUTOMATION_ENABLED`, {
      method: "PATCH",
      body: { name: "AUTOMATION_ENABLED", value: "true" },
    });
    store.state.enabled = true;
    await store.save();
    const start = packaged ? "grait orchestrator start" : "npm run orchestrator -- start";
    console.log(
      enforcement === "active"
        ? `Delivery rules are active. Start the subscription-backed local orchestrator with ${start}.`
        : `Host activated with unenforced rules. Human approval and human merge remain required. Start the local orchestrator with ${start}.`,
    );
  } catch (error) {
    console.error(error.message);
    console.error(
      "Activation did not complete. Inspect rulesets and AUTOMATION_ENABLED before retrying.",
    );
    process.exitCode = error.code === "RULESET_SETUP_PENDING" ? 2 : 1;
  } finally {
    await store?.release();
  }
}

if (!bundledRuntime && isEntrypoint(import.meta.url)) await activateMain();

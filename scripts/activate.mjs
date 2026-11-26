import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { resolve } from "node:path";
import { GitHub } from "./lib/github.mjs";
import { SetupState } from "./lib/setup-state.mjs";
import {
  assertPublishingBindings,
  publishingRoles,
  publishingVariableMap,
  verifyPublishingIdentity,
} from "./lib/local-auth.mjs";
import { Project } from "./lib/project.mjs";
import { digest, sameLogin, validateConfig } from "./lib/policy.mjs";
import { configureRepositoryRules } from "./lib/ruleset-setup.mjs";
import { isEntrypoint } from "./lib/entrypoint.mjs";
import { bundledRuntime } from "./lib/runtime-resources.mjs";
import {
  askSetupRules,
  interruptionError,
  repositoryRules,
  resolveActionsAppId,
  rulesetSetupLog,
  setupError,
  setupWarning,
  verifyActiveRepositoryRules,
} from "./lib/bootstrap.mjs";

export async function activateMain(
  args = process.argv.slice(2),
  { readInstalled, verifyMerge, workflow = "ci.yml", cwd = process.cwd() } = {},
) {
  const packaged = Boolean(readInstalled);
  const controller = new AbortController();
  const interrupt = () => controller.abort(interruptionError());
  const checkInterrupted = () => controller.signal.throwIfAborted();
  let store;
  let step = "reading the installed configuration";
  let status = 0;
  process.on("SIGINT", interrupt);
  try {
    const { values } = parseArgs({
      args,
      options: { "acknowledge-unenforced-rules": { type: "boolean" } },
    });
    const installed = packaged ? await readInstalled(cwd) : null;
    const configPath = "workflow.config.json";
    const localText = installed
      ? installed.artifacts[configPath]
      : await readFile(resolve(cwd, configPath), "utf8");
    const config = installed?.config || validateConfig(JSON.parse(localText));
    if (!config.controllerRepository || !config.humanOperators.length)
      throw new Error("Run bootstrap and configure human operators first");
    step = "acquiring the local setup lock";
    const { directory, state } = await SetupState.read(config.controllerRepository, cwd);
    store = new SetupState(directory, state);
    await store.acquire({
      recoverStale: true,
      onStale: (pid) =>
        setupWarning("Recovered a stale setup lock from stopped process " + pid + "."),
    });
    checkInterrupted();
    step = "verifying GitHub administrator access";
    const token =
      process.env.GH_TOKEN ||
      (await promisify(execFile)("gh", ["auth", "token"], { encoding: "utf8" })).stdout.trim();
    const api = new GitHub(token);
    const repo = config.controllerRepository;
    const repository = await api.request(`repos/${repo}`);
    const operator = await api.request("user");
    if (
      operator.type !== "User" ||
      !config.humanOperators.some((login) => sameLogin(login, operator.login)) ||
      !repository.permissions?.admin
    )
      throw new Error("Activation requires a configured human repository administrator");
    step = "verifying the configuration PR and default-branch artifacts";
    const head = await api.request(
      `repos/${repo}/commits/${encodeURIComponent(repository.default_branch)}`,
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
    if (packaged) {
      const mergeSha = await verifyMerge({
        api,
        repo,
        defaultBranch: repository.default_branch,
        head,
      });
      await verifyCommittedFiles(ref);
      if (mergeSha !== head.sha) await verifyCommittedFiles(mergeSha);
    } else {
      await verifyCommittedFiles(ref);
    }
    step = "checking default-branch validation";
    const ci = await api.list(
      "repos/" +
        repo +
        "/actions/workflows/" +
        workflow +
        "/runs?head_sha=" +
        head.sha +
        "&event=push",
      "workflow_runs",
    );
    if (!ci.some((run) => run.head_sha === head.sha && run.conclusion === "success"))
      throw new Error(
        "Successful CI on the current default-branch head is required before activation. Wait for GRAIT validation at " +
          head.sha +
          " on " +
          repository.default_branch +
          ", then retry " +
          (packaged ? "grait activate." : "npm run activate."),
      );
    checkInterrupted();
    step = "verifying the publishing Apps and Project binding";
    const variables = publishingVariableMap(
      await api.list(`repos/${repo}/actions/variables`, "variables"),
    );
    if (!variables.get("PROJECT_ID"))
      throw new Error(
        "Missing repository variable PROJECT_ID for " +
          repo +
          ". Reconcile the existing Project binding before retrying.",
      );
    assertPublishingBindings(variables, state.apps);
    for (const role of Object.keys(publishingRoles))
      await verifyPublishingIdentity(state.apps[role], { repo, role });
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
    const actionsAppId = await resolveActionsAppId(api);
    const rules = repositoryRules(
      actors,
      state.apps.writer.id,
      variables.get("RELEASE_APP_ID"),
      actionsAppId,
    );
    const fingerprint = digest(
      JSON.stringify({
        repo,
        branch: repository.default_branch,
        artifacts: committedFiles,
        project: variables.get("PROJECT_ID"),
        publishing: Object.values(publishingRoles).map(({ app, bot }) => [
          variables.get(app),
          variables.get(bot),
        ]),
        operator: operator.login.toLowerCase(),
        rules,
      }),
    );
    const checkpoint = state.activation?.fingerprint === fingerprint ? state.activation : null;
    const remoteEnforcement = variables.get("RULESET_ENFORCEMENT");
    let remotelyEnabled = variables.get("AUTOMATION_ENABLED") === "true";
    const matchedCheckpoint = checkpoint && remoteEnforcement === checkpoint.enforcement;
    step = "verifying the active repository rulesets";
    const drifted = Boolean(
      (checkpoint?.enforcement === "active" ||
        (remotelyEnabled && remoteEnforcement === "active")) &&
      !(await verifyActiveRepositoryRules(api, repo, rules)),
    );
    const resumed = Boolean(matchedCheckpoint && remotelyEnabled && !drifted);
    if (drifted && remotelyEnabled) {
      step = "pausing automation after ruleset drift";
      checkInterrupted();
      await api.request("repos/" + repo + "/actions/variables/AUTOMATION_ENABLED", {
        method: "PATCH",
        body: { name: "AUTOMATION_ENABLED", value: "false" },
      });
      remotelyEnabled = false;
      setupWarning(
        "The required repository rulesets changed or could not be verified. Automation is paused while you reconcile the rules.",
      );
    }
    async function recordEnforcement(value) {
      if (variables.get("RULESET_ENFORCEMENT") === value) return;
      checkInterrupted();
      await api.request(
        variables.has("RULESET_ENFORCEMENT")
          ? "repos/" + repo + "/actions/variables/RULESET_ENFORCEMENT"
          : "repos/" + repo + "/actions/variables",
        {
          method: variables.has("RULESET_ENFORCEMENT") ? "PATCH" : "POST",
          body: { name: "RULESET_ENFORCEMENT", value },
        },
      );
      variables.set("RULESET_ENFORCEMENT", value);
    }
    let enforcement = checkpoint?.enforcement;
    if (!resumed) {
      step = "configuring delivery rulesets";
      const guardedApi = {
        request(...arguments_) {
          checkInterrupted();
          return api.request(...arguments_);
        },
        list(...arguments_) {
          checkInterrupted();
          return api.list(...arguments_);
        },
      };
      if (!remotelyEnabled) {
        checkInterrupted();
        if (store.state.rulesetEnforcement !== "pending" || store.state.enabled !== false) {
          store.state.rulesetEnforcement = "pending";
          store.state.enabled = false;
          await store.save();
        }
        await recordEnforcement("pending");
      }
      const result = await configureRepositoryRules({
        api: guardedApi,
        repo,
        rules,
        phase: "activate",
        acknowledgeUnenforced: Boolean(
          values["acknowledge-unenforced-rules"] || checkpoint?.enforcement === "unenforced",
        ),
        prompt: () => askSetupRules(controller.signal),
        log: packaged ? rulesetSetupLog : console.log,
      });
      enforcement = result.enforcement;
      checkInterrupted();
      store.state.activation = { fingerprint, enforcement };
      await store.save();
      await recordEnforcement(enforcement);
      step = "enabling repository automation";
      checkInterrupted();
      if (!remotelyEnabled)
        await api.request("repos/" + repo + "/actions/variables/AUTOMATION_ENABLED", {
          method: "PATCH",
          body: { name: "AUTOMATION_ENABLED", value: "true" },
        });
    }
    step = "recording local activation";
    checkInterrupted();
    store.state.rulesetEnforcement = enforcement;
    store.state.enabled = true;
    await store.save();
    if (resumed)
      console.log(
        "\nRecovered the recorded activation and reconciled the enabled repository with this host.",
      );
    const start = packaged ? "grait orchestrator start" : "npm run orchestrator -- start";
    console.log(
      enforcement === "active"
        ? `Delivery rules are active. Start the subscription-backed local orchestrator with ${start}.`
        : `Host activated with unenforced rules. Human approval and human merge remain required. Start the local orchestrator with ${start}.`,
    );
  } catch (error) {
    const retry = packaged ? "grait activate" : "npm run activate";
    if (controller.signal.aborted || error.code === "SETUP_INTERRUPTED") {
      setupWarning("Activation interrupted while " + step + ". Retry with " + retry + ".");
      status = 130;
    } else if (error.code === "RULESET_SETUP_PENDING") {
      setupWarning(error.message + " Retry with " + retry + ".", process.stderr);
      status = 2;
    } else {
      setupError(
        error.message +
          "\nActivation stopped while " +
          step +
          ". Resolve this check and retry " +
          retry +
          ".",
      );
      status = 1;
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    await store?.release();
  }
  process.exitCode = status;
  return status;
}

if (!bundledRuntime && isEntrypoint(import.meta.url)) await activateMain();

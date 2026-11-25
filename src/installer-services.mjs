import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { SetupState } from "../scripts/lib/setup-state.mjs";
import { command, withoutCredentials, requireSubscription } from "../scripts/lib/setup-process.mjs";
import {
  assertSetupPublishingBindings,
  humanToken,
  preparePublishingApps,
  publishingVariableMap,
  publishingRoles,
} from "../scripts/lib/local-auth.mjs";
import { GitHub } from "../scripts/lib/github.mjs";
import { sameLogin } from "../scripts/lib/policy.mjs";
import { assertIntegrationBranch, githubLogin, verifyInitHarness } from "./init-context.mjs";
import { bundledRuntime, packageResource, runtimeFile } from "../scripts/lib/runtime-resources.mjs";

export async function privateStagingDirectory(root, prefix) {
  const base = await realpath(tmpdir());
  const pathFromRoot = relative(root, base);
  if (!isAbsolute(pathFromRoot) && pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`))
    throw new Error("Choose a temporary directory outside the target worktree");
  return mkdtemp(join(base, prefix));
}

export async function installerStore({ root, repo }) {
  const { directory, state } = await SetupState.read(repo, root);
  return new SetupState(directory, state);
}

async function readProvisioningContext(repo) {
  let token;
  try {
    token = await humanToken();
  } catch {
    throw new Error(
      "GitHub authentication is required for " +
        repo +
        ". Run gh auth login, then retry grait init.",
    );
  }
  const api = new GitHub(token);
  const operator = await api.request("user");
  const repository = await api.request("repos/" + repo);
  if (operator.type !== "User" || !githubLogin(operator.login) || !repository.permissions?.admin)
    throw new Error(
      "An authorized human repository administrator must apply setup for " + repo + ".",
    );
  return { api, token, operator, repository };
}

function checkSetupBindings(repo, variables, state) {
  try {
    assertSetupPublishingBindings(variables, state);
  } catch (error) {
    const names = Object.values(publishingRoles).flatMap(({ app, bot }) => [app, bot]);
    const present = names.filter((name) => variables.has(name));
    const missing = names.filter((name) => !variables.has(name));
    throw new Error(
      "Incomplete repository publishing identities for " +
        repo +
        ". " +
        error.message +
        "\nPresent: " +
        (present.join(", ") || "none") +
        "\nMissing: " +
        (missing.join(", ") || "none") +
        "\nVerify the existing writer and reviewer App installations against the private setup checkpoint. Restore bindings for those Apps or reconcile stale repository variables with an administrator before retrying. Keep existing Apps and their keys.",
    );
  }
}

export async function preflightInstallation(options) {
  const { root, repo, state } = options;
  const { api, operator, repository } = await readProvisioningContext(repo);
  const defaultBranch = repository.default_branch || options.defaultBranch;
  await assertIntegrationBranch(root, defaultBranch);
  const maintainers = options.maintainers.length ? options.maintainers : [operator.login];
  if (!maintainers.some((login) => sameLogin(login, operator.login)))
    throw new Error("Include the applying administrator among --maintainers");
  if (options.prior) return { ...options, defaultBranch, maintainers };

  const variables = publishingVariableMap(
    await api.list("repos/" + repo + "/actions/variables", "variables"),
  );
  if (variables.get("AUTOMATION_ENABLED") === "true")
    throw new Error(
      "Pause the existing workflow for " + repo + " before applying installation changes.",
    );
  checkSetupBindings(repo, variables, state);
  const owner = variables.get("PROJECT_OWNER");
  const number = variables.get("PROJECT_NUMBER");
  if (
    (owner && options.projectOwner && !sameLogin(owner, options.projectOwner)) ||
    (number && options.projectNumber && number !== options.projectNumber)
  )
    throw new Error(
      "The selected Project differs from the recorded binding for " +
        repo +
        ". Reuse the recorded owner and number.",
    );
  if (
    !number &&
    !options.projectNumber &&
    !variables.get("PROJECT_ID") &&
    variables.get("PROJECT_SETUP_STATUS") === "creating"
  )
    throw new Error(
      "Project creation was interrupted for " +
        repo +
        ". Inspect GitHub and retry with the existing --project-owner and --project-number.",
    );
  await verifyInitHarness(options.harness);
  return {
    ...options,
    defaultBranch,
    maintainers,
    projectSummary: number ? (owner || repo.split("/")[0]) + " #" + number : undefined,
  };
}

export async function provision(options) {
  const { root, repo, store } = options;
  const { api, token, operator, repository } = await readProvisioningContext(repo);
  const maintainers = options.maintainers.length ? options.maintainers : [operator.login];
  if (!maintainers.some((login) => sameLogin(login, operator.login)))
    throw new Error("Include the applying administrator among --maintainers");
  await requireSubscription(options.harness, { login: true });
  const variables = publishingVariableMap(
    await api.list("repos/" + repo + "/actions/variables", "variables"),
  );
  if (variables.get("AUTOMATION_ENABLED") === "true")
    throw new Error("Pause the existing workflow before applying installation changes");
  checkSetupBindings(repo, variables, store.state);
  await preparePublishingApps({
    repo,
    ownerType: repository.owner.type,
    store,
    token,
    variables,
    keys: { writer: options.writerKey, reviewer: options.reviewerKey },
    openBrowser: options.noBrowser
      ? null
      : async (url) => {
          const opened = await command("gh", ["browse", url], {
            cwd: root,
            allowFailure: true,
          });
          if (opened.code) console.log("Open the printed GitHub approval URL to continue.");
        },
  });
  const stage = await privateStagingDirectory(root, "grait-provision-");
  try {
    await mkdir(join(stage, ".github"));
    await writeFile(
      join(stage, "workflow.config.json"),
      `${JSON.stringify(options.config, null, 2)}\n`,
    );
    if (options.codeowners !== undefined)
      await writeFile(join(stage, ".github/CODEOWNERS"), options.codeowners);
    const args = [
      ...(bundledRuntime
        ? [runtimeFile, "--grait-internal-runtime", "bootstrap"]
        : [packageResource("scripts/bootstrap.mjs")]),
      "--apply",
      "--repo",
      repo,
      "--maintainers",
      maintainers.join(","),
      "--writer-login",
      `${store.state.apps.writer.slug}[bot]`,
      "--status-app-id",
      String(store.state.apps.writer.id),
      "--writer-bot-user-id",
      String(store.state.apps.writer.botUserId),
      "--reviewer-app-id",
      String(store.state.apps.reviewer.id),
      "--reviewer-bot-user-id",
      String(store.state.apps.reviewer.botUserId),
      "--setup-root",
      root,
      "--reviewer-login",
      `${store.state.apps.reviewer.slug}[bot]`,
    ];
    for (const [key, flag] of [
      ["projectOwner", "project-owner"],
      ["projectNumber", "project-number"],
    ])
      if (options[key]) args.push(`--${flag}`, String(options[key]));
    if (options.acknowledgeUnenforcedRules) args.push("--acknowledge-unenforced-rules");
    const result = await command(process.execPath, args, {
      cwd: stage,
      allowFailure: true,
      interactive: true,
      env: {
        ...withoutCredentials(),
        GH_TOKEN: token,
        ...(process.env.PROJECT_TOKEN ? { PROJECT_TOKEN: process.env.PROJECT_TOKEN } : {}),
      },
    });
    if (result.code !== 0) {
      const error = new Error(
        result.code === 2
          ? "Ruleset configuration is pending. Resume after configuring it, or explicitly use --acknowledge-unenforced-rules. Saved Apps and Project will be reused."
          : "Provisioning did not complete. Preserve private App credentials and resume the same installation; the target remains unchanged.",
      );
      if (result.code === 2) error.code = "RULESET_SETUP_PENDING";
      throw error;
    }
    if (store.state.setupPublishingBindingsPending) {
      delete store.state.setupPublishingBindingsPending;
      await store.save();
    }
    return {
      config: JSON.parse(await readFile(join(stage, "workflow.config.json"), "utf8")),
      codeowners: await readFile(join(stage, ".github/CODEOWNERS"), "utf8"),
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

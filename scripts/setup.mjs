import { parseArgs } from "node:util";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { command, confirm, withoutCredentials, requireSubscription } from "./lib/setup-process.mjs";
import { SetupState } from "./lib/setup-state.mjs";
import { humanToken, roleToken } from "./lib/local-auth.mjs";
import { githubRequest, registerApp, validateApp, verifyInstallation } from "./lib/setup-apps.mjs";

async function publishConfiguration(repo, repository, store) {
  const saved = store.state.configuration;
  const branch = (await command("git", ["branch", "--show-current"])).stdout.trim();
  const head = (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
  if (
    !saved ||
    saved.branch !== branch ||
    saved.head !== head ||
    branch === repository.default_branch ||
    (await command("git", ["status", "--porcelain"])).stdout.trim()
  )
    throw new Error(
      "Publish recovery requires the clean, exact configuration branch/head recorded by setup",
    );
  const token = await roleToken(repo, "writer");
  const env = { ...withoutCredentials(), GH_TOKEN: token, GIT_TERMINAL_PROMPT: "0" };
  const pushed = await command(
    "git",
    [
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "push",
      "--set-upstream",
      `https://github.com/${repo}.git`,
      branch,
    ],
    { allowFailure: true, env },
  );
  if (pushed.code !== 0)
    throw new Error(
      `Configuration is committed on ${branch}. Resolve connectivity/installation access, then rerun npm run setup -- --publish; provisioning will not repeat`,
    );
  const existing = await githubRequest(
    `repos/${repo}/pulls?state=open&head=${encodeURIComponent(`${repo.split("/")[0]}:${branch}`)}`,
    { token },
  );
  if (existing.length > 1) throw new Error("Multiple configuration PRs need human reconciliation");
  const pr =
    existing[0] ||
    (await githubRequest(`repos/${repo}/pulls`, {
      method: "POST",
      token,
      body: {
        base: repository.default_branch,
        head: branch,
        title: "chore: configure local GRAIT harness",
        body: "Configure subscription-backed agents on the user's host, separate GitHub publishing identities, and the Project board. Local configuration checks and tests passed. A human must review and merge; then run npm run setup -- --activate on the updated default branch.",
      },
    }));
  store.state.configuration.pr = pr.number;
  await store.save();
  console.log(`Configuration PR: ${pr.html_url}`);
}

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean" },
      plan: { type: "boolean" },
      yes: { type: "boolean" },
      "no-browser": { type: "boolean" },
      activate: { type: "boolean" },
      publish: { type: "boolean" },
      repo: { type: "string" },
      harness: { type: "string" },
      maintainers: { type: "string" },
      "project-owner": { type: "string" },
      "project-number": { type: "string" },
      "writer-key": { type: "string" },
      "reviewer-key": { type: "string" },
    },
  });
  if (values.help) {
    console.log(
      "GRAIT local setup\n\nnpm run setup -- [--plan] [--repo OWNER/REPO] [--harness codex|claude]\n  --yes              Accept the displayed configuration plan\n  --no-browser       Print approval URLs (forward the localhost callback port over SSH)\n  --project-owner LOGIN --project-number NUMBER   Bind an existing Project\n  --maintainers LOGIN,LOGIN   Human code owners (default: signed-in GitHub user)\n  --writer-key PATH --reviewer-key PATH   Import private keys for existing Apps\n  --publish          Retry only the saved configuration push/PR after a failure\n  --activate         Activate after human merge and successful default-branch CI\n\nAll AI runs in your native harness using its own login. No provider API keys are requested. See docs/installation.md.",
    );
    return;
  }
  const config = JSON.parse(await readFile("workflow.config.json", "utf8"));
  const repo =
    values.repo ||
    config.controllerRepository ||
    JSON.parse((await command("gh", ["repo", "view", "--json", "nameWithOwner"])).stdout)
      .nameWithOwner;
  const harness = values.harness || config.engine;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "")) throw new Error("Provide --repo OWNER/REPO");
  if (!["codex", "claude"].includes(harness))
    throw new Error("Choose --harness codex or --harness claude");
  if (
    config.controllerRepository &&
    config.controllerRepository.toLowerCase() !== repo.toLowerCase()
  )
    throw new Error("This checkout is configured for another repository");
  if (values["project-number"] && !/^[1-9]\d*$/.test(values["project-number"]))
    throw new Error("Invalid Project number");
  let defaultMaintainers = config.humanOperators || [];
  if (!values.repo && !defaultMaintainers.length)
    defaultMaintainers = [JSON.parse((await command("gh", ["api", "user"])).stdout).login];
  const plan = {
    repository: repo,
    execution: "local",
    harness,
    authentication: "native harness subscription",
    identities: ["writer", "reviewer"],
    maintainers: values.maintainers
      ? values.maintainers.split(",")
      : defaultMaintainers.length
        ? defaultMaintainers
        : ["signed-in GitHub user"],
    project: values["project-number"] || "reuse recorded Project or create one",
    projectOwner: values["project-owner"] || repo.split("/")[0],
    maxConcurrentWorkers: config.maxConcurrentWorkers || 2,
    providerApiKeys: false,
    activate: Boolean(values.activate),
  };
  console.log(JSON.stringify(plan, null, 2));
  if (values.plan) return;
  if (values.activate) {
    await command(process.execPath, ["scripts/activate.mjs"], { interactive: true });
    return;
  }
  if (values.publish) {
    const token = await humanToken();
    const actor = await githubRequest("user", { token });
    const repository = await githubRequest(`repos/${repo}`, { token });
    if (
      actor.type !== "User" ||
      !repository.permissions?.admin ||
      !config.humanOperators.some((login) => login.toLowerCase() === actor.login.toLowerCase())
    )
      throw new Error("Publish recovery requires the configured human administrator");
    const { directory, state } = await SetupState.read(repo);
    const store = new SetupState(directory, state);
    await store.acquire();
    try {
      await publishConfiguration(repo, repository, store);
    } finally {
      await store.release();
    }
    return;
  }
  const dirty = (await command("git", ["status", "--porcelain"])).stdout.trim();
  if (dirty)
    throw new Error(
      "Commit or preserve existing changes before setup; the wizard prepares a focused configuration commit",
    );
  const initialBranch = (await command("git", ["branch", "--show-current"])).stdout.trim();
  const initialHead = (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
  if (!initialBranch)
    throw new Error(
      "Create an integration branch before setup; detached checkouts cannot publish configuration",
    );
  await confirm(
    "Apply this plan and prepare a configuration PR? GitHub App approvals and native logins remain interactive.",
    values.yes,
  );
  let token;
  try {
    token = await humanToken();
  } catch {
    await command("gh", ["auth", "login"], { interactive: true });
    token = await humanToken();
  }
  const operator = await githubRequest("user", { token });
  const repository = await githubRequest(`repos/${repo}`, { token });
  if (operator.type !== "User" || !repository.permissions?.admin)
    throw new Error(
      "An authorized human repository administrator must apply setup; prepare the integration branch and hand it to the owner (docs/installation.md)",
    );
  const maintainers = values.maintainers || config.humanOperators?.join(",") || operator.login;
  if (
    !maintainers
      .split(",")
      .some((login) => login.replace(/^@/, "").toLowerCase() === operator.login.toLowerCase())
  )
    throw new Error("Include the applying administrator among --maintainers");
  await requireSubscription(harness, { login: true });
  await command("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    interactive: true,
    env: withoutCredentials(),
  });
  const { directory, state } = await SetupState.read(repo);
  const store = new SetupState(directory, state);
  await store.acquire();
  try {
    const variables = await githubRequest(`repos/${repo}/actions/variables?per_page=100`, {
      token,
    });
    const variable = (name) => variables.variables?.find((entry) => entry.name === name)?.value;
    if (variable("AUTOMATION_ENABLED") === "true")
      throw new Error(
        "Pause the existing installation first: set AUTOMATION_ENABLED=false and stop any old hosted runs before upgrading",
      );
    store.state.enabled = false;
    for (const role of ["writer", "reviewer"]) {
      const existingLogin = variable(role === "writer" ? "AUTOMATION_LOGIN" : "REVIEW_LOGIN");
      const keyPath = values[`${role}-key`];
      if (keyPath) {
        if (!existingLogin?.endsWith("[bot]"))
          throw new Error(
            `No recorded ${role} App to import; register through the normal setup instead`,
          );
        const info = await lstat(keyPath);
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.mode & 0o077 ||
          (process.getuid && info.uid !== process.getuid())
        )
          throw new Error(
            "Imported App keys must be private files owned by you (chmod 600), not symlinks",
          );
        const slug = existingLogin.replace(/\[bot\]$/, "");
        const app = await githubRequest(`apps/${slug}`, { token });
        validateApp(app, { role, owner: repo.split("/")[0] });
        const saved = {
          name: slug,
          id: app.id,
          slug,
          clientId: app.client_id,
          pem: await readFile(keyPath, "utf8"),
          phase: "installed",
          installed: true,
        };
        await verifyInstallation(saved, { repo, role });
        store.state.apps[role] = saved;
        await store.save();
      }
      if (existingLogin && !store.state.apps[role]?.id)
        throw new Error(
          `Existing ${role} identity found. Import its private key with --${role}-key PATH; GitHub Secrets cannot be downloaded. Setup will not create a duplicate App`,
        );
      if (
        store.state.apps[role]?.id &&
        existingLogin &&
        `${store.state.apps[role].slug}[bot]`.toLowerCase() !== existingLogin.toLowerCase()
      )
        throw new Error(`Saved ${role} App differs from the repository's identity`);
      if (store.state.apps[role]?.installed)
        await verifyInstallation(store.state.apps[role], { repo, role });
      else
        await registerApp({
          role,
          repo,
          owner: repo.split("/")[0],
          ownerType: repository.owner.type,
          store,
          token,
          openBrowser: values["no-browser"]
            ? null
            : async (url) => {
                const opened = await command("gh", ["browse", url], { allowFailure: true });
                if (opened.code) console.log("Open the printed URL in your browser to continue.");
              },
        });
    }
    config.engine = harness;
    config.schemaVersion = 2;
    config.execution = "local";
    config.supportedEngines = ["codex", "claude"];
    config.maxConcurrentWorkers ||= 2;
    config.orchestrator ||= { reasoning: "medium" };
    for (const key of ["ghAwVersion", "ghAwActionsSha", "engineVersions", "budget"])
      delete config[key];
    if (config.tdd?.runner) delete config.tdd.runner.image;
    await writeFile("workflow.config.json", `${JSON.stringify(config, null, 2)}\n`);
    const args = [
      "scripts/bootstrap.mjs",
      "--apply",
      "--repo",
      repo,
      "--maintainers",
      maintainers,
      "--writer-login",
      `${store.state.apps.writer.slug}[bot]`,
      "--reviewer-login",
      `${store.state.apps.reviewer.slug}[bot]`,
    ];
    for (const option of ["project-owner", "project-number"])
      if (values[option]) args.push(`--${option}`, values[option]);
    await command(process.execPath, args, { interactive: true });
    await command("npm", ["exec", "--", "prettier", "--write", "workflow.config.json"], {
      interactive: true,
    });
    await command("npm", ["run", "harness:generate"], { interactive: true });
    await command("npm", ["run", "check"], { interactive: true });
    await command("npm", ["test"], { interactive: true, env: withoutCredentials() });
    await command("npm", ["run", "format:check"], { interactive: true });
    await command("npm", ["run", "lint:md"], { interactive: true });
    const current = (await command("git", ["branch", "--show-current"])).stdout.trim();
    if (
      current !== initialBranch ||
      (await command("git", ["rev-parse", "HEAD"])).stdout.trim() !== initialHead
    )
      throw new Error(
        "The branch changed during setup; preserve the generated configuration and reconcile before publishing",
      );
    if (current === repository.default_branch)
      await command("git", ["switch", "-c", `chore/grait-setup-${Date.now()}`]);
    if (initialBranch !== repository.default_branch) {
      // A pre-existing integration may change workflow files. Only the human's
      // credential publishes those original commits; the writer App never gains
      // workflow-write permission. Its later push contains configuration only.
      const result = await command(
        "git",
        [
          "-c",
          "credential.helper=",
          "-c",
          "credential.helper=!gh auth git-credential",
          "push",
          `https://github.com/${repo}.git`,
          `${initialHead}:refs/heads/${initialBranch}`,
        ],
        {
          allowFailure: true,
          env: { ...withoutCredentials(), GH_TOKEN: token, GIT_TERMINAL_PROMPT: "0" },
        },
      );
      if (result.code !== 0)
        throw new Error(
          "The administrator must publish the original integration branch first (including authorization for workflow-file changes). Preserve generated configuration, resolve GitHub access, and retry; no App workflow-write permission is required",
        );
    }
    await command("git", [
      "add",
      "workflow.config.json",
      ".github/CODEOWNERS",
      ".agents/skills",
      ".claude/skills",
      ".claude/agents",
    ]);
    await command("git", ["add", "--force", ".codex/config.toml", ".codex/agents"]);
    await command("git", ["commit", "-m", "chore: configure local GRAIT harness"]);
    const branch = (await command("git", ["branch", "--show-current"])).stdout.trim();
    store.state.configuration = {
      branch,
      head: (await command("git", ["rev-parse", "HEAD"])).stdout.trim(),
    };
    await store.save();
    await publishConfiguration(repo, repository, store);
    console.log(
      "Configuration PR prepared. After human merge and successful default-branch CI, update this checkout and run npm run setup -- --activate.",
    );
  } finally {
    await store.release();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

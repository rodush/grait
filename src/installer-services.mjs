import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { SetupState } from "../scripts/lib/setup-state.mjs";
import { command, withoutCredentials, requireSubscription } from "../scripts/lib/setup-process.mjs";
import { humanToken } from "../scripts/lib/local-auth.mjs";
import { GitHub } from "../scripts/lib/github.mjs";
import { registerApp, validateApp, verifyInstallation } from "../scripts/lib/setup-apps.mjs";
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

async function importApp(path, role, login, options, api) {
  if (!login?.endsWith("[bot]")) throw new Error(`No recorded ${role} App exists for key import`);
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.mode & 0o077 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new Error("Imported App keys must be private regular files owned by you (chmod 600)");
  const app = await api.request(`apps/${login.replace(/\[bot\]$/, "")}`);
  validateApp(app, { owner: options.repo.split("/")[0], role });
  return {
    name: app.slug,
    id: app.id,
    slug: app.slug,
    clientId: app.client_id,
    pem: await readFile(path, "utf8"),
    installed: true,
    phase: "installed",
  };
}

export async function provision(options) {
  const { root, repo, store } = options;
  const token = await humanToken();
  const api = new GitHub(token);
  const operator = await api.request("user");
  const repository = await api.request(`repos/${repo}`);
  if (operator.type !== "User" || !repository.permissions?.admin)
    throw new Error("An authorized human repository administrator must apply setup");
  const maintainers = options.maintainers.length ? options.maintainers : [operator.login];
  if (!maintainers.some((login) => login.toLowerCase() === operator.login.toLowerCase()))
    throw new Error("Include the applying administrator among --maintainers");
  await requireSubscription(options.harness, { login: true });
  const variables = await api.list(`repos/${repo}/actions/variables`, "variables");
  const variable = (name) => variables.find((entry) => entry.name === name)?.value;
  if (variable("AUTOMATION_ENABLED") === "true")
    throw new Error("Pause the existing workflow before applying installation changes");
  store.state.enabled = false;
  await store.save();
  for (const role of ["writer", "reviewer"]) {
    const login = variable(role === "writer" ? "AUTOMATION_LOGIN" : "REVIEW_LOGIN");
    const keyPath = options[`${role}Key`];
    if (keyPath) {
      const imported = await importApp(keyPath, role, login, options, api);
      await verifyInstallation(imported, { repo, role });
      store.state.apps[role] = imported;
      await store.save();
    }
    const app = store.state.apps[role];
    if (login && !app?.id)
      throw new Error(
        `Import the existing ${role} App key; setup will not create a replacement identity`,
      );
    if (login && app?.slug && `${app.slug}[bot]`.toLowerCase() !== login.toLowerCase())
      throw new Error(`Saved ${role} App differs from the repository's recorded identity`);
    if (app?.installed) await verifyInstallation(app, { repo, role });
    else
      await registerApp({
        role,
        repo,
        owner: repo.split("/")[0],
        ownerType: repository.owner.type,
        store,
        token,
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
  }
  if (store.state.apps.writer.id === store.state.apps.reviewer.id)
    throw new Error("Implementation and review Apps must be separate identities");
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
    return {
      config: JSON.parse(await readFile(join(stage, "workflow.config.json"), "utf8")),
      codeowners: await readFile(join(stage, ".github/CODEOWNERS"), "utf8"),
    };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

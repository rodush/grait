import { lstat, readFile } from "node:fs/promises";
import { command } from "./setup-process.mjs";
import {
  appJwt,
  githubRequest,
  registerApp,
  rolePermissions,
  verifyInstallation,
} from "./setup-apps.mjs";
import { SetupState } from "./setup-state.mjs";
import { sameLogin } from "./policy.mjs";

export async function humanToken() {
  return process.env.GH_TOKEN || (await command("gh", ["auth", "token"])).stdout.trim();
}

export async function roleToken(repo, role, { cwd = process.cwd(), fetcher = fetch } = {}) {
  if (!["writer", "reviewer"].includes(role))
    throw new Error("Choose writer or reviewer publishing identity");
  const { state } = await SetupState.read(repo, cwd);
  const app = state.apps[role];
  if (!app?.pem || !app.id || !app.installed)
    throw new Error(
      `Run setup on this host or securely import the existing ${role} App credentials; never create replacement identities just to change hosts`,
    );
  return mintRoleToken(app, { repo, role, fetcher });
}

async function mintRoleToken(app, { repo, role, fetcher }) {
  const installation = await verifyInstallation(app, { repo, role, fetcher });
  const result = await githubRequest(`app/installations/${installation.id}/access_tokens`, {
    method: "POST",
    token: appJwt(app),
    fetcher,
    body: { repositories: [repo.split("/")[1]], permissions: rolePermissions(role) },
  });
  if (!result.token || !result.expires_at)
    throw new Error("GitHub did not return a short-lived installation token");
  return result.token;
}

export const publishingRoles = {
  writer: {
    app: "AUTOMATION_APP_ID",
    bot: "AUTOMATION_BOT_USER_ID",
    login: "AUTOMATION_LOGIN",
  },
  reviewer: {
    app: "REVIEW_APP_ID",
    bot: "REVIEW_BOT_USER_ID",
    login: "REVIEW_LOGIN",
  },
};

export function identityNumber(value) {
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) value = Number(value);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function publishingBindings(apps) {
  const { writer, reviewer } = apps ?? {};
  if (
    ![writer?.id, reviewer?.id, writer?.botUserId, reviewer?.botUserId].every(
      (id) => identityNumber(id) !== undefined,
    )
  )
    throw new Error("Missing or invalid publishing App or bot user IDs; complete clean setup");
  if (
    String(writer.id) === String(reviewer.id) ||
    String(writer.botUserId) === String(reviewer.botUserId)
  )
    throw new Error("Writer and reviewer require distinct verified App and bot user IDs");
  return Object.fromEntries(
    Object.entries(publishingRoles).flatMap(([role, names]) => [
      [names.app, String(apps[role].id)],
      [names.bot, String(apps[role].botUserId)],
    ]),
  );
}

export function publishingVariableMap(entries) {
  const identityNames = new Set(Object.values(publishingRoles).flatMap(Object.values));
  const variables = new Map();
  for (const { name, value } of entries) {
    if (identityNames.has(name) && variables.has(name))
      throw new Error(
        `Duplicate repository publishing identity variable ${name}; reconcile the bindings before clean setup`,
      );
    variables.set(name, value);
  }
  return variables;
}

export function assertPublishingBindings(variables, apps) {
  for (const [name, expected] of Object.entries(publishingBindings(apps))) {
    if (!variables.has(name))
      throw new Error(
        `Missing repository publishing identity variable ${name}; complete clean setup`,
      );
    const recorded = variables.get(name);
    if (typeof recorded !== "string" || !identityNumber(recorded))
      throw new Error(
        `Invalid repository publishing identity variable ${name}; complete clean setup`,
      );
    if (recorded !== expected)
      throw new Error(
        `Host publishing identities differ from the repository's recorded Apps: ${name}`,
      );
  }
}

export function assertSetupPublishingBindings(variables, state) {
  const names = Object.values(publishingRoles);
  const numeric = names.flatMap(({ app, bot }) => [app, bot]);
  const recorded = numeric.filter((name) => variables.has(name));
  const hasLogin = names.some(({ login }) => variables.has(login));
  if (!recorded.length && !hasLogin) return;
  if (recorded.length === numeric.length) {
    publishingBindings(
      Object.fromEntries(
        Object.entries(publishingRoles).map(([role, { app, bot }]) => [
          role,
          { id: identityNumber(variables.get(app)), botUserId: identityNumber(variables.get(bot)) },
        ]),
      ),
    );
    return;
  }
  if (recorded.length && state.setupPublishingBindingsPending) {
    const expected = publishingBindings(state.apps);
    if (recorded.every((name) => variables.get(name) === expected[name])) return;
  }
  throw new Error("Incomplete repository publishing identities; complete clean setup");
}

export async function preparePublishingApps({
  repo,
  ownerType,
  store,
  token,
  variables,
  keys,
  openBrowser,
}) {
  let needsBindings = false;
  const owner = repo.split("/")[0];
  for (const [role, names] of Object.entries(publishingRoles)) {
    const id = identityNumber(variables.get(names.app));
    const botUserId = identityNumber(variables.get(names.bot));
    const keyPath = keys[role];
    let saved = store.state.apps[role];
    if (id && saved?.id && saved.id !== id)
      throw new Error(`Saved ${role} App ID differs from the repository's identity`);
    if (botUserId && saved?.botUserId !== undefined && saved.botUserId !== botUserId)
      throw new Error(`Saved ${role} bot user ID differs from the repository's identity`);
    if (keyPath) {
      if (!id || !botUserId)
        throw new Error(`No recorded numeric ${role} binding for key import; complete clean setup`);
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
      saved = {
        ...saved,
        name: saved?.name || `grait-${role}-${id}`,
        id,
        botUserId,
        pem: await readFile(keyPath, "utf8"),
        phase: "installed",
        installed: true,
      };
    }
    if (id && !saved?.id)
      throw new Error(
        `Import the existing ${role} App key with --${role}-key PATH; setup will not create a replacement identity`,
      );
    if (botUserId && !saved?.botUserId)
      throw new Error(`Missing saved ${role} bot user ID; complete clean setup`);
    if (!saved?.installed)
      saved = await registerApp({ role, repo, owner, ownerType, store, token, openBrowser });
    const {
      token: _token,
      login: _login,
      ...verified
    } = await verifyPublishingIdentity(saved, { repo, role });
    store.state.apps[role] = verified;
    needsBindings ||= !id || !botUserId;
    await store.save();
  }
  publishingBindings(store.state.apps);
  store.state.enabled = false;
  if (needsBindings) store.state.setupPublishingBindingsPending = true;
  await store.save();
}

export async function verifyPublishingIdentity(app, { repo, role, fetcher = fetch }) {
  if (!app?.pem || !app.id || !app.installed)
    throw new Error(
      `Missing approved ${role} App credentials; import the existing key before continuing`,
    );
  const remote = await githubRequest("app", { token: appJwt(app), fetcher });
  if (
    !Number.isSafeInteger(remote?.id) ||
    remote.id < 1 ||
    remote.id !== app.id ||
    !/^[a-z0-9-]+$/.test(remote.slug || "")
  )
    throw new Error(`Authenticated ${role} App ID differs from the approved publishing identity`);
  if (!sameLogin(remote.owner?.login, repo.split("/")[0]))
    throw new Error(`Authenticated ${role} App owner differs from the approved repository owner`);
  const login = `${remote.slug}[bot]`;
  const identified = {
    ...app,
    id: remote.id,
    slug: remote.slug,
    clientId: remote.client_id || app.clientId || String(remote.id),
  };
  const token = await mintRoleToken(identified, { repo, role, fetcher });
  const bot = await githubRequest(`users/${encodeURIComponent(login)}`, {
    token,
    fetcher,
  });
  if (
    bot?.type !== "Bot" ||
    !sameLogin(bot.login, login) ||
    !Number.isSafeInteger(bot.id) ||
    bot.id < 1 ||
    (app.botUserId !== undefined && bot.id !== app.botUserId)
  )
    throw new Error(
      `Authenticated ${role} App bot user ID differs from the approved publishing identity`,
    );
  return { ...identified, login, botUserId: bot.id, token };
}

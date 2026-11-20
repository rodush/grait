import { command } from "./setup-process.mjs";
import { appJwt, githubRequest, rolePermissions, verifyInstallation } from "./setup-apps.mjs";
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
  const { writer, reviewer } = apps;
  if (
    !identityNumber(writer?.id) ||
    !identityNumber(reviewer?.id) ||
    writer.id === reviewer.id ||
    (writer.botUserId !== undefined && writer.botUserId === reviewer.botUserId)
  )
    throw new Error("Writer and reviewer require distinct verified App and bot user IDs");
  if (!identityNumber(writer.botUserId) || !identityNumber(reviewer.botUserId))
    throw new Error(
      "Publishing bot user IDs are missing; run explicit publishing identity migration",
    );
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
        `Duplicate repository publishing identity variable ${name}; reconcile the bindings`,
      );
    variables.set(name, value);
  }
  return variables;
}

export function assertPublishingBindings(variables, apps) {
  for (const [name, expected] of Object.entries(publishingBindings(apps))) {
    if (!variables.has(name))
      throw new Error(
        `Missing repository publishing identity variable ${name}; incomplete bindings require explicit publishing identity migration`,
      );
    const recorded = variables.get(name);
    if (typeof recorded !== "string" || !identityNumber(recorded))
      throw new Error(
        `Invalid repository publishing identity variable ${name}; reconcile the malformed binding`,
      );
    if (recorded !== expected)
      throw new Error(
        `Host publishing identities differ from the repository's recorded Apps: ${name}`,
      );
  }
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

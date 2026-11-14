import { command } from "./setup-process.mjs";
import { appJwt, githubRequest, rolePermissions, verifyInstallation } from "./setup-apps.mjs";
import { SetupState } from "./setup-state.mjs";

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

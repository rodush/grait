import { createServer } from "node:http";
import { randomBytes, sign, timingSafeEqual } from "node:crypto";

export const appRoles = {
  writer: {
    permissions: {
      contents: "write",
      issues: "write",
      pull_requests: "write",
      statuses: "write",
      metadata: "read",
    },
  },
  reviewer: {
    permissions: { contents: "read", issues: "write", pull_requests: "write", metadata: "read" },
  },
};

export function rolePermissions(role, organizationProject = false) {
  const definition = appRoles[role];
  if (!definition) throw new Error("Unsupported setup App role");
  return {
    ...definition.permissions,
    ...(role === "writer" && organizationProject ? { organization_projects: "write" } : {}),
  };
}

export function appManifest({ role, repo, name, baseUrl, state, organizationProject = false }) {
  return {
    name,
    url: `https://github.com/${repo}`,
    description: `GRAIT ${role} publishing identity for ${repo}`,
    public: false,
    hook_attributes: { url: `https://github.com/${repo}`, active: false },
    redirect_url: `${baseUrl}/callback/${role}`,
    setup_url: `${baseUrl}/installed/${role}?state=${state}`,
    default_permissions: rolePermissions(role, organizationProject),
    default_events: [],
  };
}

export function appJwt(app, now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: seconds - 60, exp: seconds + 540, iss: app.clientId || app.id })}`;
  try {
    return `${payload}.${sign("RSA-SHA256", Buffer.from(payload), app.pem).toString("base64url")}`;
  } catch {
    throw new Error(
      "The saved App key cannot sign its installation request; inspect that App's credentials",
    );
  }
}

export async function githubRequest(path, { token, method = "GET", body, fetcher = fetch } = {}) {
  let response;
  try {
    response = await fetcher(`https://api.github.com/${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
      redirect: "error",
    });
  } catch {
    throw new Error("GitHub setup request could not complete; check connectivity and rerun");
  }
  if (!response.ok) {
    const error = new Error(
      `GitHub setup request returned ${response.status}; inspect permissions and rerun`,
    );
    error.status = response.status;
    throw error;
  }
  try {
    return response.status === 204 ? null : await response.json();
  } catch {
    throw new Error("GitHub returned an invalid setup response");
  }
}

function validatePermissions(actual, expected) {
  if (!actual || Object.entries(expected).some(([name, access]) => actual[name] !== access))
    throw new Error(
      "App permissions differ from the approved role; restore its manifest permissions",
    );
  if (
    Object.entries(actual).some(([name, access]) => access !== "none" && expected[name] !== access)
  )
    throw new Error(
      "App has permissions beyond its approved role; remove additional grants before continuing",
    );
}

export function validateApp(app, { owner, role, organizationProject = false }) {
  if (
    !Number.isSafeInteger(app.id) ||
    app.id < 1 ||
    !/^[a-z0-9-]+$/.test(app.slug || "") ||
    !app.client_id ||
    app.owner?.login?.toLowerCase() !== owner.toLowerCase()
  )
    throw new Error("Registered App identity or owner differs from the approved setup target");
  validatePermissions(app.permissions, rolePermissions(role, organizationProject));
}

export async function verifyInstallation(
  app,
  { repo, role, organizationProject = false, fetcher = fetch },
) {
  const installation = await githubRequest(`repos/${repo}/installation`, {
    token: appJwt(app),
    fetcher,
  });
  if (
    installation.app_id !== app.id ||
    installation.account?.login?.toLowerCase() !== repo.split("/")[0].toLowerCase() ||
    installation.suspended_at
  )
    throw new Error("App is not installed and active on the approved target repository");
  validatePermissions(installation.permissions, rolePermissions(role, organizationProject));
  return installation;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

function sameState(actual, expected) {
  return (
    typeof actual === "string" &&
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  );
}

// Public browser boundary: loopback-only, capability-protected entry, state-checked callbacks.
export async function registerApp({
  role,
  repo,
  owner,
  ownerType,
  organizationProject = false,
  store,
  token,
  openBrowser,
  log = console.log,
  fetcher = fetch,
  timeoutMs = 30 * 60 * 1000,
}) {
  let app = store.state.apps[role];
  const resuming = Boolean(app);
  if (!app) {
    const suffix = randomBytes(5).toString("hex");
    const name = `grait-${repo.split("/")[1].slice(0, 45)}-${role}-${suffix}`;
    app = { name, state: randomBytes(32).toString("hex"), phase: "pending" };
    store.state.apps[role] = app;
  }
  if (app.phase === "converting" && !app.id)
    throw new Error(
      "An earlier registration has an uncertain result. Recover that existing App and its key before retrying; setup will not create a duplicate.",
    );
  if (!app.state) app.state = randomBytes(32).toString("hex");
  const capability = randomBytes(32).toString("hex");
  let consumed = false;
  let resolveDone;
  let rejectDone;
  const complete = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  complete.catch(() => {}); // A browser callback may reject before startup finishes.
  const server = createServer();
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxHeadersCount = 40;
  await new Promise((resolve, reject) => {
    server.once("error", () =>
      reject(
        new Error(
          "Setup callback port is unavailable; stop the previous setup session or restore the saved port before retrying",
        ),
      ),
    );
    server.listen(store.state.port || 0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  store.state.port = port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const nonce = randomBytes(24).toString("base64");
  const headers = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; form-action https://github.com; base-uri 'none'; frame-ancestors 'none'; script-src 'nonce-${nonce}'`,
    "Content-Type": "text/html; charset=utf-8",
  };
  const installationUrl = () =>
    `https://github.com/apps/${app.slug}/installations/new?state=${app.state}`;
  server.on("request", async (request, response) => {
    function answer(status, body, extra = {}) {
      response.writeHead(status, { ...headers, ...extra });
      response.end(body);
    }
    try {
      if (request.headers.host !== `127.0.0.1:${port}` || request.method !== "GET")
        return answer(400, "Invalid setup request.");
      const url = new URL(request.url, baseUrl);
      if (url.pathname === `/start/${capability}`) {
        if (app.id) return answer(302, "Continue installation.", { Location: installationUrl() });
        const action =
          ownerType === "Organization"
            ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
            : "https://github.com/settings/apps/new";
        const manifest = appManifest({
          role,
          repo,
          name: app.name,
          baseUrl,
          state: app.state,
          organizationProject,
        });
        const warning = resuming
          ? "If this App was already created, refresh its existing callback page in your browser. Submit this form only if registration has not completed; its saved name is unchanged."
          : "Confirm the preconfigured App on GitHub, then install it on the target repository.";
        return answer(
          200,
          `<!doctype html><html><head><title>Configure GRAIT</title></head><body><h1>Configure ${escapeHtml(role)} for ${escapeHtml(repo)}</h1><p>${escapeHtml(warning)}</p><form action="${action}?state=${app.state}" method="post"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}"><button type="submit">Register ${escapeHtml(role)} App on GitHub</button></form></body></html>`,
        );
      }
      if (url.pathname === `/callback/${role}`) {
        if (!sameState(url.searchParams.get("state"), app.state))
          return answer(403, "Invalid setup state.");
        if (consumed || app.id) return answer(409, "Registration callback was already consumed.");
        const code = url.searchParams.get("code");
        if (!code || !/^[a-zA-Z0-9_-]{1,200}$/.test(code))
          return answer(400, "Missing or invalid registration code.");
        consumed = true;
        app.phase = "converting";
        await store.save();
        const result = await githubRequest(
          `app-manifests/${encodeURIComponent(code)}/conversions`,
          { method: "POST", token, fetcher },
        );
        validateApp(result, { owner, role, organizationProject });
        if (!result.pem)
          throw new Error(
            "App registration did not return its private key; inspect the existing App before retrying",
          );
        Object.assign(app, {
          id: result.id,
          slug: result.slug,
          clientId: result.client_id,
          pem: result.pem,
          phase: "registered",
        });
        await store.save();
        return answer(302, "App registered; continue installation on GitHub.", {
          Location: installationUrl(),
        });
      }
      if (url.pathname === `/installed/${role}`) {
        if (!sameState(url.searchParams.get("state"), app.state))
          return answer(403, "Invalid setup state.");
        if (!app.id || !app.pem) return answer(409, "Complete App registration first.");
        await verifyInstallation(app, { repo, role, organizationProject, fetcher });
        app.installed = true;
        app.phase = "installed";
        await store.save();
        answer(
          200,
          "App installation verified. You can close this page and continue in the terminal.",
        );
        resolveDone(app);
        return;
      }
      return answer(404, "Setup page not found.");
    } catch (error) {
      answer(
        400,
        "Setup could not verify this step. Return to the terminal for recovery instructions.",
      );
      rejectDone(error);
    }
  });
  let timer;
  const abort = () => rejectDone(new Error("Setup interrupted; rerun to resume the existing App"));
  try {
    await store.save();
    timer = setTimeout(
      () =>
        rejectDone(
          new Error(
            "App setup timed out. Rerun setup and resume the existing browser registration or installation",
          ),
        ),
      timeoutMs,
    );
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    const url = `${baseUrl}/start/${capability}`;
    log(`Approve ${role} App registration/installation for ${repo}: ${url}`);
    if (resuming && !app.id)
      log(
        "An earlier registration may already exist. Refresh its callback page rather than creating a replacement.",
      );
    if (openBrowser) await openBrowser(url);
    return await complete;
  } finally {
    clearTimeout(timer);
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { request as httpRequest } from "node:http";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoot =
  process.env.GRAIT_TEST_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url));
const apps = await import(pathToFileURL(resolve(sourceRoot, "scripts/lib/setup-apps.mjs")));
const { SetupState } = await import(
  pathToFileURL(resolve(sourceRoot, "scripts/lib/setup-state.mjs"))
);
const { roleToken } = await import(
  pathToFileURL(resolve(sourceRoot, "scripts/lib/local-auth.mjs"))
);
const { command, withoutCredentials } = await import(
  pathToFileURL(resolve(sourceRoot, "scripts/lib/setup-process.mjs"))
);
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const repo = "acme/service";

function app(role = "writer") {
  return {
    id: role === "writer" ? 101 : 102,
    name: `grait-${role}`,
    slug: `grait-${role}`,
    clientId: `Iv1.local-${role}`,
    pem,
    installed: true,
    phase: "installed",
  };
}

function registration(role = "writer") {
  const value = app(role);
  return {
    id: value.id,
    slug: value.slug,
    client_id: value.clientId,
    owner: { login: "acme" },
    permissions: apps.rolePermissions(role),
    pem,
  };
}

function installation(role = "writer") {
  return {
    id: 501,
    app_id: app(role).id,
    account: { login: "acme" },
    permissions: apps.rolePermissions(role),
    suspended_at: null,
  };
}

async function metadata(t) {
  const cwd = await mkdtemp(join(tmpdir(), "grait-private-state-test-"));
  const result = spawnSync("git", ["init", "--quiet"], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0);
  const initial = await SetupState.read(repo, cwd);
  const store = new SetupState(initial.directory, initial.state);
  await store.acquire();
  t.after(async () => {
    await store.release();
    await rm(cwd, { recursive: true, force: true });
  });
  return {
    cwd,
    store,
    directory: initial.directory,
    path: join(initial.directory, "session.json"),
  };
}

function memoryStore(existing) {
  const snapshots = [];
  return {
    state: { version: 1, repo, apps: existing ? { writer: existing } : {} },
    snapshots,
    async save() {
      snapshots.push(structuredClone(this.state));
    },
  };
}

function decodeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

async function rawRequest(url, headers) {
  return new Promise((resolveResponse, reject) => {
    const request = httpRequest(url, { headers }, (response) => {
      response.resume();
      response.on("end", () => resolveResponse(response.statusCode));
    });
    request.on("error", reject);
    request.end();
  });
}

function assertAppJwt(token) {
  const parts = token.split(".");
  assert.equal(parts.length, 3);
  assert.ok(
    verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2], "base64url"),
    ),
  );
  const header = JSON.parse(Buffer.from(parts[0], "base64url"));
  const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
  assert.equal(header.alg, "RS256");
  assert.ok(claims.exp - claims.iat <= 600);
  assert.ok(claims.exp * 1000 > Date.now());
}

test("setup manifests use only separate writer and reviewer roles with minimal private grants", () => {
  assert.deepEqual(Object.keys(apps.appRoles).sort(), ["reviewer", "writer"]);
  for (const role of ["writer", "reviewer"]) {
    const manifest = apps.appManifest({
      role,
      repo,
      name: `grait-${role}`,
      baseUrl: "http://127.0.0.1:43210",
      state: "a".repeat(64),
    });
    assert.equal(manifest.public, false);
    assert.equal(manifest.hook_attributes.active, false);
    assert.deepEqual(manifest.default_events, []);
    assert.equal(manifest.default_permissions.administration, undefined);
    assert.equal(manifest.default_permissions.actions, undefined);
    assert.equal(manifest.default_permissions.organization_projects, undefined);
    assert.equal(manifest.default_permissions.contents, role === "writer" ? "write" : "read");
    assert.equal(manifest.default_permissions.pull_requests, "write");
  }
  assert.equal(apps.rolePermissions("writer", true).organization_projects, "write");
  assert.equal(apps.rolePermissions("reviewer", true).organization_projects, undefined);
  assert.throws(() => apps.rolePermissions("release"));
});

test("App registration validation rejects wrong owners and missing or excess grants", () => {
  assert.doesNotThrow(() => apps.validateApp(registration(), { owner: "ACME", role: "writer" }));
  for (const changed of [
    { owner: { login: "another-owner" } },
    { id: 0 },
    { client_id: "" },
    { permissions: { ...apps.rolePermissions("writer"), contents: "read" } },
    { permissions: { ...apps.rolePermissions("writer"), administration: "write" } },
  ])
    assert.throws(() =>
      apps.validateApp({ ...registration(), ...changed }, { owner: "acme", role: "writer" }),
    );
});

test("installation verification uses a signed App JWT and refuses spoofed target access", async () => {
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++;
    assert.equal(url, "https://api.github.com/repos/acme/service/installation");
    assertAppJwt(options.headers.Authorization.replace(/^Bearer /, ""));
    return Response.json(installation());
  };
  assert.equal((await apps.verifyInstallation(app(), { repo, role: "writer", fetcher })).id, 501);
  assert.equal(calls, 1);
  for (const changed of [
    { app_id: 999 },
    { account: { login: "wrong-target" } },
    { suspended_at: "2026-11-01T00:00:00Z" },
    { permissions: { contents: "read" } },
    { permissions: { ...apps.rolePermissions("writer"), actions: "write" } },
  ])
    await assert.rejects(() =>
      apps.verifyInstallation(app(), {
        repo,
        role: "writer",
        fetcher: async () => Response.json({ ...installation(), ...changed }),
      }),
    );
});

test("loopback registration rejects wrong state, Host and replay before accepting verified installation", async () => {
  const store = memoryStore();
  const logs = [];
  let conversions = 0;
  let installationChecks = 0;
  const value = await apps.registerApp({
    role: "writer",
    repo,
    owner: "acme",
    ownerType: "Organization",
    store,
    token: "synthetic-human-credential",
    log: (message) => logs.push(message),
    timeoutMs: 5000,
    fetcher: async (url, options) => {
      if (url.includes("/app-manifests/")) {
        conversions++;
        assert.equal(options.method, "POST");
        assert.equal(store.snapshots.at(-1).apps.writer.phase, "converting");
        return Response.json(registration());
      }
      assert.equal(url, "https://api.github.com/repos/acme/service/installation");
      installationChecks++;
      assertAppJwt(options.headers.Authorization.replace(/^Bearer /, ""));
      return Response.json(installation());
    },
    openBrowser: async (url) => {
      const start = await fetch(url);
      assert.equal(start.status, 200);
      assert.equal(start.headers.get("cache-control"), "no-store");
      assert.equal(start.headers.get("referrer-policy"), "no-referrer");
      const html = await start.text();
      const manifest = JSON.parse(decodeHtml(html.match(/name="manifest" value="([^"]*)"/)[1]));
      const action = decodeHtml(html.match(/<form action="([^"]*)"/)[1]);
      assert.ok(action.startsWith("https://github.com/organizations/acme/settings/apps/new?"));
      const state = new URL(action).searchParams.get("state");
      assert.match(state, /^[a-f0-9]{64}$/);
      assert.equal(new URL(manifest.redirect_url).hostname, "127.0.0.1");
      assert.equal(await rawRequest(url, { Host: "untrusted.example" }), 400);
      const callback = new URL(manifest.redirect_url);
      callback.searchParams.set("state", "b".repeat(64));
      callback.searchParams.set("code", "synthetic-registration-code");
      assert.equal((await fetch(callback, { redirect: "manual" })).status, 403);
      assert.equal(conversions, 0);
      callback.searchParams.set("state", state);
      const converted = await fetch(callback, { redirect: "manual" });
      assert.equal(converted.status, 302);
      assert.ok(
        converted.headers
          .get("location")
          .startsWith("https://github.com/apps/grait-writer/installations/new?"),
      );
      assert.equal(conversions, 1);
      assert.equal((await fetch(callback, { redirect: "manual" })).status, 409);
      assert.equal(conversions, 1);
      const installed = new URL(manifest.setup_url);
      installed.searchParams.set("installation_id", "999999");
      assert.equal((await fetch(installed)).status, 200);
    },
  });
  assert.equal(value.installed, true);
  assert.equal(installationChecks, 1);
  assert.ok(!logs.join("\n").includes(pem));
  assert.ok(!logs.join("\n").includes("synthetic-registration-code"));
  assert.ok(!logs.join("\n").includes("synthetic-human-credential"));
});

test("registration timeout closes its listener and preserves the same resumable App name", async () => {
  const store = memoryStore();
  let url;
  await assert.rejects(
    () =>
      apps.registerApp({
        role: "writer",
        repo,
        owner: "acme",
        ownerType: "Organization",
        store,
        timeoutMs: 40,
        fetcher: async () => assert.fail("Timeout must not contact GitHub"),
        log: (message) => {
          url = message.match(/http:\/\/\S+/)?.[0];
        },
      }),
    /timed out/i,
  );
  assert.ok(store.state.apps.writer.name);
  assert.equal(store.state.apps.writer.id, undefined);
  assert.equal(store.state.apps.writer.phase, "pending");
  await assert.rejects(() => fetch(url, { signal: AbortSignal.timeout(1000) }));
  const originalName = store.state.apps.writer.name;
  await assert.rejects(
    () =>
      apps.registerApp({
        role: "writer",
        repo,
        owner: "acme",
        ownerType: "Organization",
        store,
        timeoutMs: 40,
        fetcher: async () => assert.fail("Resume timeout must not contact GitHub"),
        log: () => {},
      }),
    /timed out/i,
  );
  assert.equal(store.state.apps.writer.name, originalName);
});

test("ambiguous manifest conversion never creates a replacement identity", async () => {
  const store = memoryStore({ name: "grait-existing", state: "c".repeat(64), phase: "converting" });
  await assert.rejects(
    () =>
      apps.registerApp({
        role: "writer",
        repo,
        owner: "acme",
        ownerType: "Organization",
        store,
        log: () => assert.fail("An ambiguous conversion must not start another browser flow"),
        fetcher: async () => assert.fail("An ambiguous conversion must not contact GitHub"),
      }),
    /uncertain|recover|duplicate/i,
  );
});

test("an already registered App resumes installation without converting another manifest", async () => {
  const saved = { ...app(), installed: false, phase: "registered", state: "c".repeat(64) };
  const store = memoryStore(saved);
  let verified = 0;
  const value = await apps.registerApp({
    role: "writer",
    repo,
    owner: "acme",
    ownerType: "Organization",
    store,
    log: () => {},
    timeoutMs: 5000,
    fetcher: async (url) => {
      assert.equal(url, "https://api.github.com/repos/acme/service/installation");
      verified++;
      return Response.json(installation());
    },
    openBrowser: async (url) => {
      const start = await fetch(url, { redirect: "manual" });
      assert.equal(start.status, 302);
      const callback = new URL(
        `/installed/writer?state=${saved.state}&installation_id=untrusted`,
        url,
      );
      assert.equal((await fetch(callback)).status, 200);
    },
  });
  assert.equal(value.id, saved.id);
  assert.equal(verified, 1);
});

test("setup checkpoints and locks stay private inside Git metadata", async (t) => {
  const { cwd, store, directory, path } = await metadata(t);
  assert.ok(directory.startsWith(join(cwd, ".git")));
  assert.equal((await lstat(directory)).mode & 0o077, 0);
  assert.equal((await lstat(path)).mode & 0o077, 0);
  assert.equal((await lstat(join(directory, "lock"))).mode & 0o077, 0);
  store.state.apps.writer = app();
  await store.save();
  const loaded = await SetupState.read(repo, cwd);
  assert.equal(loaded.state.apps.writer.id, 101);
  const status = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  assert.equal(status.status, 0);
  assert.equal(status.stdout, "");
});

test("setup rejects a wrong target, malformed checkpoint, permissive mode and concurrent lock", async (t) => {
  const { cwd, store, directory, path } = await metadata(t);
  await assert.rejects(
    () => SetupState.read("another/repository", cwd),
    /target|another|malformed/i,
  );
  const competing = new SetupState(directory, { version: 1, repo, apps: {} });
  await assert.rejects(() => competing.acquire(), /lock/i);
  await store.release();
  await competing.acquire();
  await competing.release();
  await writeFile(path, "{ malformed checkpoint");
  await assert.rejects(() => SetupState.read(repo, cwd), /malformed/i);
  await writeFile(path, JSON.stringify({ version: 1, repo, apps: {} }));
  await chmod(path, 0o644);
  await assert.rejects(() => SetupState.read(repo, cwd), /private|owned|symbolic/i);
});

test("setup never follows checkpoint symlinks into another location", async (t) => {
  const { cwd, store, directory, path } = await metadata(t);
  await store.release();
  const outside = join(cwd, "outside.json");
  const original = JSON.stringify({ version: 1, repo, apps: {} });
  await writeFile(outside, original, { mode: 0o600 });
  await rm(path);
  await symlink(outside, path);
  await assert.rejects(() => SetupState.read(repo, cwd), /private|symbolic/i);
  await assert.rejects(
    () => new SetupState(directory, { version: 1, repo, apps: {} }).acquire(),
    /Unsafe|symbolic|checkpoint/i,
  );
  assert.equal(await readFile(outside, "utf8"), original);
});

test("role tokens are minted only for the target repository and approved publishing grants", async (t) => {
  const { cwd, store, path } = await metadata(t);
  store.state.apps.writer = app();
  await store.save();
  const calls = [];
  const token = await roleToken(repo, "writer", {
    cwd,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      assertAppJwt(options.headers.Authorization.replace(/^Bearer /, ""));
      if (url.endsWith("/installation")) return Response.json(installation());
      assert.equal(url, "https://api.github.com/app/installations/501/access_tokens");
      assert.deepEqual(JSON.parse(options.body), {
        repositories: ["service"],
        permissions: apps.rolePermissions("writer"),
      });
      return Response.json({
        token: "synthetic-installation-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
      });
    },
  });
  assert.equal(token, "synthetic-installation-token");
  assert.equal(calls.length, 2);
  assert.ok(!(await readFile(path, "utf8")).includes("synthetic-installation-token"));
  await assert.rejects(() =>
    roleToken(repo, "release", {
      cwd,
      fetcher: async () => assert.fail("Unsupported roles must not make requests"),
    }),
  );
});

test("missing local identity or wrong target cannot silently provision replacement Apps", async (t) => {
  const { cwd } = await metadata(t);
  const fetcher = async () => assert.fail("Unconfigured publishing must not contact GitHub");
  await assert.rejects(
    () => roleToken(repo, "writer", { cwd, fetcher }),
    /setup|credentials|host/i,
  );
  await assert.rejects(
    () => roleToken("another/repo", "reviewer", { cwd, fetcher }),
    /target|malformed/i,
  );
});

test("setup request failures never expose credentials, callback codes or remote response bodies", async () => {
  for (const fetcher of [
    async () => {
      throw new Error("synthetic-secret-from-transport");
    },
    async () => new Response("synthetic-secret-from-response", { status: 403 }),
    async () => new Response("invalid-json-sensitive-body", { status: 200 }),
  ])
    await assert.rejects(
      () =>
        apps.githubRequest("app-manifests/synthetic-callback-code/conversions", {
          token: "synthetic-private-token",
          method: "POST",
          fetcher,
        }),
      (error) => !/synthetic|sensitive/.test(error.message),
    );
});

test("native model and test processes receive subscription context without GitHub or API credentials", async () => {
  const environment = {
    ...process.env,
    GH_TOKEN: "synthetic-publisher-token",
    GITHUB_TOKEN: "synthetic-job-token",
    PROJECT_TOKEN: "synthetic-project-token",
    OPENAI_API_KEY: "synthetic-openai-key",
    CODEX_API_KEY: "synthetic-codex-key",
    ANTHROPIC_API_KEY: "synthetic-anthropic-key",
    COPILOT_GITHUB_TOKEN: "synthetic-copilot-key",
    CODEX_HOME: "/native/subscription/profile",
  };
  const sanitized = withoutCredentials(environment);
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "PROJECT_TOKEN",
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "ANTHROPIC_API_KEY",
    "COPILOT_GITHUB_TOKEN",
  ])
    assert.equal(sanitized[name], undefined);
  assert.equal(sanitized.CODEX_HOME, environment.CODEX_HOME);
  const child = await command(
    process.execPath,
    [
      "-e",
      "process.stdout.write(JSON.stringify({github:process.env.GH_TOKEN,api:process.env.OPENAI_API_KEY,profile:process.env.CODEX_HOME}))",
    ],
    { env: sanitized },
  );
  assert.deepEqual(JSON.parse(child.stdout), { profile: environment.CODEX_HOME });
  await assert.rejects(
    () =>
      command(process.execPath, [
        "-e",
        "process.stderr.write('synthetic-private-error');process.exit(7)",
      ]),
    (error) => !error.message.includes("synthetic-private-error"),
  );
});

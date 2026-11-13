import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";

const sourceRoot =
  process.env.GRAIT_TEST_SOURCE_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const realGit = realpathSync(
  process.env.PATH.split(":")
    .map((entry) => join(entry, "git"))
    .find((entry) => existsSync(entry)),
);
const statuses = ["Backlog", "Ready", "In Progress", "Review", "Done"];

export async function setupFixture(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "grait-setup-acceptance-"));
  await mkdir(join(directory, "bin"));
  await writeFile(join(directory, "bin/package.json"), JSON.stringify({ type: "commonjs" }));
  await mkdir(join(directory, ".github"));
  const git = spawnSync("git", ["init", "--quiet", "--initial-branch=main"], {
    cwd: directory,
    encoding: "utf8",
  });
  if (git.status !== 0) throw new Error("Unable to initialize local acceptance repository");
  await cp(join(sourceRoot, "scripts"), join(directory, "scripts"), { recursive: true });
  await cp(join(sourceRoot, "config"), join(directory, "config"), { recursive: true });
  for (const filename of ["package.json", "package-lock.json", "workflow.config.json", ".npmrc"])
    await cp(join(sourceRoot, filename), join(directory, filename));
  await symlink(join(sourceRoot, "node_modules"), join(directory, "node_modules"), "dir");
  for (const path of [
    "automation",
    ".agents/skills",
    ".claude/agents",
    ".claude/skills",
    ".codex/agents",
    ".codex/config.toml",
  ]) {
    if (existsSync(join(sourceRoot, path))) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await cp(join(sourceRoot, path), join(directory, path), { recursive: true });
    }
  }
  const config = JSON.parse(await readFile(join(directory, "workflow.config.json"), "utf8"));
  config.applicationMarker = "preserve-application-setting";
  if (overrides.configured) {
    config.controllerRepository = "acme/service";
    config.humanOperators = ["operator"];
  }
  await writeFile(join(directory, "workflow.config.json"), JSON.stringify(config));
  await writeFile(
    join(directory, ".github/CODEOWNERS"),
    "# Application ownership\n* @application-owner\n/src/payments/ @acme/payments-team\n",
  );
  const statePath = join(directory, ".git/fixture-state.json");
  const state = {
    actor: { login: "operator", id: 42, type: "User" },
    repository: {
      id: 72,
      node_id: "repo-node",
      name: "service",
      full_name: "acme/service",
      owner: { login: "acme", type: "Organization", id: 73, node_id: "owner-node" },
      permissions: { admin: true, push: true },
      default_branch: "main",
      fork: false,
    },
    variables: [{ name: "AUTOMATION_ENABLED", value: "false" }],
    calls: [],
    commands: [],
    createdProjects: 0,
    ...overrides,
  };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(join(directory, "preload.mjs"), preload);
  await writeFile(join(directory, "bin/gh"), commandStub, { mode: 0o755 });
  for (const name of ["npm", "git", "codex", "claude"])
    await writeFile(join(directory, "bin", name), commandStub, { mode: 0o755 });
  spawnSync("git", ["config", "user.name", "GRAIT Acceptance"], { cwd: directory });
  spawnSync("git", ["config", "user.email", "acceptance@example.invalid"], { cwd: directory });
  if (overrides.localApps) {
    await mkdir(join(directory, ".git/grait-setup"), { mode: 0o700 });
    await writeFile(
      join(directory, ".git/grait-setup/session.json"),
      JSON.stringify({
        version: 1,
        repo: "acme/service",
        enabled: Boolean(overrides.localEnabled),
        apps: overrides.localApps,
      }),
      { mode: 0o600 },
    );
  }
  await writeFile(join(directory, ".gitignore"), "node_modules\n");
  const added = spawnSync("git", ["add", "--all"], { cwd: directory, encoding: "utf8" });
  const committed = spawnSync(
    "git",
    [
      "-c",
      "user.name=GRAIT Acceptance",
      "-c",
      "user.email=acceptance@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "test: prepare isolated setup fixture",
    ],
    { cwd: directory, encoding: "utf8" },
  );
  if (added.status !== 0 || committed.status !== 0)
    throw new Error("Unable to commit local acceptance fixture");
  const baseEnvironment = {
    ...process.env,
    PATH: `${join(directory, "bin")}:${process.env.PATH}`,
    GH_TOKEN: "synthetic-setup-token",
    GITHUB_TOKEN: "",
    PROJECT_TOKEN: "synthetic-project-token",
    GH_HOST: "github.com",
    GITHUB_API_URL: "https://api.github.com",
    GRAIT_SETUP_FIXTURE_STATE: statePath,
    GRAIT_FIXTURE_REAL_GIT: realGit,
    NODE_OPTIONS: `--import=${join(directory, "preload.mjs")}`,
    GH_AW_BINARY: "",
    CI: "true",
  };
  return {
    directory,
    config,
    async state() {
      return JSON.parse(await readFile(statePath, "utf8"));
    },
    async run(entry, args = [], { input = "", env = {} } = {}) {
      const result = spawnSync(process.execPath, [join(directory, "scripts", entry), ...args], {
        cwd: directory,
        env: { ...baseEnvironment, ...env },
        input,
        timeout: 30_000,
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      });
      if (result.error) throw result.error;
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    },
    async read(path) {
      return readFile(join(directory, path), "utf8");
    },
    async update(changes) {
      const current = JSON.parse(await readFile(statePath, "utf8"));
      await writeFile(statePath, JSON.stringify({ ...current, ...changes }));
    },
    async localState() {
      return JSON.parse(await readFile(join(directory, ".git/grait-setup/session.json"), "utf8"));
    },
    git(args) {
      const result = spawnSync(realGit, args, { cwd: directory, encoding: "utf8" });
      if (result.status !== 0) throw new Error("Local fixture Git command failed");
      return result.stdout.trim();
    },
    async close() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export const bootstrapArguments = [
  "--repo",
  "acme/service",
  "--project-owner",
  "acme",
  "--maintainers",
  "operator",
  "--writer-login",
  "grait-writer[bot]",
  "--reviewer-login",
  "grait-reviewer[bot]",
  "--apply",
];

const preload = `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const statePath = process.env.GRAIT_SETUP_FIXTURE_STATE;
const statuses = ${JSON.stringify(statuses)};
const save = state => writeFileSync(statePath, JSON.stringify(state));
globalThis.fetch = async (url, options = {}) => {
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const parsed = new URL(url);
  if (parsed.hostname !== "api.github.com") throw new Error("Live network disabled in acceptance tests");
  const path = parsed.pathname.replace(/^\\//, "");
  const method = options.method || "GET";
  const body = options.body ? JSON.parse(options.body) : undefined;
  const bearer = options.headers?.Authorization || "";
  const identity = bearer.includes("synthetic-writer-installation") ? "writer" : bearer.includes("synthetic-reviewer-installation") ? "reviewer" : "human";
  state.calls.push({ path, method, body, identity, query: parsed.search });
  let value;
  let status = 200;
  if (method === "GET" && path === "apps/github-actions") value = { id: 7, slug: "github-actions" };
  else if (method === "GET" && path === "user") value = state.actor;
  else if (method === "GET" && path.startsWith("users/")) {
    const login = path.split("/")[1];
    value = login === "acme" ? state.repository.owner : { login, id: 42, type: "User", node_id: "human-node" };
  }
  else if (method === "GET" && path === "repos/acme/service") value = state.repository;
  else if (method === "GET" && path === "repos/acme/service/actions/variables") value = { variables: state.variables };
  else if (method === "GET" && path === "repos/acme/service/actions/secrets") value = { secrets: state.secrets || [] };
  else if (method === "GET" && path.endsWith("/environments/release/secrets")) value = { secrets: state.releaseSecrets || [] };
  else if (method === "GET" && path === "repos/acme/service/installation") {
    const jwt = bearer.replace(/^Bearer /, "");
    let issuer;
    try { issuer = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url")).iss; } catch { issuer = "unknown"; }
    const role = String(issuer).includes("reviewer") ? "reviewer" : "writer";
    const saved = state.localApps?.[role];
    value = { id: (saved?.id || 100) + 1000, app_id: saved?.id || 100, account: { login: "acme" }, suspended_at: null, permissions: { contents: role === "writer" ? "write" : "read", issues: "write", pull_requests: "write", metadata: "read", ...(role === "writer" ? { statuses: "write" } : {}) } };
  }
  else if (method === "POST" && path.startsWith("app/installations/") && path.endsWith("/access_tokens")) {
    const role = path.includes("1200") ? "reviewer" : "writer";
    value = { token: "synthetic-" + role + "-installation", expires_at: new Date(Date.now() + 3600000).toISOString() };
  }
  else if (method === "GET" && path === "repos/acme/service/pulls") value = state.pullRequests || [];
  else if (method === "POST" && path === "repos/acme/service/pulls") {
    value = { number: 99, html_url: "https://github.com/acme/service/pull/99", user: { login: identity === "writer" ? "grait-writer[bot]" : "operator" }, ...body };
    state.pullRequests = [...(state.pullRequests || []), value];
  }
  else if (method === "GET" && path === "repos/acme/service/commits/main") value = { sha: "a".repeat(40) };
  else if (method === "GET" && path === "repos/acme/service/actions/workflows/ci.yml/runs") value = { workflow_runs: state.ciRuns || [{ head_sha: "a".repeat(40), conclusion: "success" }] };
  else if (method === "GET" && path.startsWith("repos/acme/service/contents/")) {
    const name = path.split("/contents/")[1];
    const content = name === "workflow.config.json" && state.remoteConfiguration !== undefined ? state.remoteConfiguration : name === ".github/CODEOWNERS" && state.remoteOwners !== undefined ? state.remoteOwners : readFileSync(join(process.cwd(), name), "utf8");
    value = { content: Buffer.from(content).toString("base64") };
  }
  else if (path === "graphql") {
    const query = body.query;
    const project = { id: "project-node", number: 12, url: "https://github.com/orgs/acme/projects/12", shortDescription: "[agent-controller:acme/service]" };
    if (query.includes("createProjectV2(")) {
      state.createdProjects += 1;
      value = { data: { createProjectV2: { projectV2: project } } };
    } else if (query.includes("items(first:")) value = { data: { node: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } };
    else if (query.includes("fields(first:")) {
      if (state.failProjectDetails) {
        status = 503;
        value = { message: "Synthetic interrupted setup" };
      } else value = { data: { node: { ...project, fields: { nodes: [{ id: "status-node", name: "Status", options: statuses.map(name => ({ id: name, name })) }] }, views: { nodes: [{ id: "view-node", name: "Kanban", layout: "BOARD_LAYOUT" }] } } } };
    } else if (query.includes("repositoryOwner(")) value = { data: { repositoryOwner: { projectV2: project } } };
    else if (query.includes("node(id:")) value = { data: { node: project } };
    else value = { data: { ok: true } };
  }
  else if (method === "GET" && path === "repos/acme/service/rulesets") value = state.rules || [];
  else if (method === "GET" && path === "repos/acme/service/labels") value = [];
  else if (method === "GET" && path.startsWith("apps/")) {
    const slug = path.slice(5);
    value = { id: slug.includes("reviewer") ? 200 : 100, slug, owner: state.repository.owner };
  }
  else if (method === "GET" && path === "repos/acme/service/issues/900/comments") {
    value = [{ id: 901, user: { login: "operator" }, body: '<!-- workflow-state:v1 -->\\n\\n' + '\\u0060\\u0060\\u0060json\\n' + JSON.stringify({ version: 1, number: 900, reservations: [{ operation: "preserved" }] }) + '\\n\\u0060\\u0060\\u0060' }];
  }
  else if (method === "POST" && path === "repos/acme/service/actions/variables") {
    state.variables.push(body);
    value = {};
  }
  else if (method === "PATCH" && path.startsWith("repos/acme/service/actions/variables/")) {
    const name = path.split("/").at(-1);
    const found = state.variables.find(item => item.name === name);
    if (found) found.value = body.value;
    else state.variables.push({ name, value: body.value });
    value = {};
  }
  else if (method === "PATCH" && path === "repos/acme/service") value = {};
  else if (["POST", "PUT", "PATCH"].includes(method) && /^repos\\/acme\\/service\\/(rulesets|labels|environments)/.test(path)) value = {};
  else {
    status = 404;
    value = { message: "Unsupported local acceptance route" };
  }
  save(state);
  return Response.json(value, { status });
};
`;

const commandStub = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const { basename } = require("node:path");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
const statePath = process.env.GRAIT_SETUP_FIXTURE_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const command = basename(process.argv[1]);
state.commands.push({ command, args, identity: process.env.GH_TOKEN === "synthetic-writer-installation" ? "writer" : "human", credentialNames: ["GH_TOKEN", "GITHUB_TOKEN", "PROJECT_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"].filter(name => process.env[name]) });
writeFileSync(statePath, JSON.stringify(state));
if (command === "git") {
  if (args.includes("push")) { if (state.failPush) process.exit(9); process.stdout.write("Synthetic branch push completed\\n"); process.exit(0); }
  const result = spawnSync(process.env.GRAIT_FIXTURE_REAL_GIT, args, { env: process.env, encoding: "utf8" });
  process.stdout.write(result.stdout || ""); process.stderr.write(result.stderr || ""); process.exit(result.status === null ? 1 : result.status);
}
if (command === "npm") { if (state.failTooling === args.join(" ")) process.exit(9); process.stdout.write("Local tooling check completed\\n"); process.exit(0); }
if (["codex", "claude"].includes(command)) {
  if ((command === "codex" && args[0] === "login" && args.length === 1) || (command === "claude" && args[1] === "login")) {
    state.nativeLoginCount = (state.nativeLoginCount || 0) + 1;
    if (state.afterLoginStatus) { state.nativeStatus = state.afterLoginStatus; state.nativeStatusCode = 0; }
    writeFileSync(statePath, JSON.stringify(state));
    process.exit(0);
  }
  const status = state.nativeStatus || (command === "codex" ? "Logged in using ChatGPT" : JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiKeySource: null }));
  process.stdout.write(status + "\\n"); process.exit(state.nativeStatusCode || 0);
}
if (args[0] === "--version") process.stdout.write("gh version 2.80.0\\n");
else if (args[0] === "auth" && args[1] === "token") process.stdout.write("synthetic-setup-token\\n");
else if (args[0] === "auth") process.exit(0);
else if (args[0] === "api" && args[1] === "user") process.stdout.write(JSON.stringify(state.actor));
else if (args[0] === "repo" && args[1] === "view") process.stdout.write(JSON.stringify({ ...state.repository, nameWithOwner: state.repository.full_name, owner: state.repository.owner, viewerPermission: state.repository.permissions.admin ? "ADMIN" : "WRITE", isFork: state.repository.fork, parent: state.repository.parent }));
else if (args[0] === "aw" && args[1] === "version") process.stdout.write("gh aw version v1.2.2\\n");
else if (args[0] === "extension" && args[1] === "list") process.stdout.write(JSON.stringify([{ name: "gh-aw", version: "v1.2.2" }]));
else if (args[0] === "secret" && args[1] === "list") process.stdout.write(JSON.stringify(state.secrets || []));
else if (args[0] === "variable" && args[1] === "list") process.stdout.write(JSON.stringify(state.variables));
else { process.stderr.write("Unexpected external command in local setup test\\n"); process.exit(2); }
`;

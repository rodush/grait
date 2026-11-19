// scripts/activate.mjs
import { readFile as readFile2 } from "node:fs/promises";
import { execFile } from "node:child_process";
import { parseArgs, promisify } from "node:util";

// scripts/lib/github.mjs
var GitHub = class {
  constructor(
    token,
    { fetcher = fetch, apiUrl = process.env.GITHUB_API_URL || "https://api.github.com" } = {},
  ) {
    if (!token) throw new Error("A GitHub token is required");
    this.token = token;
    this.fetcher = fetcher;
    this.apiUrl = apiUrl.replace(/\/$/, "");
  }
  async request(path, { method = "GET", body, binary = false } = {}) {
    const response = await this.fetcher(`${this.apiUrl}/${path.replace(/^\//, "")}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
      },
      body: body === void 0 ? void 0 : JSON.stringify(body),
      signal: AbortSignal.timeout(3e4),
    });
    if (!response.ok) {
      const error = new Error(`GitHub ${method} ${path.split("?")[0]} returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return binary
      ? Buffer.from(await response.arrayBuffer())
      : response.status === 204
        ? null
        : response.json();
  }
  async list(path, key) {
    const values = [];
    for (let page = 1; page <= 1e3; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.request(`${path}${separator}per_page=100&page=${page}`);
      const batch = key ? response[key] : response;
      if (!Array.isArray(batch)) throw new Error(`Invalid paginated response for ${path}`);
      values.push(...batch);
      if (batch.length < 100) return values;
    }
    throw new Error(`Pagination limit reached for ${path}`);
  }
  async graphql(query, variables = {}) {
    const response = await this.request("graphql", { method: "POST", body: { query, variables } });
    if (response.errors?.length || !response.data)
      throw new Error("GitHub GraphQL returned an incomplete result");
    return response.data;
  }
};

// scripts/lib/setup-state.mjs
import { mkdir, open, readFile, rename, unlink, lstat, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

// scripts/lib/setup-process.mjs
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";
async function command(program, args = [], options = {}) {
  const {
    input,
    interactive = false,
    allowFailure = false,
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = interactive ? 0 : 6e5,
  } = options;
  return new Promise((resolve2, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      shell: false,
      stdio: interactive ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const collect = (chunk, channel) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 8 * 1024 * 1024) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      if (channel === "out") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout?.on("data", (chunk) => collect(chunk, "out"));
    child.stderr?.on("data", (chunk) => collect(chunk, "err"));
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error(`Unable to run ${program}; check that it is installed and accessible`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut || exceeded)
        reject(new Error(`${program} exceeded its execution or output limit`));
      else if (code !== 0 && !allowFailure)
        reject(
          new Error(
            `${program} command failed (exit ${code ?? "signal"}); resolve the reported setup step and rerun`,
          ),
        );
      else resolve2({ stdout, stderr, code });
    });
    child.stdin?.on("error", () => {});
    if (!interactive) child.stdin?.end(input);
  });
}

// scripts/lib/setup-state.mjs
var roles = /* @__PURE__ */ new Set(["writer", "reviewer", "release"]);
function validate(state, repo) {
  if (
    state.version !== 1 ||
    state.repo?.toLowerCase() !== repo.toLowerCase() ||
    !state.apps ||
    typeof state.apps !== "object" ||
    Array.isArray(state.apps)
  )
    throw new Error(
      "Setup recovery state is malformed or belongs to another target; inspect Git metadata before continuing",
    );
  if (state.enabled !== void 0 && typeof state.enabled !== "boolean")
    throw new Error("Local activation state must be boolean");
  if (
    state.port !== void 0 &&
    (!Number.isInteger(state.port) || state.port < 1024 || state.port > 65535)
  )
    throw new Error("Invalid setup callback port in recovery state");
  for (const [role, app] of Object.entries(state.apps)) {
    if (
      !roles.has(role) ||
      !app ||
      typeof app !== "object" ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(app.name || "")
    )
      throw new Error("Invalid App recovery state; refusing to provision replacements");
    if (
      app.id !== void 0 &&
      (!Number.isSafeInteger(app.id) ||
        app.id < 1 ||
        !/^[a-z0-9-]+$/.test(app.slug || "") ||
        typeof app.clientId !== "string")
    )
      throw new Error("Invalid App identity in setup recovery state");
    if (
      app.pem !== void 0 &&
      (typeof app.pem !== "string" || !app.pem.startsWith("-----BEGIN ") || app.pem.length > 2e4)
    )
      throw new Error("Invalid private credential in setup recovery state");
    if (app.state !== void 0 && !/^[a-f0-9]{64}$/.test(app.state))
      throw new Error("Invalid browser state in setup checkpoint");
  }
  return state;
}
var SetupState = class _SetupState {
  static async location(cwd = process.cwd()) {
    const result = await command("git", ["rev-parse", "--git-common-dir"], { cwd });
    return join(resolve(cwd, result.stdout.trim()), "grait-setup");
  }
  static async read(repo, cwd = process.cwd()) {
    const directory = await _SetupState.location(cwd);
    const path = join(directory, "session.json");
    try {
      const directoryInfo = await lstat(directory);
      const info = await lstat(path);
      if (
        !directoryInfo.isDirectory() ||
        directoryInfo.isSymbolicLink() ||
        !info.isFile() ||
        info.isSymbolicLink() ||
        directoryInfo.mode & 63 ||
        info.mode & 63 ||
        (directoryInfo.uid !== void 0 &&
          process.getuid &&
          directoryInfo.uid !== process.getuid()) ||
        (info.uid !== void 0 && process.getuid && info.uid !== process.getuid())
      )
        throw new Error(
          "Setup recovery files must be private, owned by you, and not symbolic links",
        );
      if (info.size > 2e5) throw new Error("Setup recovery state exceeds the supported size");
      return { directory, state: validate(JSON.parse(await readFile(path, "utf8")), repo) };
    } catch (error) {
      if (error.code === "ENOENT") return { directory, state: { version: 1, repo, apps: {} } };
      if (error instanceof SyntaxError)
        throw new Error(
          "Setup recovery state is malformed; inspect Git metadata before continuing",
        );
      throw error;
    }
  }
  constructor(directory, state) {
    this.directory = directory;
    this.state = state;
    this.lock = null;
  }
  async acquire() {
    await mkdir(this.directory, { recursive: true, mode: 448 });
    const info = await lstat(this.directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.mode & 63 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Setup metadata directory must be private and not a symbolic link");
    const path = join(this.directory, "lock");
    try {
      this.lock = await open(
        path,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        384,
      );
      await this.lock.writeFile(String(process.pid));
    } catch (error) {
      if (this.lock) {
        await this.lock.close();
        this.lock = null;
        await unlink(path);
      }
      if (error.code !== "EEXIST") throw error;
      throw new Error(
        "Setup/orchestrator lock already exists. Stop the owning process first; inspect and remove a stale lock manually before retrying.",
      );
    }
    try {
      try {
        const info2 = await lstat(join(this.directory, "session.json"));
        if (
          !info2.isFile() ||
          info2.isSymbolicLink() ||
          info2.mode & 63 ||
          (process.getuid && info2.uid !== process.getuid())
        )
          throw new Error("Unsafe setup checkpoint path");
        const current = validate(
          JSON.parse(await readFile(join(this.directory, "session.json"), "utf8")),
          this.state.repo,
        );
        if (JSON.stringify(current) !== JSON.stringify(this.state))
          throw new Error(
            "Setup state changed before the lock was acquired; reload and retry instead of overwriting another session",
          );
      } catch (error) {
        if (error instanceof SyntaxError)
          throw new Error(
            "Setup recovery state is malformed; inspect Git metadata before continuing",
          );
        if (error.code !== "ENOENT") throw error;
      }
      await this.save();
    } catch (error) {
      await this.release();
      throw error;
    }
  }
  async save() {
    validate(this.state, this.state.repo);
    const path = join(this.directory, "session.json");
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe setup checkpoint path");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = join(this.directory, `session-${randomBytes(12).toString("hex")}.tmp`);
    const file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      384,
    );
    try {
      await file.writeFile(`${JSON.stringify(this.state, null, 2)}
`);
      await file.sync();
      await file.close();
      await rename(temporary, path);
      await chmod(path, 384);
    } finally {
      await file.close();
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
  async release() {
    if (!this.lock) return;
    await this.lock.close();
    this.lock = null;
    await unlink(join(this.directory, "lock"));
  }
};

// scripts/lib/setup-apps.mjs
import { randomBytes as randomBytes2, sign, timingSafeEqual } from "node:crypto";
var appRoles = {
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
function rolePermissions(role, organizationProject = false) {
  const definition = appRoles[role];
  if (!definition) throw new Error("Unsupported setup App role");
  return {
    ...definition.permissions,
    ...(role === "writer" && organizationProject ? { organization_projects: "write" } : {}),
  };
}
function appJwt(app, now = Date.now()) {
  const seconds = Math.floor(now / 1e3);
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
async function githubRequest(
  path,
  {
    token,
    method = "GET",
    body,
    fetcher = fetch,
    apiUrl = process.env.GITHUB_API_URL || "https://api.github.com",
  } = {},
) {
  let response;
  try {
    response = await fetcher(`${apiUrl.replace(/\/$/, "")}/${path.replace(/^\//, "")}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: body === void 0 ? void 0 : JSON.stringify(body),
      signal: AbortSignal.timeout(3e4),
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
async function verifyInstallation(
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

// scripts/lib/local-auth.mjs
async function roleToken(repo, role, { cwd = process.cwd(), fetcher = fetch } = {}) {
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

// scripts/lib/project.mjs
var Project = class {
  constructor(api, id, statuses) {
    this.api = api;
    this.id = id;
    this.statuses = statuses;
    this.items = [];
  }
  async load() {
    const { node } = await this.api.graphql(
      `query($id: ID!) {
      node(id: $id) { ... on ProjectV2 {
        id title shortDescription
        fields(first: 100) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }
      } }
    }`,
      { id: this.id },
    );
    if (!node) throw new Error("Configured project is inaccessible");
    this.controller = node.shortDescription?.match(/\[agent-controller:([^\]]+)\]/)?.[1];
    this.field = node.fields.nodes.find((field) => field.name === "Status");
    if (
      !this.field ||
      Object.values(this.statuses).some(
        (name) => !this.field.options.some((option) => option.name === name),
      )
    )
      throw new Error("Project is missing the configured Status options");
    let cursor = null;
    this.items = [];
    do {
      const { node: project } = await this.api.graphql(
        `query($id: ID!, $cursor: String) {
        node(id: $id) { ... on ProjectV2 {
          items(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes {
            id isArchived
            fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
            content {
              __typename
              ... on Issue { id number title body state stateReason repository { nameWithOwner } }
              ... on DraftIssue { id title }
            }
          } }
        } }
      }`,
        { id: this.id, cursor },
      );
      if (!project) throw new Error("Project became inaccessible while reading items");
      this.items.push(
        ...project.items.nodes.map((item) => ({ ...item, status: item.fieldValueByName?.name })),
      );
      cursor = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
    } while (cursor);
    return this;
  }
  find(repo, number) {
    return this.items.find(
      (item) =>
        !item.isArchived &&
        item.content?.__typename === "Issue" &&
        item.content.repository.nameWithOwner.toLowerCase() === repo.toLowerCase() &&
        item.content.number === number,
    );
  }
  async add(issue, repo) {
    const existing = this.find(repo, issue.number);
    if (existing) return existing;
    const data = await this.api.graphql(
      `mutation($project: ID!, $content: ID!) {
      addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
    }`,
      { project: this.id, content: issue.node_id },
    );
    const item = {
      id: data.addProjectV2ItemById.item.id,
      isArchived: false,
      content: { __typename: "Issue", ...issue, repository: { nameWithOwner: repo } },
    };
    this.items.push(item);
    await this.move(item, this.statuses.backlog);
    return item;
  }
  async move(item, status) {
    if (item.status === status) return;
    const option = this.field.options.find((entry) => entry.name === status);
    if (!option) throw new Error(`Unknown project status ${status}`);
    await this.api.graphql(
      `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
    }`,
      { project: this.id, item: item.id, field: this.field.id, option: option.id },
    );
    item.status = status;
  }
};

// scripts/lib/tdd.mjs
import { matchesGlob } from "node:path";
var TDD_ROLES = ["tester", "implementer"];
function root(pattern) {
  if (
    typeof pattern !== "string" ||
    !/^(?:[\w.-]+\/)*[\w.-]+(?:\/\*\*)?$/.test(pattern) ||
    pattern.includes("..")
  )
    throw new Error("TDD paths must be exact repository paths or directory/** scopes");
  return pattern.replace(/\/\*\*$/, "");
}
function matchesPath(path, pattern) {
  if (
    typeof path !== "string" ||
    !path ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    return false;
  const prefix = root(pattern);
  return path === prefix || (pattern.endsWith("/**") && path.startsWith(prefix + "/"));
}
function testerWritePatterns(config) {
  const patterns = config.tdd.testPatterns || config.tdd.testPaths;
  const result = [];
  for (const scope of config.allowedWritePaths) {
    const prefix = root(scope);
    for (const pattern of patterns) {
      if (!scope.endsWith("/**")) {
        if (matchesGlob(scope, pattern)) result.push(scope);
        continue;
      }
      if (pattern.startsWith("**/")) result.push(`${prefix}/${pattern}`);
      else {
        const literal = pattern.split(/[?*[{]/)[0];
        if (literal.startsWith(prefix + "/")) result.push(pattern);
        else if (prefix.startsWith(literal) && pattern.includes("*"))
          throw new Error(
            `Ambiguous test pattern ${pattern} inside ${scope}; use a global **/ pattern`,
          );
      }
    }
  }
  return [...new Set(result)];
}
function validateTddConfig(config) {
  const tdd = config.tdd;
  if (
    !tdd ||
    !Array.isArray(tdd.testPatterns || tdd.testPaths) ||
    !(tdd.testPatterns || tdd.testPaths).length ||
    !Array.isArray(tdd.implementationPaths) ||
    !tdd.implementationPaths.length
  )
    throw new Error("Configure explicit tester and implementer write scopes");
  if (tdd.testPatterns) {
    if (
      tdd.testPatterns.some(
        (pattern) =>
          typeof pattern !== "string" ||
          !pattern ||
          pattern.startsWith("/") ||
          pattern.includes("..") ||
          pattern.includes("\\") ||
          !/^[\w./*?{}\[\],-]+$/.test(pattern),
      )
    )
      throw new Error("Invalid testPatterns glob");
    if (!testerWritePatterns(config).length)
      throw new Error("No test patterns intersect the write allowlist");
  }
  for (const group of [tdd.testPatterns ? [] : tdd.testPaths, tdd.implementationPaths])
    for (const pattern of group) {
      root(pattern);
      if (
        !config.allowedWritePaths.some(
          (scope) =>
            matchesPath(root(pattern), scope) &&
            (!pattern.endsWith("/**") || scope.endsWith("/**")),
        )
      )
        throw new Error("TDD scopes must stay inside the repository write allowlist");
      if (
        config.protectedPaths.some(
          (scope) =>
            matchesPath(root(pattern), scope.endsWith("/") ? scope + "**" : scope) ||
            matchesPath(scope.replace(/\/$/, ""), pattern),
        )
      )
        throw new Error("TDD scopes cannot include protected policy");
    }
  for (const test of tdd.testPatterns ? [] : tdd.testPaths)
    for (const code of tdd.implementationPaths)
      if (matchesPath(root(test), code) || matchesPath(root(code), test))
        throw new Error("Tester and implementer write scopes must be disjoint");
  for (const role of TDD_ROLES) {
    const profile = tdd.profiles?.[role];
    if (!profile || Object.keys(profile).some((key) => !["model", "reasoning"].includes(key)))
      throw new Error("TDD role profiles accept only model and reasoning overrides");
    for (const value of Object.values(profile))
      if (value !== null && (typeof value !== "string" || !/^[\w./:-]+$/.test(value)))
        throw new Error("Invalid TDD model or reasoning override");
  }
  return tdd;
}

// scripts/lib/policy.mjs
import { createHash } from "node:crypto";
var digest = (value) => createHash("sha256").update(value).digest("hex");
var sameLogin = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
function validateConfig(config) {
  if (config.schemaVersion !== 2 || config.execution !== "local")
    throw new Error(
      "Use schema version 2 with local harness execution; follow docs/installation.md to migrate",
    );
  if (
    !config.labels?.admitted ||
    Object.values(config.labels).length !== new Set(Object.values(config.labels)).size
  )
    throw new Error("Distinct admission and control labels are required");
  if (
    !Array.isArray(config.supportedEngines) ||
    config.supportedEngines.length !== 3 ||
    !["codex", "claude", "copilot"].every((engine) => config.supportedEngines.includes(engine)) ||
    !config.supportedEngines.includes(config.engine)
  )
    throw new Error("Choose the Codex, Claude Code, or GitHub Copilot CLI local harness");
  if (
    !Number.isInteger(config.maxConcurrentWorkers) ||
    config.maxConcurrentWorkers < 1 ||
    config.maxConcurrentWorkers > 5
  )
    throw new Error("Configure one to five concurrent local workers");
  if (!["low", "medium", "high"].includes(config.orchestrator?.reasoning))
    throw new Error("Configure the orchestrator reasoning level");
  if (
    config.maxInProgress !== 5 ||
    config.maxReviewRounds !== 10 ||
    config.maxRepeatedBlockingReviews !== 3
  ) {
    throw new Error("Workflow limits must match the approved five-story, ten-round policy");
  }
  if (new Set(Object.values(config.statuses)).size !== 5)
    throw new Error("Exactly five distinct statuses are required");
  if (
    !config.allowedWritePaths?.length ||
    config.allowedWritePaths.some(
      (path) => path === "**" || path.startsWith("/") || path.includes(".."),
    )
  ) {
    throw new Error("Explicit repository-relative write paths are required");
  }
  for (const pattern of config.allowedWritePaths) {
    if (!/^(?:[\w.-]+\/)*[\w.-]+(?:\/\*\*)?$/.test(pattern))
      throw new Error("Use exact file paths or directory/** write scopes");
    const scope = pattern.replace(/\/\*\*$/, "");
    const directory = pattern.endsWith("/**");
    for (const protectedPath of config.protectedPaths) {
      const protectedRoot = protectedPath.replace(/\/$/, "");
      if (
        scope === protectedRoot ||
        (directory && protectedRoot.startsWith(scope + "/")) ||
        (protectedPath.endsWith("/") && scope.startsWith(protectedRoot + "/"))
      ) {
        throw new Error(`Write scope ${pattern} overlaps protected policy ${protectedPath}`);
      }
    }
  }
  if (config.tdd) {
    validateTddConfig(config);
    if (
      config.engine === "copilot" &&
      Object.values(config.tdd.profiles).some((profile) => profile.model?.includes("/"))
    )
      throw new Error(
        "Copilot profiles must select Copilot-served models, not provider-qualified BYOK models",
      );
  }
  return config;
}

// scripts/lib/bootstrap.mjs
async function resolveActionsAppId(api) {
  const app = await api.request("apps/github-actions");
  if (
    app?.slug !== "github-actions" ||
    typeof app.id !== "number" ||
    !Number.isSafeInteger(app.id) ||
    app.id <= 0
  )
    throw new Error(
      "Invalid GitHub Actions publisher metadata: expected github-actions and a positive safe integer App ID",
    );
  return app.id;
}
function repositoryRules(actors, statusAppId, releaseAppId, actionsAppId) {
  if (typeof actionsAppId !== "number" || !Number.isSafeInteger(actionsAppId) || actionsAppId <= 0)
    throw new Error(
      "A resolved positive safe integer GitHub Actions App ID is required for the CI publisher binding",
    );
  const conditions = { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } };
  return [
    {
      name: "Required delivery gates",
      target: "branch",
      enforcement: "active",
      bypass_actors: [],
      conditions,
      rules: [
        { type: "deletion" },
        { type: "non_fast_forward" },
        { type: "required_linear_history" },
        {
          type: "pull_request",
          parameters: {
            required_approving_review_count: 1,
            dismiss_stale_reviews_on_push: true,
            require_code_owner_review: true,
            require_last_push_approval: true,
            required_review_thread_resolution: true,
            allowed_merge_methods: ["squash"],
          },
        },
        {
          type: "required_status_checks",
          parameters: {
            strict_required_status_checks_policy: true,
            required_status_checks: [
              { context: "Template validation", integration_id: actionsAppId },
              {
                context: "Agent review",
                ...(statusAppId ? { integration_id: Number(statusAppId) } : {}),
              },
            ],
          },
        },
      ],
    },
    {
      // Human actors bypass only update restriction, never the independent delivery-gate ruleset.
      name: "Human merge authority",
      target: "branch",
      enforcement: "active",
      conditions,
      bypass_actors: actors.map((actor) => ({
        actor_id: actor.id,
        actor_type: "User",
        bypass_mode: "pull_request",
      })),
      rules: [{ type: "update" }],
    },
    {
      name: "Release tag creation",
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
      bypass_actors: releaseAppId
        ? [{ actor_id: Number(releaseAppId), actor_type: "Integration", bypass_mode: "always" }]
        : actors.map((actor) => ({
            actor_id: actor.id,
            actor_type: "User",
            bypass_mode: "always",
          })),
      rules: [{ type: "creation" }],
    },
    {
      name: "Immutable release tags",
      target: "tag",
      enforcement: "active",
      conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
      bypass_actors: [],
      rules: [{ type: "update" }, { type: "deletion" }],
    },
  ];
}

// scripts/lib/ruleset-setup.mjs
import { createInterface as createInterface2 } from "node:readline";
function pending() {
  const error = new Error(
    "Ruleset configuration is pending. Rerun the same command after completing the configuration, or add --acknowledge-unenforced-rules to explicitly continue without verified GitHub enforcement. The overall setup --yes flag does not acknowledge this choice.",
  );
  error.code = "RULESET_SETUP_PENDING";
  return error;
}
async function ask() {
  if (!process.stdin.isTTY) return null;
  const terminal = createInterface2({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve2) => {
      terminal.once("close", () => resolve2(null));
      terminal.once("SIGINT", () => terminal.close());
      terminal.question(
        "Complete the configuration, then type completed to verify it; type continue to acknowledge unenforced rules, or pause to resume later: ",
        resolve2,
      );
    });
  } finally {
    terminal.close();
  }
}
function matches(actual, expected) {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value) => actual.some((item) => matches(item, value)))
    );
  if (expected && typeof expected === "object")
    return (
      actual &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) => matches(actual[key], value))
    );
  return actual === expected;
}
async function configureRepositoryRules({
  api,
  repo,
  rules,
  phase,
  acknowledgeUnenforced = false,
  prompt = ask,
  log = console.log,
}) {
  if (!["stage", "activate"].includes(phase)) throw new Error("Invalid ruleset setup phase");
  let expected = rules.map((rule) => ({
    ...rule,
    enforcement: phase === "stage" && rule.target === "branch" ? "disabled" : "active",
  }));
  let failure;
  try {
    const existingRules = await api.list(`repos/${repo}/rulesets`);
    expected = expected.map((rule) => {
      const existing = existingRules.find(
        (item) => item.name === rule.name && sameLogin(item.source, repo),
      );
      return {
        ...rule,
        enforcement:
          phase === "stage" && rule.target === "branch"
            ? existing?.enforcement || "disabled"
            : "active",
      };
    });
    for (const rule of expected) {
      const existing = existingRules.find(
        (item) => item.name === rule.name && sameLogin(item.source, repo),
      );
      if (!existing && phase === "activate") throw new Error("Missing staged ruleset");
      await api.request(
        existing ? `repos/${repo}/rulesets/${existing.id}` : `repos/${repo}/rulesets`,
        { method: existing ? "PUT" : "POST", body: rule },
      );
    }
    return { enforcement: phase === "stage" ? "staged" : "active" };
  } catch (error) {
    failure = error;
  }
  const explain = (error) => {
    const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599;
    log(
      status
        ? `GitHub ruleset configuration returned HTTP ${error.status}.`
        : "GitHub ruleset configuration could not be completed or verified.",
    );
    log(`Manual configuration: https://github.com/${repo}/settings/rules`);
    log(
      "Create or update each named ruleset using the exact JSON configuration below (import each object separately), including its enforcement setting. Branch rules remain staged until activation.",
    );
    for (const rule of expected) log(JSON.stringify(rule, null, 2));
    log(
      "GitHub Free private repositories do not support rulesets through the API or settings UI. If unavailable, you may explicitly continue without verified GitHub enforcement; rulesets can be configured later on a supported plan. Other errors may require correcting permissions, configuration, or connectivity before retrying.",
    );
    log(
      "Human approval and merge remain mandatory: agents must never merge PRs or release. Continuing does not verify server-side enforcement; some rules may already have been applied.",
    );
    log(
      "To deliberately continue without verified rulesets in a noninteractive session, rerun the same command with --acknowledge-unenforced-rules. The overall setup --yes flag only accepts the original plan and does not acknowledge unenforced rules.",
    );
  };
  explain(failure);
  if (!acknowledgeUnenforced) {
    for (;;) {
      const answer = (await prompt())?.trim().toLowerCase();
      if (answer === "continue") break;
      if (answer === "completed") {
        try {
          const existingRules = await api.list(`repos/${repo}/rulesets`);
          for (const rule of expected) {
            const existing = existingRules.find(
              (item) => item.name === rule.name && sameLogin(item.source, repo),
            );
            if (!existing) throw new Error("Missing manually configured ruleset");
            const actual = await api.request(`repos/${repo}/rulesets/${existing.id}`);
            if (!matches(actual, rule)) throw new Error("Manual ruleset configuration differs");
          }
          log("Manual ruleset configuration verified.");
          return { enforcement: phase === "stage" ? "staged" : "active" };
        } catch (error) {
          explain(error);
        }
      } else if (!answer || answer === "pause") {
        throw pending();
      } else {
        log("Choose completed, continue, or pause. No acknowledgement has been recorded.");
      }
    }
  }
  log(
    "Explicit acknowledgement received: continuing with unenforced rules (GitHub enforcement is not fully verified). Human approval and human merge are still required; agents never merge or release.",
  );
  return { enforcement: "unenforced" };
}

// scripts/activate.mjs
var store;
try {
  const { values } = parseArgs({
    options: { "acknowledge-unenforced-rules": { type: "boolean" } },
  });
  const localText = await readFile2("workflow.config.json", "utf8");
  const config = validateConfig(JSON.parse(localText));
  if (!config.controllerRepository || !config.humanOperators.length)
    throw new Error("Run bootstrap and configure human operators first");
  const { directory, state } = await SetupState.read(config.controllerRepository);
  store = new SetupState(directory, state);
  await store.acquire();
  const token =
    process.env.GH_TOKEN ||
    (await promisify(execFile)("gh", ["auth", "token"], { encoding: "utf8" })).stdout.trim();
  const api = new GitHub(token);
  const actionsAppId = await resolveActionsAppId(api);
  const repo = config.controllerRepository;
  const repository = await api.request(`repos/${repo}`);
  const operator = await api.request("user");
  if (
    operator.type !== "User" ||
    !config.humanOperators.some((login) => sameLogin(login, operator.login)) ||
    !repository.permissions?.admin
  )
    throw new Error("Activation requires a configured human repository administrator");
  const head = await api.request(
    `repos/${repo}/commits/${encodeURIComponent(repository.default_branch)}`,
  );
  const ci = await api.list(
    `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${head.sha}&event=push`,
    "workflow_runs",
  );
  if (!ci.some((run) => run.head_sha === head.sha && run.conclusion === "success"))
    throw new Error(
      "Successful CI on the current default-branch head is required before activation",
    );
  const remote = await api.request(
    `repos/${repo}/contents/workflow.config.json?ref=${encodeURIComponent(repository.default_branch)}`,
  );
  if (digest(Buffer.from(remote.content, "base64")) !== digest(localText))
    throw new Error("Commit the configured files to the default branch before activation");
  const variables = new Map(
    (await api.list(`repos/${repo}/actions/variables`, "variables")).map((item) => [
      item.name,
      item.value,
    ]),
  );
  for (const name of ["PROJECT_ID", "AUTOMATION_LOGIN", "REVIEW_LOGIN"])
    if (!variables.get(name)) throw new Error(`Missing repository variable ${name}`);
  if (
    ![
      ["writer", "AUTOMATION_LOGIN"],
      ["reviewer", "REVIEW_LOGIN"],
    ].every(
      ([role, name]) =>
        state.apps[role]?.slug && sameLogin(`${state.apps[role].slug}[bot]`, variables.get(name)),
    )
  )
    throw new Error("Host publishing identities differ from the repository's recorded Apps");
  if (
    sameLogin(variables.get("AUTOMATION_LOGIN"), variables.get("REVIEW_LOGIN")) ||
    config.humanOperators.some(
      (login) =>
        sameLogin(login, variables.get("AUTOMATION_LOGIN")) ||
        sameLogin(login, variables.get("REVIEW_LOGIN")),
    )
  )
    throw new Error("Human, implementation, and review identities must be separate");
  await roleToken(repo, "writer");
  await roleToken(repo, "reviewer");
  const projectToken = process.env.PROJECT_TOKEN || token;
  const project = await new Project(
    new GitHub(projectToken),
    variables.get("PROJECT_ID"),
    config.statuses,
  ).load();
  if (!sameLogin(project.controller, repo))
    throw new Error("Project is bound to a different orchestrator");
  const owners = await api.request(
    `repos/${repo}/contents/.github/CODEOWNERS?ref=${encodeURIComponent(repository.default_branch)}`,
  );
  const ownerText = Buffer.from(owners.content, "base64").toString();
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
  async function recordEnforcement(value) {
    await api.request(
      variables.has("RULESET_ENFORCEMENT")
        ? `repos/${repo}/actions/variables/RULESET_ENFORCEMENT`
        : `repos/${repo}/actions/variables`,
      {
        method: variables.has("RULESET_ENFORCEMENT") ? "PATCH" : "POST",
        body: { name: "RULESET_ENFORCEMENT", value },
      },
    );
    variables.set("RULESET_ENFORCEMENT", value);
    store.state.rulesetEnforcement = value;
    await store.save();
  }
  await recordEnforcement("pending");
  const { enforcement } = await configureRepositoryRules({
    api,
    repo,
    rules: repositoryRules(
      actors,
      state.apps.writer.id,
      variables.get("RELEASE_APP_ID"),
      actionsAppId,
    ),
    phase: "activate",
    acknowledgeUnenforced: Boolean(values["acknowledge-unenforced-rules"]),
  });
  await recordEnforcement(enforcement);
  await api.request(`repos/${repo}/actions/variables/AUTOMATION_ENABLED`, {
    method: "PATCH",
    body: { name: "AUTOMATION_ENABLED", value: "true" },
  });
  store.state.enabled = true;
  await store.save();
  console.log(
    enforcement === "active"
      ? "Delivery rules are active. Start the subscription-backed local orchestrator with npm run orchestrator -- start."
      : "Host activated with unenforced rules. Human approval and human merge remain required. Start the local orchestrator with npm run orchestrator -- start.",
  );
} catch (error) {
  console.error(error.message);
  console.error(
    "Activation did not complete. Inspect rulesets and AUTOMATION_ENABLED before retrying.",
  );
  process.exitCode = error.code === "RULESET_SETUP_PENDING" ? 2 : 1;
} finally {
  await store?.release();
}

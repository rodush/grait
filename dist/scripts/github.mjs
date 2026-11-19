// scripts/github.mjs
import { parseArgs } from "node:util";
import { readFile as readFile3 } from "node:fs/promises";

// scripts/lib/local-context.mjs
import { readFile as readFile2 } from "node:fs/promises";

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
function isTestPath(path, config) {
  return (
    !!path &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => !part || part === "." || part === "..") &&
    (config.tdd.testPatterns || config.tdd.testPaths).some((pattern) => matchesGlob(path, pattern))
  );
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
function assertRoleChanges(files, role, config) {
  const tdd = validateTddConfig(config);
  const scopes =
    role === "tester"
      ? config.allowedWritePaths
      : role === "implementer"
        ? tdd.implementationPaths
        : null;
  if (!scopes) throw new Error("Unknown TDD role");
  for (const file of files) {
    if (!file.filename) throw new Error("Missing changed filename");
    for (const path of [file.filename, file.previous_filename].filter(Boolean))
      if (
        !scopes.some((scope) => matchesPath(path, scope)) ||
        config.protectedPaths.some((scope) =>
          matchesPath(path, scope.endsWith("/") ? scope + "**" : scope),
        ) ||
        (role === "tester" ? !isTestPath(path, config) : isTestPath(path, config))
      )
        throw new Error(`${role} cannot change ${path}`);
  }
}
function validateTddExemption(value) {
  if (!value || typeof value.required !== "boolean" || (!value.required && !value.reason?.trim()))
    throw new Error("A TDD exemption requires an explicit reason");
  return value;
}

// scripts/lib/policy.mjs
import { createHash } from "node:crypto";
var digest = (value) => createHash("sha256").update(value).digest("hex");
var issueDigest = (issue) => digest(JSON.stringify([issue.title, issue.body || ""]));
var sameLogin = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
function parseBlock(body, name) {
  const matches = [
    ...(body || "").matchAll(new RegExp("```" + name + "\\s*\\n([\\s\\S]*?)\\n```", "g")),
  ];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${name} metadata block`);
  return JSON.parse(matches[0][1]);
}
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
function validateTriage(data, issue) {
  if (data.version !== 1 || data.issue !== issue.number || data.digest !== issueDigest(issue))
    throw new Error("Stale or invalid triage attestation");
  if (
    typeof data.ready !== "boolean" ||
    !Array.isArray(data.blockers) ||
    !Array.isArray(data.questions)
  )
    throw new Error("Invalid triage metadata");
  for (const ref of data.blockers) {
    if (typeof ref !== "string" || !/^[\w.-]+\/[\w.-]+#[1-9]\d*$/.test(ref))
      throw new Error("Invalid blocker reference");
  }
  if (issue && data.ready && data.tdd !== void 0) validateTddExemption(data.tdd);
  const checklist = ["scope", "acceptance", "validation", "dependencies", "alignment"];
  if (
    data.ready &&
    (data.questions.length || !checklist.every((key) => data.checklist?.[key] === true))
  ) {
    throw new Error("Ready requires a complete triage checklist and no open questions");
  }
  return data;
}
function validateReview(data, review, { number, head, round }) {
  if (
    data.version !== 1 ||
    data.pr !== number ||
    data.head !== head ||
    review.commit_id !== head ||
    data.round !== round
  ) {
    throw new Error("Review metadata does not match the requested PR revision and round");
  }
  if (!["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(data.verdict))
    throw new Error("Invalid review verdict");
  const expectedState =
    data.verdict === "APPROVE"
      ? "APPROVED"
      : data.verdict === "REQUEST_CHANGES"
        ? "CHANGES_REQUESTED"
        : "COMMENTED";
  if (review.state !== expectedState)
    throw new Error("Review verdict differs from GitHub's recorded decision");
  if (
    !Array.isArray(data.blockers) ||
    data.blockers.some((id) => typeof id !== "string" || !id || id.length > 200)
  )
    throw new Error("Invalid blocker IDs");
  if (new Set(data.blockers).size !== data.blockers.length)
    throw new Error("Duplicate blocker IDs");
  if (typeof data.rethink !== "boolean" || typeof data.conflicts !== "boolean")
    throw new Error("Review must state rethink and conflicts explicitly");
  if (data.verdict === "APPROVE" && (data.blockers.length || data.rethink || data.conflicts))
    throw new Error("Approval cannot contain blocking findings");
  if (
    data.verdict === "REQUEST_CHANGES" &&
    !data.blockers.length &&
    !data.rethink &&
    !data.conflicts
  )
    throw new Error("Changes requested requires a blocking reason");
  return data;
}
function patchDigest(files) {
  const changes = files.map((file) => [
    file.filename,
    file.status,
    file.previous_filename || "",
    (file.patch || "")
      .split("\n")
      .filter((line) => line.startsWith("+") || line.startsWith("-"))
      .join("\n"),
    file.sha,
  ]);
  return digest(JSON.stringify(changes.sort((a, b) => a[0].localeCompare(b[0]))));
}
function loopDecision(history, config) {
  const current = history.at(-1);
  if (!current) return { action: "review" };
  if (current.conflicts)
    return { action: "pause", reason: "Conflicting reviewer instructions require human judgment" };
  if (history.length >= config.maxReviewRounds && current.verdict !== "APPROVE")
    return { action: "pause", reason: "Ten review rounds exhausted" };
  if (current.verdict === "APPROVE") return { action: "human-merge" };
  if (current.verdict === "COMMENT" && !current.blockers.length && !current.rethink)
    return { action: "pause", reason: "Reviewer needs human input or additional evidence" };
  if (
    history.at(-2)?.patch !== current.patch &&
    history.slice(0, -2).some((entry) => entry.patch === current.patch)
  )
    return {
      action: "pause",
      reason: "A previous code state recurred; automatic changes would oscillate",
    };
  const recent = history.slice(-config.maxRepeatedBlockingReviews);
  if (
    recent.length === config.maxRepeatedBlockingReviews &&
    current.fixAttempts - recent[0].fixAttempts >= 2 &&
    current.blockers.some((id) => recent.every((entry) => entry.blockers.includes(id)))
  ) {
    return { action: "pause", reason: "The same blocking finding survived two fix attempts" };
  }
  return { action: current.rethink ? "rethink" : "fix" };
}
function availableSlots(items, config) {
  const active = items.filter(
    (item) =>
      !item.isArchived &&
      item.content?.__typename !== "PullRequest" &&
      item.status === config.statuses.inProgress,
  );
  return Math.max(0, config.maxInProgress - active.length);
}
function dependencyComplete(issue) {
  return (
    issue.state?.toLowerCase() === "closed" &&
    (issue.state_reason === "completed" || issue.stateReason === "COMPLETED")
  );
}
function assertAcyclic(graph) {
  const visiting = /* @__PURE__ */ new Set();
  const visited = /* @__PURE__ */ new Set();
  function visit(node) {
    if (visiting.has(node)) throw new Error(`Blocking dependency cycle includes ${node}`);
    if (visited.has(node)) return;
    visiting.add(node);
    for (const dependency of graph.get(node) || []) visit(dependency);
    visiting.delete(node);
    visited.add(node);
  }
  for (const node of graph.keys()) visit(node);
}
function conventionalTitle(title) {
  return /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-zA-Z0-9._/-]+\))?!?: .+/.test(
    title || "",
  );
}

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
function withoutCredentials(environment = process.env) {
  const result = { ...environment };
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "PROJECT_TOKEN",
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "COPILOT_GITHUB_TOKEN",
    "CODEX_ACCESS_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "AUTOMATION_TOKEN",
    "REVIEW_TOKEN",
    "AUTOMATION_APP_PRIVATE_KEY",
    "REVIEW_APP_PRIVATE_KEY",
    "RELEASE_APP_PRIVATE_KEY",
    "RELEASE_TOKEN",
  ])
    delete result[name];
  for (const name of Object.keys(result))
    if (
      name.startsWith("COPILOT_PROVIDER_") ||
      ["COPILOT_PROVIDERS_CONFIG", "COPILOT_MODEL", "COPILOT_OFFLINE"].includes(name)
    )
      delete result[name];
  return result;
}

// scripts/lib/setup-apps.mjs
import { randomBytes, sign, timingSafeEqual } from "node:crypto";
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

// scripts/lib/setup-state.mjs
import { mkdir, open, readFile, rename, unlink, lstat, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes as randomBytes2 } from "node:crypto";
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
    const temporary = join(this.directory, `session-${randomBytes2(12).toString("hex")}.tmp`);
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

// scripts/lib/local-auth.mjs
async function humanToken() {
  return process.env.GH_TOKEN || (await command("gh", ["auth", "token"])).stdout.trim();
}
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

// scripts/lib/local-context.mjs
async function localContext({ reviewer = false, setupReview = false } = {}) {
  const config = validateConfig(JSON.parse(await readFile2("workflow.config.json", "utf8")));
  const repo = config.controllerRepository;
  if (!repo) throw new Error("Run npm run setup first");
  const { directory, state } = await SetupState.read(repo);
  if (!state.enabled && !setupReview)
    throw new Error("This host is not activated. Follow docs/installation.md");
  const store = new SetupState(directory, state);
  await store.acquire();
  try {
    const humanApi = new GitHub(await humanToken());
    if (setupReview) {
      const actor = await humanApi.request("user");
      if (
        !reviewer ||
        actor.type !== "User" ||
        !config.humanOperators.some((login) => login.toLowerCase() === actor.login.toLowerCase())
      )
        throw new Error(
          "Staged setup review requires a configured human operator and the reviewer publishing operation",
        );
    }
    const variables = new Map(
      (await humanApi.list(`repos/${repo}/actions/variables`, "variables")).map((item) => [
        item.name,
        item.value,
      ]),
    );
    if (
      ![
        ["writer", "AUTOMATION_LOGIN"],
        ["reviewer", "REVIEW_LOGIN"],
      ].every(
        ([role, name]) =>
          state.apps[role]?.slug && sameLogin(`${state.apps[role].slug}[bot]`, variables.get(name)),
      )
    )
      throw new Error(
        "Host publishing identities differ from the repository's recorded Apps; reconcile before starting work",
      );
    if (variables.get("AUTOMATION_ENABLED") !== "true" && !setupReview)
      throw new Error("Repository automation is paused");
    const project = await new Project(
      new GitHub(process.env.PROJECT_TOKEN || (await humanToken())),
      variables.get("PROJECT_ID"),
      config.statuses,
    ).load();
    const api = new GitHub(await roleToken(repo, "writer"));
    return {
      config,
      repo,
      api,
      humanApi,
      project,
      writer: variables.get("AUTOMATION_LOGIN"),
      reviewer: variables.get("REVIEW_LOGIN"),
      reviewerApi: reviewer ? new GitHub(await roleToken(repo, "reviewer")) : void 0,
      store,
    };
  } catch (error) {
    await store.release();
    throw error;
  }
}

// scripts/lib/orchestrator.mjs
import { randomUUID } from "node:crypto";

// scripts/lib/ledger.mjs
var STATE_MARKER = "<!-- workflow-state:v1 -->";
var Ledger = class {
  constructor(api, repo, login) {
    this.api = api;
    this.repo = repo;
    this.login = login;
    this.entries = /* @__PURE__ */ new Map();
  }
  async load(number) {
    if (this.entries.has(number)) return this.entries.get(number);
    const comments = await this.api.list(`repos/${this.repo}/issues/${number}/comments`);
    const matches = comments.filter(
      (comment2) =>
        sameLogin(comment2.user.login, this.login) && comment2.body.startsWith(STATE_MARKER),
    );
    if (matches.length > 1)
      throw new Error(`Multiple controller ledgers on #${number}; human reconciliation required`);
    const comment = matches[0];
    const state = comment ? parseBlock(comment.body, "json") : { version: 1, number };
    if (state.version !== 1 || state.number !== number)
      throw new Error(`Invalid controller ledger on #${number}`);
    const entry = { state, comments, comment, saved: JSON.stringify(state) };
    this.entries.set(number, entry);
    return entry;
  }
  async save(number) {
    const entry = await this.load(number);
    const serialized = JSON.stringify(entry.state);
    if (serialized === entry.saved) return;
    const body = `${STATE_MARKER}
Automation state for #${number}. Changes and stop reasons are visible here.

\`\`\`json
${JSON.stringify(entry.state, null, 2)}
\`\`\`
`;
    entry.comment = await this.api.request(
      entry.comment
        ? `repos/${this.repo}/issues/comments/${entry.comment.id}`
        : `repos/${this.repo}/issues/${number}/comments`,
      {
        method: entry.comment ? "PATCH" : "POST",
        body: { body },
      },
    );
    entry.saved = serialized;
  }
};

// scripts/lib/orchestrator.mjs
var labels = (item) =>
  (item.labels || []).map((label) => (typeof label === "string" ? label : label.name));
var LocalOrchestrator = class {
  constructor({ api, reviewerApi, project, repo, writer, reviewer, config }) {
    if (!sameLogin(config.controllerRepository, repo) || !sameLogin(project.controller, repo))
      throw new Error("Repository and Project must be bound to this orchestrator");
    if (
      !writer ||
      !reviewer ||
      sameLogin(writer, reviewer) ||
      config.humanOperators.some((login) => sameLogin(login, writer) || sameLogin(login, reviewer))
    )
      throw new Error("Human, writer, and reviewer identities must be separate");
    Object.assign(this, { api, reviewerApi, project, repo, writer, reviewer, config });
    this.ledger = new Ledger(api, repo, writer);
  }
  async issue(number) {
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("A positive issue number is required");
    const issue = await this.api.request(`repos/${this.repo}/issues/${number}`);
    if (issue.pull_request || issue.state?.toLowerCase() !== "open")
      throw new Error("An open issue is required");
    await this.admit(issue);
    return issue;
  }
  async admit(item) {
    const names = labels(item);
    if (names.includes(this.config.labels.paused) || names.includes(this.config.labels.needsHuman))
      throw new Error("Work is paused or needs human resolution");
    if (
      this.config.humanOperators.some((login) => sameLogin(login, item.user?.login)) ||
      sameLogin(item.user?.login, this.writer) ||
      names.includes(this.config.labels.admitted)
    )
      return;
    if (item.user?.login && ["OWNER", "MEMBER", "COLLABORATOR"].includes(item.author_association)) {
      const permission = await this.api.request(
        `repos/${this.repo}/collaborators/${encodeURIComponent(item.user.login)}/permission`,
      );
      if (["admin", "maintain", "write"].includes(permission.permission)) return;
    }
    throw new Error("An outside submission requires maintainer admission");
  }
  async blockers(repo, number) {
    return this.api.list(`repos/${repo}/issues/${number}/dependencies/blocked_by`);
  }
  checkState(state) {
    if (state.pending)
      throw new Error(
        "A legacy hosted operation is still pending; stop its run and reconcile its evidence before local work",
      );
    if (state.paused) throw new Error("Work is paused; reconcile its recorded reason first");
  }
  reference(issue) {
    const repo =
      issue.repository?.full_name ||
      issue.repository?.nameWithOwner ||
      issue.repository_url?.split("/repos/")[1];
    if (!repo || !Number.isSafeInteger(issue.number))
      throw new Error("Dependency identity is inaccessible");
    return `${repo}#${issue.number}`;
  }
  async ready(number, assessment) {
    const issue = await this.issue(number);
    validateTriage(assessment, issue);
    const actual = await this.blockers(this.repo, number);
    const refs = actual.map((item2) => this.reference(item2)).sort();
    if (
      JSON.stringify(refs.map((ref) => ref.toLowerCase())) !==
      JSON.stringify([...new Set(assessment.blockers)].sort().map((ref) => ref.toLowerCase()))
    )
      throw new Error("Triage blockers must match the native GitHub blocking dependencies");
    const graph = /* @__PURE__ */ new Map();
    const visit = async (repo, id) => {
      const key = `${repo.toLowerCase()}#${id}`;
      if (graph.has(key)) return;
      const dependencies = await this.blockers(repo, id);
      const next = dependencies.map((item2) => this.reference(item2).toLowerCase());
      graph.set(key, next);
      for (const ref of next) {
        const [owner, child] = ref.split("#");
        await visit(owner, Number(child));
      }
    };
    await visit(this.repo, number);
    assertAcyclic(graph);
    const { state } = await this.ledger.load(number);
    this.checkState(state);
    if (state.claim) throw new Error("An active claim must be reconciled before re-triage");
    const existing = this.project.find(this.repo, number);
    if (
      existing &&
      ![this.config.statuses.backlog, this.config.statuses.ready].includes(existing.status)
    )
      throw new Error("Active work must be reconciled before re-triage");
    state.triagedDigest = issueDigest(issue);
    state.triage = assessment;
    await this.ledger.save(number);
    const item = await this.project.add(issue, this.repo);
    await this.project.move(
      item,
      assessment.ready ? this.config.statuses.ready : this.config.statuses.backlog,
    );
    return { ready: assessment.ready, digest: state.triagedDigest };
  }
  async claim(number) {
    const issue = await this.issue(number);
    const { state } = await this.ledger.load(number);
    this.checkState(state);
    if (state.triagedDigest !== issueDigest(issue) || state.triage?.ready !== true)
      throw new Error("Fresh accepted triage is required before claiming");
    const item = this.project.find(this.repo, number);
    if (!item) throw new Error("Issue must be in the configured Project");
    const blockers = await this.blockers(this.repo, number);
    if (!blockers.every(dependencyComplete))
      throw new Error("Blocking dependencies must be completed successfully");
    const refs = blockers.map((item2) => this.reference(item2).toLowerCase()).sort();
    if (
      JSON.stringify(refs) !==
      JSON.stringify(state.triage.blockers.map((ref) => ref.toLowerCase()).sort())
    )
      throw new Error("Blocking dependencies changed; triage again");
    if (state.claim) {
      if (![this.config.statuses.inProgress, this.config.statuses.review].includes(item.status))
        throw new Error("Recorded claim and Project status disagree; reconcile before retrying");
      return state.claim;
    }
    if (item.status !== this.config.statuses.ready)
      throw new Error("Only Ready issues can be claimed");
    if (
      this.project.items.some(
        (entry) =>
          !entry.isArchived &&
          entry.content?.__typename !== "PullRequest" &&
          entry.status === this.config.statuses.review,
      )
    )
      throw new Error(
        "Finish existing Review stories before claiming new work; resolve pending reviews, fixes, or human/external waits first",
      );
    if (!availableSlots(this.project.items, this.config))
      throw new Error("The five-story In Progress capacity is exhausted");
    if (state.pendingClaim)
      throw new Error(
        "An earlier claim has an uncertain result; reconcile its Project status before retrying",
      );
    state.pendingClaim = { id: randomUUID(), digest: state.triagedDigest };
    await this.ledger.save(number);
    await this.project.move(item, this.config.statuses.inProgress);
    state.claim = {
      issue: number,
      branch: `agent/issue-${number}`,
      digest: state.triagedDigest,
      at: /* @__PURE__ */ new Date().toISOString(),
    };
    delete state.pendingClaim;
    await this.ledger.save(number);
    return state.claim;
  }
  async review(number, data) {
    if (!Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40}$/.test(data.head))
      throw new Error("Review requires a positive PR number and exact head SHA");
    const pr = await this.api.request(`repos/${this.repo}/pulls/${number}`);
    await this.admit(pr);
    if (
      pr.state !== "open" ||
      pr.draft ||
      pr.head?.sha !== data.head ||
      data.pr !== number ||
      sameLogin(pr.user?.login, this.reviewer)
    )
      throw new Error(
        "Review requires an open ready PR at the exact requested head and an independent reviewer",
      );
    const { state } = await this.ledger.load(number);
    this.checkState(state);
    if (
      state.reviews &&
      state.history &&
      JSON.stringify(state.reviews) !== JSON.stringify(state.history)
    )
      throw new Error("Conflicting local and legacy review histories require human reconciliation");
    const history = state.reviews || state.history || [];
    if (history.length >= this.config.maxReviewRounds)
      throw new Error("Ten review rounds exhausted");
    if (history.some((entry) => entry.head === data.head))
      throw new Error("This PR head was already reviewed");
    if (data.round !== history.length + 1)
      throw new Error("Review round does not match the recorded history");
    validateReview(
      data,
      {
        commit_id: data.head,
        state: { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" }[
          data.verdict
        ],
      },
      { number, head: data.head, round: data.round },
    );
    if (state.pendingReview)
      throw new Error("An earlier review has an uncertain result; inspect GitHub before resuming");
    if (!this.reviewerApi) throw new Error("Reviewer publishing identity is required");
    const comments = data.comments || [];
    if (
      !Array.isArray(comments) ||
      comments.length > 100 ||
      comments.some(
        (comment) =>
          !comment.path ||
          !Number.isInteger(comment.line) ||
          comment.line < 1 ||
          !["LEFT", "RIGHT"].includes(comment.side) ||
          typeof comment.body !== "string",
      )
    )
      throw new Error("Inline findings require a path, diff line, side, and body");
    const files = await this.api.list(`repos/${this.repo}/pulls/${number}/files`);
    if (Number.isInteger(pr.changed_files) && files.length !== pr.changed_files)
      throw new Error("PR diff is incomplete; cannot safely review this revision");
    const linked = (pr.body || "").match(
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9]\d*)\b/i,
    );
    if (linked) {
      const { state: issueState } = await this.ledger.load(Number(linked[1]));
      this.checkState(issueState);
      if (
        issueState.tdd &&
        (issueState.tdd.phase !== "review" || issueState.tdd.head !== pr.head.sha)
      )
        throw new Error("Current-head Green evidence is required before review");
    }
    if (comments.some((comment) => !files.some((file) => file.filename === comment.path)))
      throw new Error("Inline finding is outside the PR diff");
    const metadata = { ...data };
    delete metadata.comments;
    delete metadata.body;
    const body = `${data.body || "Agent review"}

\`\`\`workflow-review
${JSON.stringify(metadata)}
\`\`\``;
    if (Buffer.byteLength(body) > 5e4) throw new Error("Review report is too large");
    state.pendingReview = { head: data.head, round: data.round };
    await this.ledger.save(number);
    const published = await this.reviewerApi.request(`repos/${this.repo}/pulls/${number}/reviews`, {
      method: "POST",
      body: { commit_id: data.head, event: data.verdict, body, comments },
    });
    if (!sameLogin(published.user?.login, this.reviewer))
      throw new Error("Review was not published by the configured reviewer");
    validateReview(data, published, { number, head: data.head, round: data.round });
    history.push({
      ...metadata,
      patch: patchDigest(files),
      fixAttempts: state.fixAttempts || history.at(-1)?.fixAttempts || 0,
    });
    state.reviews = history;
    if (state.history) state.history = history;
    delete state.pendingReview;
    const decision = loopDecision(history, this.config);
    if (decision.action === "pause") {
      state.paused = true;
      state.reason = decision.reason;
    }
    await this.ledger.save(number);
    await this.api.request(`repos/${this.repo}/statuses/${data.head}`, {
      method: "POST",
      body: {
        context: "Agent review",
        state:
          decision.action === "human-merge"
            ? "success"
            : decision.action === "pause"
              ? "error"
              : "failure",
        description:
          decision.action === "human-merge"
            ? "Current revision approved; human merge required"
            : (decision.reason || "Review findings require corrections").slice(0, 140),
      },
    });
    return decision;
  }
  async sync(number) {
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("A positive PR number is required");
    const pr = await this.api.request(`repos/${this.repo}/pulls/${number}`);
    const matches = [
      ...(pr.body || "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9]\d*)\b/gi),
    ];
    const issues = [...new Set(matches.map((match) => Number(match[1])))];
    if (issues.length !== 1)
      throw new Error("PR must close exactly one issue in this repository, using Closes #N");
    const issueNumber = issues[0];
    const { state } = await this.ledger.load(issueNumber);
    if (!state.claim) throw new Error("Linked issue has no accepted claim");
    const item = this.project.find(this.repo, issueNumber);
    if (!item) throw new Error("Claimed issue is missing from the Project");
    if (pr.merged === true) {
      await this.project.move(item, this.config.statuses.done);
      state.completedPR = number;
      await this.ledger.save(issueNumber);
    } else if (pr.state === "closed") {
      return { action: "needs-triage", issue: issueNumber };
    } else {
      await this.admit(pr);
      await this.issue(issueNumber);
      this.checkState(state);
      if (
        !pr.draft &&
        state.tdd &&
        (state.tdd.phase !== "review" || state.tdd.head !== pr.head.sha)
      )
        throw new Error("Current-head Green evidence is required before Review");
      if (
        pr.draft &&
        item.status !== this.config.statuses.inProgress &&
        !availableSlots(this.project.items, this.config)
      )
        throw new Error("Draft work is waiting for In Progress capacity");
      await this.project.move(
        item,
        pr.draft ? this.config.statuses.inProgress : this.config.statuses.review,
      );
    }
    return { issue: issueNumber, status: item.status };
  }
};

// scripts/github.mjs
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      draft: { type: "boolean" },
      issue: { type: "string" },
      title: { type: "string" },
      "body-file": { type: "string" },
    },
  });
  const task = positionals[0];
  if (values.help) {
    console.log(
      "Publish through the local writer App:\n  grait github push --issue N\n  grait github pr --issue N --title 'feat: ...' --body-file PATH [--draft]\nPRs are normal by default and require independent Green for the exact head or an accepted triage TDD exemption. Use --draft only when the user explicitly requests work in progress or early feedback.\nReviews use grait orchestrator review. Merge and release are human-only.",
    );
    return;
  }
  if (!["push", "pr"].includes(task) || !/^[1-9]\d*$/.test(values.issue || ""))
    throw new Error("Choose push or pr and provide --issue N; use --help");
  const context = await localContext();
  try {
    const orchestrator = new LocalOrchestrator(context);
    const claim = await orchestrator.claim(Number(values.issue));
    const branch = (await command("git", ["branch", "--show-current"])).stdout.trim();
    if (branch !== claim.branch || (await command("git", ["status", "--porcelain"])).stdout.trim())
      throw new Error("Publish only committed changes from the claimed issue branch");
    const repository = await context.api.request(`repos/${context.repo}`);
    if (task === "push") {
      const base = (
        await command("git", ["merge-base", "HEAD", `origin/${repository.default_branch}`])
      ).stdout.trim();
      const paths = (
        await command("git", ["diff", "--no-renames", "--name-only", "-z", base, "HEAD"])
      ).stdout
        .split("\0")
        .filter(Boolean);
      if (!paths.length) throw new Error("No committed changes to publish");
      for (const filename of paths) {
        try {
          assertRoleChanges([{ filename }], "tester", context.config);
        } catch {
          assertRoleChanges([{ filename }], "implementer", context.config);
        }
      }
      await command(
        "git",
        [
          "-c",
          "credential.helper=",
          "-c",
          "credential.helper=!gh auth git-credential",
          "push",
          `https://github.com/${context.repo}.git`,
          `HEAD:refs/heads/${branch}`,
        ],
        {
          interactive: true,
          env: { ...withoutCredentials(), GH_TOKEN: context.api.token, GIT_TERMINAL_PROMPT: "0" },
        },
      );
      console.log(`Pushed ${branch} as the writer App.`);
    } else {
      if (!conventionalTitle(values.title) || !values["body-file"])
        throw new Error(
          "Provide a Conventional Commit --title and --body-file with validation evidence",
        );
      const body = await readFile3(values["body-file"], "utf8");
      const head = (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
      const remote = await context.api.request(`repos/${context.repo}/git/ref/heads/${branch}`);
      if (remote.object?.sha !== head)
        throw new Error("Push this exact commit before opening its PR");
      if (!values.draft) {
        const { state } = await orchestrator.ledger.load(Number(values.issue));
        if (
          state.triage?.tdd?.required !== false &&
          (state.tdd?.phase !== "review" || state.tdd.head !== head)
        )
          throw new Error("Independent Green evidence for this exact PR head is required");
      }
      const pr = await context.api.request(`repos/${context.repo}/pulls`, {
        method: "POST",
        body: {
          title: values.title,
          body: `${body}

Closes #${values.issue}`,
          head: branch,
          base: repository.default_branch,
          draft: Boolean(values.draft),
        },
      });
      console.log(pr.html_url);
    }
  } finally {
    await context.store.release();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

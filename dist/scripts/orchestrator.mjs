var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res, err) =>
  function __init() {
    if (err) throw err[0];
    try {
      return (fn && (res = (0, fn[__getOwnPropNames(fn)[0]])((fn = 0))), res);
    } catch (e) {
      throw ((err = [e]), e);
    }
  };
var __export = (target, all) => {
  for (var name in all) __defProp(target, name, { get: all[name], enumerable: true });
};

// scripts/lib/tdd.mjs
import { matchesGlob } from "node:path";
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
function createHandoff({ issue, branch, head, baseline, acceptanceDigest, cycle = 1 }) {
  if (
    !Number.isSafeInteger(issue) ||
    issue < 1 ||
    branch !== `agent/issue-${issue}` ||
    !/^[a-f0-9]{40}$/.test(head) ||
    !/^[a-f0-9]{64}$/.test(acceptanceDigest)
  )
    throw new Error(
      "A TDD handoff must bind the issue, shared branch, commit, and acceptance criteria",
    );
  if (!/^[a-f0-9]{40}$/.test(baseline || "") || !Number.isInteger(cycle) || cycle < 1 || cycle > 10)
    throw new Error("Invalid handoff baseline or cycle");
  return {
    version: 1,
    issue,
    branch,
    head,
    baseline,
    acceptanceDigest,
    cycle,
    owner: "tester",
    phase: "tests",
    evidence: [],
  };
}
function validateEvidence(
  report,
  { issue, acceptanceDigest, head, baseline, expectedFailures, phase },
) {
  if (
    report.issue !== issue ||
    report.acceptanceDigest !== acceptanceDigest ||
    report.head !== head ||
    report.baseline !== baseline ||
    report.phase !== phase ||
    report.baselinePassed !== true ||
    report.infrastructureErrors?.length
  )
    throw new Error("TDD evidence is stale or the baseline/infrastructure failed");
  if (
    !Array.isArray(report.failed) ||
    !Array.isArray(report.passed) ||
    (!report.passed.length && !report.failed.length)
  )
    throw new Error("TDD runner must report executed test identities");
  const identities = [...report.passed, ...report.failed.map((test) => test?.id)];
  if (
    identities.some((id) => typeof id !== "string" || !id.trim()) ||
    new Set(identities).size !== identities.length
  )
    throw new Error(
      `${phase === "green" ? "Green" : "Red"} evidence contains invalid or duplicate test identities`,
    );
  if (phase === "red") {
    if (
      !Array.isArray(expectedFailures) ||
      !expectedFailures.length ||
      new Set(expectedFailures).size !== expectedFailures.length
    )
      throw new Error("Tester must name the expected failing acceptance tests");
    const failures = report.failed.map((test) => test.id).sort();
    if (
      report.failed.some((test) => test.kind !== "assertion") ||
      JSON.stringify(failures) !== JSON.stringify([...expectedFailures].sort())
    )
      throw new Error("Red requires exactly the expected assertion failures");
  } else if (phase !== "green" || report.failed.length)
    throw new Error("Green requires the complete suite to pass");
  if (phase === "green" && expectedFailures?.some((id) => !report.passed.includes(id)))
    throw new Error("Green must execute and pass every accepted test");
  return digest(JSON.stringify(report));
}
function handoffToImplementer(state, report, expectedFailures) {
  if (state.owner !== "tester" || state.phase !== "tests")
    throw new Error("Tester does not own this handoff");
  const evidence = validateEvidence(report, {
    issue: state.issue,
    acceptanceDigest: state.acceptanceDigest,
    head: state.head,
    baseline: state.baseline,
    expectedFailures,
    phase: "red",
  });
  return {
    ...state,
    owner: "implementer",
    phase: "implementation",
    redHead: state.head,
    evidence: [...state.evidence, evidence],
  };
}
function returnToTester(state, reason) {
  if (state.owner !== "implementer" || !reason?.trim())
    throw new Error("A test revision needs an implementer handback reason");
  if (state.cycle >= 10) throw new Error("TDD handoff limit exhausted; human resolution required");
  return {
    ...state,
    owner: "tester",
    phase: "tests",
    cycle: state.cycle + 1,
    reason,
    redHead: null,
  };
}
function completeImplementation(state, report) {
  if (state.owner !== "implementer" || state.phase !== "implementation")
    throw new Error("Implementer does not own this handoff");
  const evidence = validateEvidence(report, {
    issue: state.issue,
    acceptanceDigest: state.acceptanceDigest,
    head: state.head,
    baseline: state.redHead,
    phase: "green",
    expectedFailures: state.expectedFailures,
  });
  return { ...state, owner: null, phase: "review", evidence: [...state.evidence, evidence] };
}
function validateTddExemption(value) {
  if (!value || typeof value.required !== "boolean" || (!value.required && !value.reason?.trim()))
    throw new Error("A TDD exemption requires an explicit reason");
  return value;
}
var TDD_ROLES;
var init_tdd = __esm({
  "scripts/lib/tdd.mjs"() {
    init_policy();
    TDD_ROLES = ["tester", "implementer"];
  },
});

// scripts/lib/policy.mjs
var policy_exports = {};
__export(policy_exports, {
  assertAcyclic: () => assertAcyclic,
  availableSlots: () => availableSlots,
  conventionalTitle: () => conventionalTitle,
  dependencyComplete: () => dependencyComplete,
  digest: () => digest,
  issueDigest: () => issueDigest,
  loopDecision: () => loopDecision,
  parseBlock: () => parseBlock,
  patchDigest: () => patchDigest,
  positiveInteger: () => positiveInteger,
  sameLogin: () => sameLogin,
  validateConfig: () => validateConfig,
  validateReview: () => validateReview,
  validateTriage: () => validateTriage,
});
import { createHash } from "node:crypto";
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
var digest, issueDigest, sameLogin, positiveInteger;
var init_policy = __esm({
  "scripts/lib/policy.mjs"() {
    init_tdd();
    digest = (value) => createHash("sha256").update(value).digest("hex");
    issueDigest = (issue) => digest(JSON.stringify([issue.title, issue.body || ""]));
    sameLogin = (a, b) =>
      typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
    positiveInteger = (value) =>
      /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
  },
});

// scripts/adapters/test-observation.mjs
var test_observation_exports = {};
__export(test_observation_exports, {
  sanitizeObservation: () => sanitizeObservation,
});
function scalar(value) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : "[non-finite value]";
  if (typeof value !== "string") return "[non-scalar value withheld]";
  if (
    /\b(?:function|class|import|require|assert|const|let|return)\b|=>|\bat\s+\S+\s*\(|[\\/][\w.-]+[\\/]|:\d+:\d+/i.test(
      value,
    )
  )
    return "[source or path-like value withheld]";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
}
function sanitizeObservation(value) {
  if (!value || typeof value !== "object") return void 0;
  return {
    operator:
      typeof value.operator === "string" && /^[\w=!<>-]{1,40}$/.test(value.operator)
        ? value.operator
        : "assertion",
    expected: scalar(value.expected),
    observed: scalar(value.observed),
  };
}
var init_test_observation = __esm({
  "scripts/adapters/test-observation.mjs"() {},
});

// scripts/orchestrator.mjs
import { parseArgs } from "node:util";
import { readFile as readFile3, mkdir as mkdir3 } from "node:fs/promises";
import { resolve as resolve2, join as join4, dirname } from "node:path";

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
  return new Promise((resolve3, reject) => {
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
      else resolve3({ stdout, stderr, code });
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
async function requireSubscription(harness, { login = false } = {}) {
  if (!["codex", "claude", "copilot"].includes(harness))
    throw new Error("Choose Codex, Claude Code, or GitHub Copilot CLI");
  if (harness === "copilot") {
    await command("copilot", ["--version"], { env: withoutCredentials() });
    if (login)
      await command("copilot", ["login"], { interactive: true, env: withoutCredentials() });
    return;
  }
  const statusArgs = harness === "codex" ? ["login", "status"] : ["auth", "status"];
  let status = await command(harness, statusArgs, {
    allowFailure: true,
    env: withoutCredentials(),
  });
  if (status.code !== 0 && login) {
    await command(harness, harness === "codex" ? ["login"] : ["auth", "login"], {
      interactive: true,
      env: withoutCredentials(),
    });
    status = await command(harness, statusArgs, { allowFailure: true, env: withoutCredentials() });
  }
  let subscription = false;
  if (harness === "codex")
    subscription = /logged in using ChatGPT/i.test(status.stdout + status.stderr);
  else {
    try {
      const account = JSON.parse(status.stdout);
      subscription = account.loggedIn === true && account.authMethod === "claude.ai";
    } catch {}
  }
  if (status.code !== 0 || !subscription)
    throw new Error(
      "A native subscription login is required. Use codex login or claude auth login to sign in with your plan; API billing or an unrecognized login method is not accepted by this setup",
    );
}

// scripts/lib/orchestrator.mjs
import { randomUUID } from "node:crypto";

// scripts/lib/ledger.mjs
init_policy();
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
init_policy();
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

// scripts/lib/local-context.mjs
init_policy();

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

// scripts/lib/harness-runtime.mjs
function harnessArguments(harness, { prompt, role, profile = {}, reasoning = "medium" }) {
  if (typeof prompt !== "string" || !prompt.trim())
    throw new Error("A native harness prompt is required");
  if (role && !["orchestrator", "triage", "test", "implement", "review", "fix"].includes(role))
    throw new Error("Unknown native role");
  const effort = profile.reasoning || reasoning;
  const model = profile.model ? ["--model", profile.model] : [];
  if (harness === "codex")
    return [
      ...(profile.reasoning
        ? ["-c", `model_reasoning_effort=${JSON.stringify(profile.reasoning)}`]
        : []),
      ...model,
      prompt,
    ];
  if (harness === "claude")
    return [...(role ? ["--agent", `grait-${role}`] : []), "--effort", effort, ...model, prompt];
  if (harness === "copilot") {
    if (profile.model?.includes("/"))
      throw new Error("Choose a Copilot-served model, not a provider-qualified BYOK model");
    return [
      "--agent",
      `grait-${role || "orchestrator"}`,
      "--effort",
      effort,
      "--model",
      profile.model || "auto",
      "--interactive",
      prompt,
    ];
  }
  throw new Error("Unsupported native harness");
}

// scripts/orchestrator.mjs
init_tdd();

// scripts/lib/verification.mjs
import { mkdtemp, mkdir as mkdir2, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";

// scripts/lib/runtime-resources.mjs
import { join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
var runtimeDirectory = true
  ? fileURLToPath(new URL("../", import.meta.url))
  : fileURLToPath(new URL("../../", import.meta.url));
function packageResource(path) {
  return join2(runtimeDirectory, path);
}

// scripts/lib/verification.mjs
init_tdd();
async function verifyCommits({
  root: root2,
  head,
  baseline,
  phase,
  expectedFailures,
  issue,
  acceptanceDigest,
  runner,
}) {
  if (
    ![head, baseline].every((sha) => /^[a-f0-9]{40}$/.test(sha)) ||
    !["red", "green"].includes(phase)
  )
    throw new Error("Verification needs exact committed SHAs and red/green phase");
  for (const args of [runner?.install || [], runner?.command]) {
    if (
      !Array.isArray(args) ||
      args.some((arg) => typeof arg !== "string") ||
      (args === runner?.command && !args.length)
    )
      throw new Error("Configure explicit local test install/command arrays");
  }
  const temporary = await mkdtemp(join3(tmpdir(), "grait-verification-"));
  const binding = { issue, acceptanceDigest, head, baseline, phase };
  try {
    const run = async (sha, name) => {
      const cwd = join3(temporary, name);
      await mkdir2(cwd);
      const archive = join3(temporary, `${name}.tar`);
      await command("git", ["archive", "--format=tar", `--output=${archive}`, sha], { cwd: root2 });
      await command("tar", ["-xf", archive, "-C", cwd]);
      const home = join3(temporary, `${name}-home`);
      await mkdir2(home);
      const env = {
        PATH: process.env.PATH,
        ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: home,
        USERPROFILE: home,
        TMPDIR: home,
        NPM_CONFIG_CACHE: join3(home, "npm-cache"),
        NPM_CONFIG_USERCONFIG: join3(home, "npmrc"),
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
        NPM_CONFIG_MIN_RELEASE_AGE: "3",
        CI: "true",
      };
      if (runner.install?.length)
        await command(runner.install[0], runner.install.slice(1), { cwd, env });
      const args = runner.command.map((arg) =>
        arg.replaceAll("{nodeAdapter}", packageResource("scripts/adapters/node-suite.mjs")),
      );
      const result = await command(args[0], args.slice(1), { cwd, env, allowFailure: true });
      let report2;
      try {
        report2 = JSON.parse(result.stdout);
      } catch {
        throw new Error(
          "Test adapter must emit one bounded JSON report; raw test output is not handed to implementation",
        );
      }
      if (
        !Array.isArray(report2.passed) ||
        !Array.isArray(report2.failed) ||
        !Array.isArray(report2.infrastructureErrors) ||
        Buffer.byteLength(result.stdout) > 1e5
      )
        throw new Error("Test adapter returned an invalid report");
      if (
        ![0, 1].includes(result.code) ||
        (result.code === 0) !== (!report2.failed.length && !report2.infrastructureErrors.length)
      )
        throw new Error("Test adapter report disagrees with its exit status");
      const { sanitizeObservation: sanitizeObservation2 } = await Promise.resolve().then(
        () => (init_test_observation(), test_observation_exports),
      );
      return {
        passed: report2.passed,
        failed: report2.failed.map((test) => ({
          id: test.id,
          kind: test.kind,
          ...(test.observation ? { observation: sanitizeObservation2(test.observation) } : {}),
        })),
        infrastructureErrors: report2.infrastructureErrors,
      };
    };
    const base = await run(baseline, "baseline");
    if (phase === "green")
      validateEvidence(
        { ...base, ...binding, phase: "red", baselinePassed: true },
        { ...binding, phase: "red", expectedFailures },
      );
    else if (base.passed.length || base.failed.length || base.infrastructureErrors.length)
      validateEvidence(
        { ...base, ...binding, phase: "green", baselinePassed: true },
        { ...binding, phase: "green" },
      );
    const report = { ...(await run(head, "candidate")), ...binding, baselinePassed: true };
    validateEvidence(report, { ...binding, expectedFailures });
    return report;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

// scripts/orchestrator.mjs
function skillPath(engine, role) {
  const directory = {
    codex: ".agents/skills",
    claude: ".claude/skills",
    copilot: ".github/skills",
  }[engine];
  return `${directory}/grait-${role}/SKILL.md`;
}
async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean" },
      issue: { type: "string" },
      pr: { type: "string" },
      file: { type: "string" },
      role: { type: "string" },
      phase: { type: "string" },
      expected: { type: "string" },
      reason: { type: "string" },
      "setup-review": { type: "boolean" },
    },
  });
  const task = positionals[0] || "start";
  if (values.help) {
    console.log(
      "Local GRAIT orchestrator\n\nstart                         Launch the native subscription-backed harness\nready --issue N --file JSON    Accept current triage against native blockers\nclaim --issue N                Reserve one of five Project story slots\nworktree --issue N             Prepare/reuse the claimed issue branch\nworker --issue N --role test|implement|fix  Launch a native session at that worktree\nverify --issue N --phase red|green [--expected FILE]  Verify committed snapshots and hand off\nhandoff --issue N --reason TEXT   Return test ownership for a correction\nnext --issue N --pr N          Start an accepted fix/redesign cycle\nready-pr --pr N                Mark the exact Green head ready for review\nreview --pr N --file JSON      Publish exact-head review using the reviewer App\nsync --pr N                   Update Project status; Done requires a merged PR\nstatus                        Show the Project queue\n\nUse one orchestrator host per Project. See docs/operations.md.",
    );
    return;
  }
  if (
    ![
      "start",
      "ready",
      "claim",
      "worktree",
      "worker",
      "verify",
      "handoff",
      "next",
      "ready-pr",
      "review",
      "sync",
      "status",
    ].includes(task)
  )
    throw new Error("Unknown orchestrator operation; use --help");
  if (task === "start") {
    const context2 = await localContext();
    try {
      new LocalOrchestrator(context2);
    } finally {
      await context2.store.release();
    }
    const config = context2.config;
    const env = {
      ...withoutCredentials(),
      ...(config.engine === "copilot"
        ? { COPILOT_SUBAGENT_MAX_CONCURRENT: String(config.maxConcurrentWorkers) }
        : {}),
    };
    await requireSubscription(config.engine);
    await command(
      config.engine,
      harnessArguments(config.engine, {
        role: "orchestrator",
        reasoning: config.orchestrator.reasoning,
        prompt: `Apply the grait-orchestrator skill at ${skillPath(config.engine, "orchestrator")}. Manage this repository's Project queue and delegate specialist sub-agents locally in assigned worktrees. Finish existing Review work before admitting new stories. Use the native subscription login. Check pause state before each stage; humans merge and release.`,
      }),
      { interactive: true, env },
    );
    return;
  }
  const number = Number(values.issue || values.pr);
  if (
    task !== "status" &&
    (!/^[1-9]\d*$/.test(values.issue || values.pr || "") || !Number.isSafeInteger(number))
  )
    throw new Error("Provide a positive --issue or --pr number");
  if (values["setup-review"] && task !== "review")
    throw new Error(
      "--setup-review only publishes an operator-authorized setup review; it cannot start agent work",
    );
  const context = await localContext({
    reviewer: task === "review",
    setupReview: values["setup-review"],
  });
  let launch;
  try {
    const orchestrator = new LocalOrchestrator(context);
    let result;
    if (task === "status")
      result = context.project.items.map((item) => ({
        repository: item.content?.repository?.nameWithOwner,
        issue: item.content?.number,
        title: item.content?.title,
        status: item.status,
      }));
    else if (task === "ready" || task === "review") {
      if (!values.file) throw new Error("Provide --file with the triage assessment or review JSON");
      result = await orchestrator[task](number, JSON.parse(await readFile3(values.file, "utf8")));
    } else if (["verify", "handoff", "next"].includes(task)) {
      await orchestrator.claim(number);
      const { state } = await orchestrator.ledger.load(number);
      const tdd = state.tdd;
      if (!tdd) throw new Error("Prepare the claimed worktree before TDD handoffs");
      const head = (await command("git", ["rev-parse", "HEAD"])).stdout.trim();
      const branch = (await command("git", ["branch", "--show-current"])).stdout.trim();
      if (branch !== tdd.branch || (await command("git", ["status", "--porcelain"])).stdout.trim())
        throw new Error("A handoff requires a clean committed issue branch");
      await command("git", ["merge-base", "--is-ancestor", tdd.head, head]);
      const paths = (
        await command("git", ["diff", "--no-renames", "--name-only", "-z", tdd.head, head])
      ).stdout
        .split("\0")
        .filter(Boolean)
        .map((filename) => ({ filename }));
      if (task === "next") {
        if (!/^[1-9]\d*$/.test(values.pr || ""))
          throw new Error("Provide --pr for the accepted review");
        const pr = await context.api.request(`repos/${context.repo}/pulls/${values.pr}`);
        const { state: reviewState } = await orchestrator.ledger.load(pr.number);
        const decision = (
          await Promise.resolve().then(() => (init_policy(), policy_exports))
        ).loopDecision(reviewState.reviews || [], context.config);
        if (
          pr.head.sha !== head ||
          (pr.head.ref && pr.head.ref !== tdd.branch) ||
          (pr.head.repo?.full_name &&
            pr.head.repo.full_name.toLowerCase() !== context.repo.toLowerCase()) ||
          !(pr.body || "").match(
            new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${number}\\b`, "i"),
          ) ||
          !["fix", "rethink"].includes(decision.action) ||
          reviewState.paused ||
          tdd.phase !== "review" ||
          tdd.head !== head
        )
          throw new Error(
            "A new fix cycle needs an accepted current-head review and the previous Green handoff",
          );
        if (decision.action === "rethink") {
          const item = context.project.find(context.repo, number);
          const { availableSlots: availableSlots2 } = await Promise.resolve().then(
            () => (init_policy(), policy_exports),
          );
          if (
            item.status !== context.config.statuses.inProgress &&
            !availableSlots2(context.project.items, context.config)
          )
            throw new Error("Redesign is waiting for In Progress capacity");
          await context.project.move(item, context.config.statuses.inProgress);
        }
        state.tdd = createHandoff({
          issue: number,
          branch,
          head,
          baseline: head,
          acceptanceDigest: state.triagedDigest,
          cycle: tdd.cycle + 1,
        });
        state.fixPR = pr.number;
      } else {
        assertRoleChanges(paths, tdd.owner, context.config);
        if (task === "handoff") {
          state.tdd = returnToTester({ ...tdd, head }, values.reason);
        } else {
          const phase =
            tdd.owner === "tester" ? "red" : tdd.owner === "implementer" ? "green" : null;
          if (!phase || values.phase !== phase)
            throw new Error("Verification phase must match the current exclusive role owner");
          if (phase === "red" && !values.expected)
            throw new Error(
              "Provide --expected with the JSON array of named assertion-failing acceptance test IDs",
            );
          const expectedFailures =
            phase === "red"
              ? JSON.parse(await readFile3(values.expected, "utf8"))
              : tdd.expectedFailures;
          const report = await verifyCommits({
            root: process.cwd(),
            issue: number,
            acceptanceDigest: tdd.acceptanceDigest,
            head,
            baseline: phase === "red" ? tdd.baseline : tdd.redHead,
            phase,
            expectedFailures,
            runner: context.config.tdd.runner,
          });
          state.tdd =
            phase === "red"
              ? handoffToImplementer({ ...tdd, head, expectedFailures }, report, expectedFailures)
              : completeImplementation({ ...tdd, head }, report);
          if (phase === "green" && state.fixPR) {
            const { state: reviewState } = await orchestrator.ledger.load(state.fixPR);
            reviewState.completedFixHeads ||= [];
            if (!reviewState.completedFixHeads.includes(head)) {
              reviewState.fixAttempts = (reviewState.fixAttempts || 0) + 1;
              reviewState.completedFixHeads.push(head);
            }
            await orchestrator.ledger.save(state.fixPR);
            delete state.fixPR;
          }
          result = { ...state.tdd, report };
        }
      }
      await orchestrator.ledger.save(number);
      result ||= state.tdd;
    } else if (task === "ready-pr") {
      const pr = await context.api.request(`repos/${context.repo}/pulls/${number}`);
      const match = (pr.body || "").match(/\bCloses #([1-9]\d*)\b/i);
      if (!match) throw new Error("PR must link its claimed issue with Closes #N");
      await orchestrator.claim(Number(match[1]));
      const { state } = await orchestrator.ledger.load(Number(match[1]));
      if (
        state.triage?.tdd?.required !== false &&
        (state.tdd?.phase !== "review" || state.tdd.head !== pr.head.sha)
      )
        throw new Error("Independent Green evidence for this exact PR head is required");
      if (pr.draft)
        await context.api.graphql(
          "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { id } } }",
          { id: pr.node_id },
        );
      result = await orchestrator.sync(number);
    } else if (["worktree", "worker"].includes(task)) {
      const claim = await orchestrator.claim(number);
      const common = resolve2(
        (
          await command("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"])
        ).stdout.trim(),
      );
      const path = join4(
        dirname(common),
        "..",
        `${context.repo.split("/")[1]}-worktrees`,
        `issue-${number}`,
      );
      const worktrees = (await command("git", ["worktree", "list", "--porcelain"])).stdout;
      const existing = worktrees.split("\n\n").find(
        (block) =>
          block.includes(`branch refs/heads/${claim.branch}
`) || block.endsWith(`branch refs/heads/${claim.branch}`),
      );
      let target = path;
      if (existing) target = existing.split("\n")[0].slice("worktree ".length);
      else {
        const repository = await context.api.request(`repos/${context.repo}`);
        await command(
          "git",
          ["fetch", `https://github.com/${context.repo}.git`, repository.default_branch],
          { env: withoutCredentials() },
        );
        await mkdir3(dirname(path), { recursive: true });
        await command("git", ["worktree", "add", "-b", claim.branch, path, "FETCH_HEAD"]);
      }
      result = {
        ...claim,
        worktree: target,
        head: (await command("git", ["rev-parse", "HEAD"], { cwd: target })).stdout.trim(),
      };
      const { state } = await orchestrator.ledger.load(number);
      if (!state.tdd && state.triage?.tdd?.required !== false) {
        state.tdd = createHandoff({
          issue: number,
          branch: claim.branch,
          head: result.head,
          baseline: result.head,
          acceptanceDigest: claim.digest,
        });
        await orchestrator.ledger.save(number);
      }
      if (task === "worker") {
        if (!["test", "implement", "fix"].includes(values.role))
          throw new Error("Choose test, implement, or fix");
        if ((await command("git", ["status", "--porcelain"], { cwd: target })).stdout.trim())
          throw new Error("Commit the previous owner's changes before handing over this worktree");
        const expectedOwner = values.role === "test" ? "tester" : "implementer";
        if (state.tdd && state.tdd.owner !== expectedOwner)
          throw new Error("This role does not own the accepted TDD handoff");
        launch = {
          cwd: target,
          prompt: `Apply the grait-${values.role} skill at ${skillPath(context.config.engine, values.role)} for claimed issue #${number}. This is the assigned shared issue worktree. Verify the exact committed handoff and next owner in the issue ledger before writing. Use this branch and worktree for every command. Return committed changes and validation evidence to the orchestrator. Do not create another worktree or edit the other role's files.`,
        };
      }
    } else result = await orchestrator[task](number);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.store.release();
  }
  if (launch) {
    await requireSubscription(context.config.engine);
    const profile = context.config.tdd.profiles[values.role === "test" ? "tester" : "implementer"];
    const args = harnessArguments(context.config.engine, {
      prompt: launch.prompt,
      role: values.role,
      profile,
      reasoning: context.config.orchestrator.reasoning,
    });
    await command(context.config.engine, args, {
      cwd: launch.cwd,
      interactive: true,
      env: {
        ...withoutCredentials(),
        ...(context.config.engine === "copilot"
          ? { COPILOT_SUBAGENT_MAX_CONCURRENT: String(context.config.maxConcurrentWorkers) }
          : {}),
      },
    });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

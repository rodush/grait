import { matchesGlob } from "node:path";
import { digest } from "./policy.mjs";

export const TDD_ROLES = ["tester", "implementer"];

function root(pattern) {
  if (
    typeof pattern !== "string" ||
    !/^(?:[\w.-]+\/)*[\w.-]+(?:\/\*\*)?$/.test(pattern) ||
    pattern.includes("..")
  )
    throw new Error("TDD paths must be exact repository paths or directory/** scopes");
  return pattern.replace(/\/\*\*$/, "");
}

export function matchesPath(path, pattern) {
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

export function testerWritePatterns(config) {
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

export function isTestPath(path, config) {
  return (
    !!path &&
    !path.startsWith("/") &&
    !path.split("/").some((part) => !part || part === "." || part === "..") &&
    (config.tdd.testPatterns || config.tdd.testPaths).some((pattern) => matchesGlob(path, pattern))
  );
}

export function validateTddConfig(config) {
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

export function assertRoleChanges(files, role, config) {
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
    // Both sides of a rename must belong to the same role. Deleting or moving
    // another role's file is a write to that file too.
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

export function createHandoff({ issue, branch, head, baseline, acceptanceDigest, cycle = 1 }) {
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

export function validateEvidence(
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

export function handoffToImplementer(state, report, expectedFailures) {
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

export function returnToTester(state, reason) {
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

export function completeImplementation(state, report) {
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

export function validateTddExemption(value) {
  if (!value || typeof value.required !== "boolean" || (!value.required && !value.reason?.trim()))
    throw new Error("A TDD exemption requires an explicit reason");
  return value;
}

import { createHash } from "node:crypto";

export const digest = (value) => createHash("sha256").update(value).digest("hex");
export const issueDigest = (issue) => digest(JSON.stringify([issue.title, issue.body || ""]));
export const sameLogin = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
export const positiveInteger = (value) =>
  /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

export function parseBlock(body, name) {
  const matches = [
    ...(body || "").matchAll(new RegExp("```" + name + "\\s*\\n([\\s\\S]*?)\\n```", "g")),
  ];
  if (matches.length !== 1) throw new Error(`Expected exactly one ${name} metadata block`);
  return JSON.parse(matches[0][1]);
}

export function validateConfig(config) {
  if (!/^[a-f0-9]{40}$/.test(config.ghAwActionsSha))
    throw new Error("The gh-aw runtime action must be pinned to a commit SHA");
  if (
    !config.labels?.admitted ||
    Object.values(config.labels).length !== new Set(Object.values(config.labels)).size
  )
    throw new Error("Distinct admission and control labels are required");
  for (const key of ["maxConcurrent", "dailyCredits", "agentCredits", "detectionCredits"])
    if (!Number.isSafeInteger(config.budget?.[key]) || config.budget[key] < 1)
      throw new Error("Positive integer automation budgets are required");
  if (config.budget.dailyCredits < config.budget.agentCredits + config.budget.detectionCredits)
    throw new Error("Daily budget must cover one complete agent and detection run");
  for (const engine of config.supportedEngines)
    if (!/^\d+\.\d+\.\d+$/.test(config.engineVersions?.[engine]))
      throw new Error("Pin each engine to a mature stable version");
  if (config.schemaVersion !== 1) throw new Error("Unsupported workflow configuration version");
  if (!config.supportedEngines.includes(config.engine)) throw new Error("Unsupported agent engine");
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
  return config;
}

export function validateTriage(data, issue) {
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
  const checklist = ["scope", "acceptance", "validation", "dependencies", "alignment"];
  if (
    data.ready &&
    (data.questions.length || !checklist.every((key) => data.checklist?.[key] === true))
  ) {
    throw new Error("Ready requires a complete triage checklist and no open questions");
  }
  return data;
}

export function validateReview(data, review, { number, head, round }) {
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

export function patchDigest(files) {
  // Ignore diff line positions so moving an unchanged finding does not reset the loop.
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

export function loopDecision(history, config) {
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

export function availableSlots(items, config) {
  const active = items.filter(
    (item) =>
      !item.isArchived &&
      item.content?.__typename !== "PullRequest" &&
      item.status === config.statuses.inProgress,
  );
  return Math.max(0, config.maxInProgress - active.length);
}

export function dependencyComplete(issue) {
  return (
    issue.state?.toLowerCase() === "closed" &&
    (issue.state_reason === "completed" || issue.stateReason === "COMPLETED")
  );
}

export function assertAcyclic(graph) {
  const visiting = new Set();
  const visited = new Set();
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

export function conventionalTitle(title) {
  return /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-zA-Z0-9._/-]+\))?!?: .+/.test(
    title || "",
  );
}

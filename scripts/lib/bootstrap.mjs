import { createInterface } from "node:readline";
import { sameLogin } from "./policy.mjs";

export async function resolveActionsAppId(api) {
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

export function repositoryRules(actors, statusAppId, releaseAppId, actionsAppId) {
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

export const repositorySettings = {
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  allow_auto_merge: false,
  delete_branch_on_merge: true,
  squash_merge_commit_title: "PR_TITLE",
  squash_merge_commit_message: "PR_BODY",
};

export function preserveCodeowners(original, logins) {
  const operators = logins.map((login) => `@${login}`);
  let hasDefault = false;
  const lines = original.split(/\r?\n/).map((line) => {
    if (!line.trim() || line.trimStart().startsWith("#")) return line;
    const match = line.match(/^(\s*)(\S+)(.*)$/);
    if (!match) return line;
    if (match[2] === "*") hasDefault = true;
    const commentAt = match[3].indexOf("#");
    const owners = (commentAt < 0 ? match[3] : match[3].slice(0, commentAt)).trim();
    const comment = commentAt < 0 ? "" : ` ${match[3].slice(commentAt)}`;
    const existing = owners.split(/\s+/).filter(Boolean);
    for (const operator of operators)
      if (!existing.some((owner) => owner.toLowerCase() === operator.toLowerCase()))
        existing.push(operator);
    return `${match[1]}${match[2]} ${existing.join(" ")}${comment}`;
  });
  if (!hasDefault) lines.unshift(`* ${operators.join(" ")}`);
  return lines.join("\n").replace(/\n*$/, "\n");
}

function diagnostic(label, color, stream, message) {
  const styled = stream.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
  stream.write(
    "\n" + (styled ? "\x1b[" + color + "m" + label + "\x1b[0m" : label) + " " + message + "\n",
  );
}

export function setupWarning(message, stream = process.stdout) {
  diagnostic("WARNING", 33, stream, message);
}

export function setupError(message) {
  diagnostic("ERROR", 31, process.stderr, message);
}

export function interruptionError() {
  const error = new Error("Setup interrupted");
  error.code = "SETUP_INTERRUPTED";
  return error;
}

export async function setupQuestion(message, signal) {
  if (!process.stdin.isTTY) return null;
  signal?.throwIfAborted();
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const close = () => terminal.close();
  let interrupted = false;
  try {
    const answer = await new Promise((resolve) => {
      terminal.once("close", () => resolve(null));
      terminal.once("SIGINT", () => {
        interrupted = true;
        close();
      });
      signal?.addEventListener("abort", close, { once: true });
      terminal.question("\n" + message, resolve);
    });
    signal?.throwIfAborted();
    if (interrupted) throw interruptionError();
    return answer;
  } finally {
    signal?.removeEventListener("abort", close);
    close();
  }
}

export function askSetupRules(signal) {
  return setupQuestion(
    "Complete the configuration and type 'completed' to verify it. Type 'continue' to acknowledge unenforced rules, or 'pause' to resume later: ",
    signal,
  );
}

export function rulesetSetupLog(message) {
  if (/^GitHub ruleset configuration/.test(message)) setupWarning(message);
  else console.log(message);
}

function matchesRuleValue(actual, expected) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    const remaining = [...actual];
    return expected.every((value) => {
      const index = remaining.findIndex((candidate) => matchesRuleValue(candidate, value));
      if (index < 0) return false;
      remaining.splice(index, 1);
      return true;
    });
  }
  if (expected && typeof expected === "object")
    return (
      actual &&
      typeof actual === "object" &&
      !Array.isArray(actual) &&
      Object.entries(expected).every(([key, value]) => matchesRuleValue(actual[key], value))
    );
  return actual === expected;
}

export async function verifyActiveRepositoryRules(api, repo, rules) {
  try {
    const rulesets = await api.list("repos/" + repo + "/rulesets");
    for (const rule of rules) {
      const stored = rulesets.find(
        (item) => item.name === rule.name && sameLogin(item.source, repo),
      );
      if (!Number.isSafeInteger(stored?.id) || stored.id < 1) return false;
      const current = await api.request("repos/" + repo + "/rulesets/" + stored.id);
      if (!matchesRuleValue(current, rule)) return false;
    }
    return true;
  } catch (error) {
    if (error.status === 403 || error.status === 404) return false;
    throw error;
  }
}

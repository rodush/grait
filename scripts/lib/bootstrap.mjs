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

export function repositoryRules(actors, statusAppId, releaseAppId) {
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
              { context: "Template validation", integration_id: 15368 },
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

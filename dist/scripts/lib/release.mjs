// Create-only semantics avoid accepting a tag planted before the operator's run.
// Tag rules must independently prohibit updates/deletions, including by release actors.
export async function createRelease(api, repo, version, sha) {
  const rules = await api.list(`repos/${repo}/rulesets`);
  const protection = rules.find(
    (rule) =>
      rule.name === "Immutable release tags" && rule.source?.toLowerCase() === repo.toLowerCase(),
  );
  if (!protection) throw new Error("Release tag protection is not configured");
  const rule = await api.request(`repos/${repo}/rulesets/${protection.id}`);
  if (
    rule.enforcement !== "active" ||
    rule.target !== "tag" ||
    rule.bypass_actors?.length ||
    rule.conditions?.ref_name?.exclude?.length ||
    !rule.conditions?.ref_name?.include?.includes("refs/tags/v*") ||
    !["update", "deletion"].every((type) => rule.rules?.some((entry) => entry.type === type))
  )
    throw new Error("Release tags must prohibit updates and deletions without bypass");
  await api.request(`repos/${repo}/git/refs`, {
    method: "POST",
    body: { ref: `refs/tags/${version}`, sha },
  }); // GitHub rejects an existing ref; never delete, reuse or overwrite it.
  const ref = await api.request(`repos/${repo}/git/ref/tags/${encodeURIComponent(version)}`);
  if (ref.object?.type !== "commit" || ref.object.sha !== sha)
    throw new Error("Release tag does not point to the validated commit");
  return api.request(`repos/${repo}/releases`, {
    method: "POST",
    body: {
      tag_name: version,
      target_commitish: sha,
      name: version,
      generate_release_notes: true,
      draft: false,
      prerelease: version.includes("-"),
    },
  });
}

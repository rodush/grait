import test from "node:test";
import assert from "node:assert/strict";
import { createRelease } from "../scripts/lib/release.mjs";
import { repositoryRules } from "../scripts/lib/bootstrap.mjs";

function releaseFixture({
  exists = false,
  tagType = "commit",
  tagSha = "verified",
  protectedTags = true,
} = {}) {
  const calls = [];
  const rule = repositoryRules([{ id: 42 }], 123, 456, 98765).find(
    (item) => item.name === "Immutable release tags",
  );
  const api = {
    list: async () => (protectedTags ? [{ id: 1, name: rule.name, source: "org/repo" }] : []),
    request: async (path, options) => {
      calls.push({ path, options });
      if (path.endsWith("/rulesets/1")) return rule;
      if (path.endsWith("/git/refs")) {
        if (exists) throw Object.assign(new Error("Reference already exists"), { status: 422 });
        return {};
      }
      if (path.includes("/git/ref/tags/")) return { object: { type: tagType, sha: tagSha } };
      return {};
    },
  };
  return { api, calls };
}

for (const tagType of ["commit", "tag"])
  test(`existing ${tagType} tags cannot bypass release CI`, async () => {
    const { api, calls } = releaseFixture({ exists: true, tagType, tagSha: "unreviewed" });
    await assert.rejects(
      () => createRelease(api, "org/repo", "v1.2.3", "verified"),
      /already exists/,
    );
    assert.equal(
      calls.some((call) => call.path.endsWith("/releases")),
      false,
    );
  });

test("release creates a fresh validated tag and rejects races or missing protection", async () => {
  const good = releaseFixture();
  await createRelease(good.api, "org/repo", "v1.2.3", "verified");
  assert.deepEqual(good.calls.find((call) => call.path.endsWith("/git/refs")).options.body, {
    ref: "refs/tags/v1.2.3",
    sha: "verified",
  });
  assert.equal(good.calls.at(-1).options.body.target_commitish, "verified");
  const race = releaseFixture({ tagSha: "changed" });
  await assert.rejects(
    () => createRelease(race.api, "org/repo", "v1.2.3", "verified"),
    /validated commit/,
  );
  assert.equal(
    race.calls.some((call) => call.path.endsWith("/releases")),
    false,
  );
  const missing = releaseFixture({ protectedTags: false });
  await assert.rejects(
    () => createRelease(missing.api, "org/repo", "v1.2.3", "verified"),
    /protection/,
  );
});

test("release identity may create tags but no identity can bypass tag immutability", () => {
  const rules = repositoryRules([{ id: 42 }], 123, 456, 98765);
  const creation = rules.find((rule) => rule.name === "Release tag creation");
  assert.deepEqual(creation.bypass_actors, [
    { actor_id: 456, actor_type: "Integration", bypass_mode: "always" },
  ]);
  assert.deepEqual(rules.find((rule) => rule.name === "Immutable release tags").bypass_actors, []);
});

import { readFile } from "node:fs/promises";
import { createRelease } from "./lib/release.mjs";
import { GitHub } from "./lib/github.mjs";

try {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const version = event.inputs?.version;
  if (
    !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/.test(
      version || "",
    )
  )
    throw new Error("Provide a semantic version tag such as v1.2.3");
  const api = new GitHub(process.env.GH_TOKEN);
  const releaseApi = new GitHub(process.env.RELEASE_CREDENTIAL);
  const config = JSON.parse(await readFile("workflow.config.json", "utf8"));
  const repo = process.env.GITHUB_REPOSITORY;
  const actor = await api.request(`users/${encodeURIComponent(process.env.GITHUB_ACTOR)}`);
  const permission = await api.request(
    `repos/${repo}/collaborators/${encodeURIComponent(actor.login)}/permission`,
  );
  if (
    actor.type !== "User" ||
    !config.humanOperators.includes(actor.login) ||
    !["admin", "maintain", "write"].includes(permission.permission)
  )
    throw new Error("Only a configured human operator with write access may release");
  const repository = await api.request(`repos/${repo}`);
  const ref = `refs/heads/${repository.default_branch}`;
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.GITHUB_REF !== ref)
    throw new Error("Release must be requested on the default branch");
  const commit = await api.request(
    `repos/${repo}/commits/${encodeURIComponent(repository.default_branch)}`,
  );
  if (commit.sha !== process.env.GITHUB_SHA)
    throw new Error("Default branch advanced; request a release of its current head");
  const runs = await api.list(
    `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${commit.sha}&event=push`,
    "workflow_runs",
  );
  if (!runs.some((run) => run.head_sha === commit.sha && run.conclusion === "success"))
    throw new Error("Successful default-branch CI is required before release");
  await createRelease(releaseApi, repo, version, commit.sha);
  console.log(`Published ${version} at ${commit.sha}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

import { sameLogin } from "../scripts/lib/policy.mjs";
import { installationPath } from "./installation-record.mjs";

const shaPattern = /^[a-f0-9]{40}$/i;
const mergeRequired =
  "A configuration PR containing the installation record must be merged to the default branch by a human before activation";
const pullRequestMergeQuery =
  "query($owner: String!, $name: String!, $number: Int!) {" +
  " repository(owner: $owner, name: $name) {" +
  "  pullRequest(number: $number) {" +
  "   merged mergeCommit { oid } mergedBy { __typename }" +
  "   baseRefName baseRepository { nameWithOwner }" +
  "  }" +
  " }" +
  "}";

async function pullsAvailable(api, path) {
  try {
    return await api.list(path);
  } catch (error) {
    if (error.status !== 404 && error.status !== 422) throw error;
    return [];
  }
}

async function pullListsRecord(api, repo, number) {
  return (await pullsAvailable(api, "repos/" + repo + "/pulls/" + number + "/files")).some(
    (file) => file.filename === installationPath && file.status !== "removed",
  );
}

async function pendingConfiguration(api, repo, defaultBranch, associated) {
  const pulls = [
    ...associated,
    ...(await pullsAvailable(
      api,
      "repos/" + repo + "/pulls?state=open&base=" + encodeURIComponent(defaultBranch),
    )),
  ];
  const seen = new Set();
  for (const pull of pulls) {
    if (
      pull.state !== "open" ||
      !Number.isSafeInteger(pull.number) ||
      seen.has(pull.number) ||
      (pull.base?.ref && pull.base.ref !== defaultBranch) ||
      (pull.base?.repo?.full_name && !sameLogin(pull.base.repo.full_name, repo))
    )
      continue;
    seen.add(pull.number);
    if (await pullListsRecord(api, repo, pull.number)) return pull.number;
  }
}

export async function verifyInstallationMerge({ api, repo, defaultBranch, head }) {
  if (!shaPattern.test(head.sha))
    throw new Error("GitHub did not return a valid default-branch SHA");
  // Current CI can be newer than the installation. Only the default-branch
  // commit that actually changed the record can prove a configuration merge.
  let commit = head;
  if (!head.files?.some((file) => file.filename === installationPath)) {
    const history = await api.request(
      "repos/" +
        repo +
        "/commits?sha=" +
        head.sha +
        "&path=" +
        encodeURIComponent(installationPath) +
        "&per_page=1",
    );
    commit = history?.[0];
  }
  const changedRecord = shaPattern.test(commit?.sha ?? "");
  const associated = changedRecord
    ? await api.list("repos/" + repo + "/commits/" + commit.sha + "/pulls")
    : [];
  const [owner, name] = repo.split("/");
  const otherMerges = [];
  let invalidMerge;
  for (const pull of associated) {
    if (pull.state === "open" || !Number.isSafeInteger(pull.number) || pull.number < 1) continue;
    // GitHub REST API 2026-03-10 omits merge_commit_sha.
    const result = await api.graphql(pullRequestMergeQuery, { owner, name, number: pull.number });
    const details = result.repository?.pullRequest;
    if (
      details?.merged !== true ||
      details.baseRefName !== defaultBranch ||
      !sameLogin(details.baseRepository?.nameWithOwner, repo)
    )
      continue;
    if (details.mergeCommit?.oid === commit.sha) {
      if (details.mergedBy?.__typename === "User") return commit.sha;
      invalidMerge = pull.number;
    } else if (details.mergedBy?.__typename === "User") {
      otherMerges.push(pull.number);
    }
  }
  if (invalidMerge)
    throw new Error(
      mergeRequired + ". PR #" + invalidMerge + " was merged by a non-human identity.",
    );

  const pending = await pendingConfiguration(api, repo, defaultBranch, associated);
  if (pending)
    throw new Error(
      mergeRequired +
        ". Configuration PR #" +
        pending +
        " still needs a human merge. Wait for GRAIT validation on " +
        defaultBranch +
        " after merge, then retry grait activate.",
    );
  if (!changedRecord)
    throw new Error(
      mergeRequired +
        ". Push the integration branch and open a configuration PR targeting " +
        defaultBranch +
        ".",
    );

  let laterMerge = "";
  for (const number of otherMerges) {
    if (!(await pullListsRecord(api, repo, number))) continue;
    laterMerge =
      " PR #" +
      number +
      " lists " +
      installationPath +
      " in its diff, but its merge commit did not establish the change to that file on " +
      defaultBranch +
      ". A no-op configuration PR cannot validate an earlier direct push.";
    break;
  }
  throw new Error(
    mergeRequired +
      ". The record " +
      installationPath +
      " at " +
      commit.sha +
      " appears to have been pushed directly to " +
      defaultBranch +
      " because GitHub shows no qualifying human merge for that change." +
      laterMerge +
      " If setup was pushed directly, use reviewed revert and reapplication PRs to preserve the existing Apps, Project, and local setup state. See docs/installation.md#recover-a-direct-push-of-the-installation-record.",
  );
}

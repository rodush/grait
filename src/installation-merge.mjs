import { sameLogin } from "../scripts/lib/policy.mjs";
import { installationPath } from "./installation-record.mjs";

const shaPattern = /^[a-f0-9]{40}$/i;
const pullRequestMergeQuery = `
  query($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        merged
        mergeCommit { oid }
        mergedBy { __typename }
        baseRefName
        baseRepository { nameWithOwner }
      }
    }
  }
`;

export async function verifyInstallationMerge({ api, repo, defaultBranch, head }) {
  const failure =
    "A configuration PR containing the installation record must be merged to the default branch by a human before activation";
  if (!shaPattern.test(head.sha))
    throw new Error("GitHub did not return a valid default-branch SHA");
  // Current CI can be newer than the installation. Find the commit that changed
  // the installation record so an unrelated merged PR cannot authorize it.
  let commit = head;
  if (!head.files?.some((file) => file.filename === installationPath)) {
    const history = await api.request(
      `repos/${repo}/commits?sha=${head.sha}&path=${encodeURIComponent(installationPath)}&per_page=1`,
    );
    commit = history?.[0];
  }
  if (!shaPattern.test(commit?.sha ?? "")) throw new Error(failure);
  const associated = await api.list(`repos/${repo}/commits/${commit.sha}/pulls`);
  const [owner, name] = repo.split("/");
  for (const pull of associated) {
    if (!Number.isSafeInteger(pull.number) || pull.number < 1) continue;
    // GitHub REST API 2026-03-10 omits merge_commit_sha.
    const result = await api.graphql(pullRequestMergeQuery, { owner, name, number: pull.number });
    const details = result.repository?.pullRequest;
    if (
      details?.merged === true &&
      details.mergeCommit?.oid === commit.sha &&
      details.baseRefName === defaultBranch &&
      sameLogin(details.baseRepository?.nameWithOwner, repo) &&
      details.mergedBy?.__typename === "User"
    )
      return commit.sha;
  }
  throw new Error(failure);
}

import { sameLogin } from "../scripts/lib/policy.mjs";
import { installationPath } from "./installation-record.mjs";

const shaPattern = /^[a-f0-9]{40}$/i;

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
  for (const pull of associated) {
    if (!Number.isSafeInteger(pull.number) || pull.number < 1) continue;
    const details = await api.request(`repos/${repo}/pulls/${pull.number}`);
    if (
      details.merged === true &&
      details.merge_commit_sha === commit.sha &&
      details.base?.ref === defaultBranch &&
      sameLogin(details.base?.repo?.full_name, repo) &&
      details.merged_by?.type === "User"
    )
      return commit.sha;
  }
  throw new Error(failure);
}

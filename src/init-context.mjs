import { command, requireSubscription, withoutCredentials } from "../scripts/lib/setup-process.mjs";
import { sameLogin } from "../scripts/lib/policy.mjs";
import { installers, readInstallation } from "./installation-record.mjs";
import { readArtifact } from "./artifact-stage.mjs";
import { setupQuestion } from "../scripts/lib/bootstrap.mjs";

const repoPattern = /^[\w.-]+\/[\w.-]+$/;
const projectNumber = (number) => /^[1-9]\d*$/.test(number ?? "") && Number(number) <= 2147483647;
export const githubLogin = (login) => typeof login === "string" && /^[\w-]+$/.test(login);

function targetFromRemote(url) {
  const match = url.match(
    /^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|ssh:\/\/(?:git@)?github\.com\/|(?:git@)?github\.com:)([\w.-]+\/[\w.-]+?)\/?$/i,
  );
  return match?.[1].replace(/\.git$/i, "");
}

async function repositoryRemotes(root) {
  const { code, stdout } = await command(
    "git",
    ["config", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"],
    {
      cwd: root,
      allowFailure: true,
    },
  );
  if (code !== 0 && code !== 1) throw new Error("Cannot read the checkout's Git remotes");
  return stdout
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^remote\.(.+)\.(url|pushurl)\s+(.+)$/);
      const repo = match && targetFromRemote(match[3]);
      return repo ? [{ name: match[1], repo, fetch: match[2] === "url" }] : [];
    });
}

async function chooseRepository(remotes) {
  const targets = [...new Map(remotes.map(({ repo }) => [repo.toLowerCase(), repo])).values()];
  if (targets.length === 1) return targets[0];
  if (targets.length > 1) {
    const error =
      "Ambiguous GitHub remotes for the target repository: " +
      targets.join(", ") +
      ". Select the fork or upstream with --repo OWNER/REPOSITORY.";
    if (!process.stdin.isTTY) throw new Error(error);
    const selection = await setupQuestion(
      "Choose the GitHub repository by typing its name: " +
        targets.map((repo) => "'" + repo + "'").join(", ") +
        ": ",
    );
    const match = targets.find((repo) => sameLogin(repo, selection?.trim()));
    if (match) return match;
    throw new Error(error);
  }
  throw new Error(
    "No GitHub target repository could be inferred. Add its Git remote or pass --repo OWNER/REPOSITORY.",
  );
}

async function localDefaultBranch(root, repo, remotes) {
  const branches = new Set();
  for (const { name, repo: remote, fetch } of remotes) {
    if (!fetch || !sameLogin(remote, repo)) continue;
    const { code, stdout } = await command(
      "git",
      ["symbolic-ref", "--quiet", "refs/remotes/" + name + "/HEAD"],
      {
        cwd: root,
        allowFailure: true,
      },
    );
    if (code === 0) branches.add(stdout.trim().slice(("refs/remotes/" + name + "/").length));
  }
  return branches.size === 1 ? [...branches][0] : undefined;
}

async function chooseHarness() {
  if (!process.stdin.isTTY) return "codex";
  const available = (
    await Promise.all(
      installers.map(async (harness) => {
        const result = await command(harness, ["--version"], {
          allowFailure: true,
          timeoutMs: 10000,
          env: withoutCredentials(),
        }).catch(() => null);
        return result?.code === 0 ? harness : null;
      }),
    )
  ).filter(Boolean);
  if (available.length === 1) return available[0];
  const selected = (
    await setupQuestion("Choose a harness: 'codex', 'claude', or 'copilot': ")
  )?.trim();
  if (!installers.includes(selected))
    throw new Error("Choose an installed harness with --harness codex, claude, or copilot.");
  return selected;
}

function parseMaintainers(input) {
  if (input === undefined) return undefined;
  return input.split(",").map((name) => name.trim().replace(/^@/, ""));
}

export async function initContext(input) {
  const { root } = input;
  const prior = (await readInstallation(root))?.record;
  const config = JSON.parse((await readArtifact(root, "workflow.config.json")) ?? "{}");
  const remotes = await repositoryRemotes(root);
  const currentTarget = prior?.repository ?? config.controllerRepository;
  const recorded = input.recordedState;
  const repo = input.repo ?? currentTarget ?? recorded.repo ?? (await chooseRepository(remotes));
  if (!repoPattern.test(repo)) throw new Error("Provide --repo OWNER/REPOSITORY");
  if (currentTarget && !sameLogin(currentTarget, repo))
    throw new Error("This checkout is configured for another repository");
  const state = recorded.repo ? recorded : { version: 1, repo, apps: {} };
  if (!sameLogin(state.repo, repo))
    throw new Error(
      "This checkout has private setup state for " +
        state.repo +
        ". Use a separate checkout to configure " +
        repo +
        ".",
    );
  const saved = state.initAnswers;
  const harness =
    input.harness ??
    prior?.harness ??
    config.engine ??
    (installers.includes(saved?.harness) ? saved.harness : await chooseHarness());
  const configuredMaintainers = config.humanOperators ?? [];
  if (!Array.isArray(configuredMaintainers) || !configuredMaintainers.every(githubLogin))
    throw new Error("Configured maintainers must be GitHub user logins");
  const savedMaintainers = saved?.maintainers?.every(githubLogin) ? saved.maintainers : [];
  const maintainers =
    parseMaintainers(input.maintainers) ??
    (configuredMaintainers.length ? configuredMaintainers : savedMaintainers);
  const binding = prior?.project || {};
  const owner =
    input.projectOwner ??
    binding.owner ??
    (githubLogin(saved?.projectOwner) ? saved.projectOwner : undefined);
  const number =
    input.projectNumber ??
    (binding.number ? String(binding.number) : undefined) ??
    (projectNumber(saved?.projectNumber) ? saved.projectNumber : undefined);
  const project = input.project ?? prior?.project ?? saved?.project;
  return {
    ...input,
    repo,
    harness,
    maintainers,
    projectOwner: owner,
    projectNumber: number,
    project,
    state,
    prior,
    knownMaintainers: [...configuredMaintainers, ...savedMaintainers],
    defaultBranch: await localDefaultBranch(root, repo, remotes),
  };
}

export async function assertIntegrationBranch(root, defaultBranch) {
  const { stdout } = await command("git", ["branch", "--show-current"], { cwd: root });
  const branch = stdout.trim();
  if (!branch || branch === defaultBranch)
    throw new Error(
      (branch ? "You are on the default branch '" + branch + "'." : "The checkout is detached.") +
        " Create an integration branch before applying setup:\n  git switch -c chore/adopt-grait\n  grait init",
    );
}

export async function verifyInitHarness(harness) {
  try {
    await requireSubscription(harness);
  } catch (error) {
    throw new Error("The " + harness + " harness is not ready. " + error.message);
  }
}

import { realpath } from "node:fs/promises";
import { preserveCodeowners } from "../scripts/lib/bootstrap.mjs";
import { defaultMaxReady, sameLogin, validateConfig } from "../scripts/lib/policy.mjs";
import { readArtifact } from "./artifact-stage.mjs";
import {
  applyArtifactTransaction,
  assertExpectedChanges,
  pendingArtifactTransaction,
  recoverArtifactTransaction,
} from "./artifact-transaction.mjs";
import {
  artifactOwnership,
  installationPath,
  installerWorkflow,
  readInstallation,
  validateTarget,
  verifyOwnership,
} from "./installation-record.mjs";
import { installerStore, provision } from "./installer-services.mjs";
import { generateProjectArtifacts } from "./project-policy.mjs";
import { resolveInstallRevision } from "./installation-revision.mjs";

const configPath = "workflow.config.json";
const ownersPath = ".github/CODEOWNERS";
const workflowPath = `.github/workflows/${installerWorkflow}`;
const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

function defaultConfig() {
  return {
    schemaVersion: 2,
    engine: "codex",
    authentication: "app",
    supportedEngines: ["codex", "claude", "copilot"],
    statuses: {
      backlog: "Backlog",
      ready: "Ready",
      inProgress: "In Progress",
      review: "Review",
      done: "Done",
    },
    maxReady: defaultMaxReady,
    maxInProgress: 5,
    maxReviewRounds: 10,
    maxRepeatedBlockingReviews: 3,
    humanOperators: [],
    allowedWritePaths: [],
    protectedPaths: [
      ".github/",
      ".agents/",
      ".codex/",
      ".claude/",
      ".grait/",
      "AGENTS.md",
      "CLAUDE.md",
      configPath,
    ],
    labels: {
      automated: "agent:managed",
      paused: "agent:paused",
      needsHuman: "agent:needs-human",
      admitted: "agent:admitted",
    },
    tdd: {
      implementationPaths: [],
      profiles: { tester: { model: null }, implementer: { model: null } },
      testPatterns: [],
    },
    execution: "local",
    maxConcurrentWorkers: 5,
    orchestrator: { reasoning: "medium" },
  };
}

export function pinnedValidationWorkflow(revision) {
  return `name: GRAIT validation
on:
  push:
  pull_request:
permissions:
  contents: read
jobs:
  validate:
    name: Template validation
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: "24"
      - run: npm exec --yes --allow-git=root --ignore-scripts --package='git+https://github.com/rodush/grait.git#${revision}' -- grait validate
`;
}

async function installationInputs(input) {
  const root = await realpath(input.root);
  const installation = await readInstallation(root);
  const prior = installation?.record;
  const configContent = await readArtifact(root, configPath);
  const existingConfig = configContent === null ? {} : JSON.parse(configContent);
  const repo = input.repo ?? prior?.repository ?? existingConfig.controllerRepository;
  const harness = input.harness ?? prior?.harness ?? existingConfig.engine ?? "codex";
  const version = input.version;
  const revision =
    input.verifiedRevision ?? (await resolveInstallRevision(input.revision ?? prior?.revision));
  validateTarget({ repository: repo, harness, version });
  if (
    [prior?.repository, existingConfig.controllerRepository].some(
      (candidate) => candidate && !sameLogin(candidate, repo),
    )
  )
    throw new Error("This checkout is configured for another repository");
  if (
    prior &&
    (prior.revision !== revision || prior.version !== version || prior.harness !== harness)
  )
    throw new Error("Use grait upgrade for a different pinned revision, version, or harness");
  const maintainers =
    input.maintainers === undefined
      ? (existingConfig.humanOperators ?? [])
      : input.maintainers.split(",").map((name) => name.trim().replace(/^@/, ""));
  if (
    !Array.isArray(maintainers) ||
    maintainers.some((login) => typeof login !== "string" || !/^[a-zA-Z0-9-]+$/.test(login))
  )
    throw new Error("Maintainers must be GitHub user logins");
  if (
    prior &&
    input.maintainers !== undefined &&
    maintainers.join(",").toLowerCase() !== existingConfig.humanOperators?.join(",").toLowerCase()
  )
    throw new Error("Edit the project-owned humanOperators configuration before repeating init");
  if (input.projectOwner !== undefined && !/^[\w-]+$/.test(input.projectOwner))
    throw new Error("Invalid Project owner");
  if (
    input.projectNumber !== undefined &&
    (!/^[1-9]\d*$/.test(input.projectNumber) || Number(input.projectNumber) > 2147483647)
  )
    throw new Error("Invalid Project number");
  const config = validateConfig({
    ...defaultConfig(),
    ...existingConfig,
    engine: harness,
    controllerRepository: repo,
    humanOperators: maintainers,
  });
  return {
    ...input,
    root,
    repo,
    revision,
    version,
    harness,
    maintainers,
    config,
    prior,
    project: input.project || prior?.project || {},
    initial: {
      [configPath]: configContent,
      [installationPath]: installation?.content ?? null,
    },
  };
}

async function prepareArtifacts(options) {
  const generated = await generateProjectArtifacts(options);
  const before = { ...options.initial };
  const paths = new Set([
    ...Object.keys(generated),
    ownersPath,
    workflowPath,
    ...Object.keys(options.prior?.artifacts ?? {}),
  ]);
  for (const path of paths) {
    if (!Object.hasOwn(before, path)) before[path] = await readArtifact(options.root, path);
  }
  if (options.prior) verifyOwnership(options.prior, before);
  const currentWorkflow = before[workflowPath];
  const generatedWorkflow = pinnedValidationWorkflow(options.revision);
  if (currentWorkflow !== null && currentWorkflow !== generatedWorkflow)
    throw new Error("The existing grait.yml conflicts with the pinned installation workflow");
  const owners =
    before[ownersPath] ??
    (await readArtifact(options.root, "CODEOWNERS")) ??
    (await readArtifact(options.root, "docs/CODEOWNERS")) ??
    "# Human ownership is required for every change.\n";
  const existing = Object.fromEntries(
    Object.keys(generated)
      .filter((path) => before[path] !== null)
      .map((path) => [path, before[path]]),
  );
  const policy = await generateProjectArtifacts({ ...options, existing });
  return { before, policy, owners, generatedWorkflow };
}

function planFor(options, prepared, config, codeowners) {
  const artifacts = {
    ...prepared.policy,
    [configPath]: serialize(config),
    [ownersPath]: codeowners,
    [workflowPath]: prepared.generatedWorkflow,
  };
  const record = {
    schemaVersion: 1,
    version: options.version,
    revision: options.revision,
    repository: options.repo,
    harness: options.harness,
    project: options.project,
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([path, content]) => [path, artifactOwnership(path, content)]),
    ),
  };
  artifacts[installationPath] = serialize(record);
  const changes = Object.keys(artifacts)
    .sort()
    .filter((path) => prepared.before[path] !== artifacts[path])
    .map((path) => ({ path, before: prepared.before[path], after: artifacts[path] }));
  return { artifacts, changes, record };
}

function plannedOwners(options, prepared) {
  return !options.prior && options.maintainers.length
    ? preserveCodeowners(prepared.owners, options.maintainers)
    : prepared.owners;
}

/** Preview durable artifacts without provisioning or creating private state. */
export async function planInstallation(input) {
  const root = await realpath(input.root);
  const installation = await readInstallation(root);
  const repo =
    input.repo ??
    installation?.record.repository ??
    JSON.parse((await readArtifact(root, configPath)) ?? "{}").controllerRepository;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) throw new Error("Provide --repo OWNER/REPOSITORY");
  const store = await installerStore({ root, repo });
  const transaction = pendingArtifactTransaction(store, "init");
  if (transaction) {
    const revision = await resolveInstallRevision(
      input.revision ?? transaction.revision ?? installation?.record.revision,
    );
    return { pendingRecovery: true, repo, revision };
  }
  const options = await installationInputs({ ...input, root, repo });
  const prepared = await prepareArtifacts(options);
  return {
    ...planFor(options, prepared, options.config, plannedOwners(options, prepared)),
    repo,
    revision: options.revision,
  };
}

/** Provision privately, then apply one complete set of durable artifacts. */
export async function installWorkflow(input) {
  const root = await realpath(input.root);
  const repo = input.repo;
  const revision = await resolveInstallRevision(input.revision, { requireInstalled: true });
  const store = await installerStore({ root, repo });
  const transaction = pendingArtifactTransaction(store, "init");
  if (Boolean(transaction) !== Boolean(input.pendingRecovery))
    throw new Error("Installation recovery state changed since preview. Retry the same command.");
  if (transaction?.revision && transaction.revision !== revision)
    throw new Error("Retry the interrupted installation with its recorded GRAIT Git revision.");
  await store.acquire();
  try {
    if (transaction) await recoverArtifactTransaction({ root, store, transaction });
    const options = await installationInputs({ ...input, root, verifiedRevision: revision });
    if (!sameLogin(options.repo, repo))
      throw new Error("The installation repository changed; review the preview and retry");
    const prepared = await prepareArtifacts(options);
    const existingOwners = plannedOwners(options, prepared);
    const preliminary = planFor(options, prepared, options.config, existingOwners);
    if (transaction) await input.onRecoveredPlan(preliminary);
    else assertExpectedChanges(input.preview, preliminary.changes);
    if (options.prior && !preliminary.changes.length) return preliminary;
    const { config, codeowners } = options.prior
      ? { config: options.config, codeowners: existingOwners }
      : await provision({ ...options, codeowners: prepared.owners, store });
    const result = planFor(options, prepared, config, codeowners);
    await applyArtifactTransaction({
      root,
      store,
      revision,
      operation: "init",
      artifacts: result.artifacts,
      changes: result.changes,
      onPlan: input.onPlan,
    });
    return result;
  } finally {
    await store.release();
  }
}

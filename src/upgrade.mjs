import { realpath } from "node:fs/promises";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { sameLogin } from "../scripts/lib/policy.mjs";
import { confirm } from "../scripts/lib/setup-process.mjs";
import { readArtifact } from "./artifact-stage.mjs";
import {
  applyArtifactTransaction,
  assertExpectedChanges,
  pendingArtifactTransaction,
  recoverArtifactTransaction,
} from "./artifact-transaction.mjs";
import { renderInstallationPlan } from "./installation-cli.mjs";
import {
  artifactOwnership,
  installationPath,
  installerWorkflow,
  validateInstallation,
  validateTarget,
} from "./installation-record.mjs";
import { resolveInstallRevision } from "./installation-revision.mjs";
import { installerStore } from "./installer-services.mjs";
import { pinnedValidationWorkflow } from "./installer.mjs";
import { generateProjectArtifacts } from "./project-policy.mjs";
import { targetRoot } from "./runtime.mjs";

const configPath = "workflow.config.json";

async function buildUpgrade({ root, repo, revision, version }) {
  const { record, artifacts: before } = await validateInstallation(root);
  if (!sameLogin(record.repository, repo))
    throw new Error("Installation repository changed. Review the plan and retry.");
  validateTarget({ ...record, version });
  const { harness, project } = record;
  const generated = await generateProjectArtifacts({ harness, project, version });
  for (const path of Object.keys(generated)) {
    if (Object.hasOwn(before, path)) continue;
    before[path] = await readArtifact(root, path);
    if (/grait:policy:(?:start|end)/.test(before[path] ?? ""))
      throw new Error(`Unrecorded GRAIT policy conflicts with the upgrade: ${path}`);
  }
  const existing = Object.fromEntries(
    Object.keys(generated)
      .filter((path) => before[path] !== null)
      .map((path) => [path, before[path]]),
  );
  const managed = await generateProjectArtifacts({ harness, project, version, existing });
  const artifacts = {
    ...Object.fromEntries(Object.keys(record.artifacts).map((path) => [path, before[path]])),
    ...managed,
    [`.github/workflows/${installerWorkflow}`]: pinnedValidationWorkflow(revision),
  };
  const upgraded = {
    ...record,
    revision,
    version,
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([path, content]) => [path, artifactOwnership(path, content)]),
    ),
  };
  artifacts[installationPath] = isDeepStrictEqual(upgraded, record)
    ? before[installationPath]
    : `${JSON.stringify(upgraded, null, 2)}\n`;
  const changes = Object.keys(artifacts)
    .sort()
    .filter((path) => artifacts[path] !== before[path])
    .map((path) => ({ path, before: before[path], after: artifacts[path] }));
  return { artifacts, changes };
}

export async function runUpgrade({ args, cwd, version }) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      plan: { type: "boolean" },
      yes: { type: "boolean" },
      revision: { type: "string" },
    },
  });
  if (values.help) {
    console.log(
      "grait upgrade --plan --revision GIT_PIN\nRun the CLI pinned to the target revision. Inspect the plan, then rerun without --plan or use --yes to apply it.",
    );
    return 0;
  }
  if (values.plan && values.yes) throw new Error("Choose either --plan or --yes");
  const revision = await resolveInstallRevision(values.revision, {
    requireInstalled: !values.plan,
  });
  const root = await realpath(await targetRoot(cwd));
  const config = await readArtifact(root, configPath);
  const repo = config && JSON.parse(config).controllerRepository;
  if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new Error("Install GRAIT with a bound repository before upgrading");
  const input = { root, repo, revision, version };
  const store = await installerStore(input);
  const transaction = pendingArtifactTransaction(store, "upgrade");
  if (transaction && transaction.revision !== revision)
    throw new Error("Retry the interrupted upgrade with its recorded GRAIT Git revision");
  const preview = transaction ? null : await buildUpgrade(input);
  console.log(
    transaction
      ? "An interrupted upgrade needs recovery. A confirmed retry will recover its journal before previewing the remaining changes."
      : renderInstallationPlan(preview),
  );
  if (values.plan || (preview && !preview.changes.length)) return 0;
  await confirm(
    transaction
      ? "Recover the interrupted upgrade and preview the remaining changes?"
      : "Apply this upgrade plan?",
    values.yes,
  );

  await store.acquire();
  try {
    if (transaction) await recoverArtifactTransaction({ root, store, transaction });
    const current = await buildUpgrade(input);
    if (transaction) {
      console.log(renderInstallationPlan(current));
      if (current.changes.length) await confirm("Apply this upgrade plan?", values.yes);
    } else assertExpectedChanges(preview.changes, current.changes);
    if (!current.changes.length) return 0;
    await applyArtifactTransaction({ ...input, ...current, store, operation: "upgrade" });
  } finally {
    await store.release();
  }
  console.log(
    "Workflow upgraded. Review and commit the artifact and installation record changes together.",
  );
  return 0;
}

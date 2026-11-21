import { realpath, rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import { preserveCodeowners } from "../scripts/lib/bootstrap.mjs";
import { validateConfig } from "../scripts/lib/policy.mjs";
import { confirm } from "../scripts/lib/setup-process.mjs";
import {
  applyArtifacts,
  readArtifact,
  recoverArtifacts,
  stageArtifacts,
} from "./artifact-stage.mjs";
import { renderInstallationPlan } from "./installation-cli.mjs";
import {
  artifactOwnership,
  installationPath,
  installerWorkflow,
  readInstallation,
  validateInstallation,
  validateTarget,
} from "./installation-record.mjs";
import { resolveInstallRevision } from "./installation-revision.mjs";
import { installerStore, privateStagingDirectory } from "./installer-services.mjs";
import { pinnedValidationWorkflow } from "./installer.mjs";
import {
  indexedFiles,
  isLegacyScaffold,
  loadLegacyTemplate,
  validateLegacyRevision,
  verifiedTemplateFile,
} from "./legacy-template.mjs";
import { generateProjectArtifacts } from "./project-policy.mjs";
import { targetRoot } from "./runtime.mjs";

const configPath = "workflow.config.json";
const ownersPath = ".github/CODEOWNERS";
const workflowPath = `.github/workflows/${installerWorkflow}`;

async function migrationPlan({
  root,
  config,
  repo,
  harness,
  maintainers,
  version,
  revision,
  template,
}) {
  if (await readInstallation(root)) {
    const { record } = await validateInstallation(root);
    if (record.revision !== revision || record.version !== version)
      throw new Error(
        "GRAIT is already installed. Use grait upgrade to change its pinned revision",
      );
    return { changes: [], retained: [] };
  }
  if ((await readArtifact(root, configPath)) !== config)
    throw new Error("Workflow configuration changed during migration. Review the plan and retry");

  const project = {};
  const options = { harness, version, project };
  const generated = await generateProjectArtifacts(options);
  const indexed = await indexedFiles(root);
  const before = { [configPath]: config, [installationPath]: null };
  const existing = {};
  for (const path of Object.keys(generated)) {
    before[path] = await readArtifact(root, path);
    const stock = await verifiedTemplateFile(root, path, template.get(path), indexed.get(path));
    if (before[path] !== null && stock?.content !== before[path]) existing[path] = before[path];
  }

  before[ownersPath] = await readArtifact(root, ownersPath);
  let owners =
    before[ownersPath] ??
    (await readArtifact(root, "CODEOWNERS")) ??
    (await readArtifact(root, "docs/CODEOWNERS"));
  if (owners === null) {
    if (!maintainers.length || maintainers.some((login) => !/^[a-z0-9-]+$/i.test(login)))
      throw new Error("Configure human CODEOWNERS before migrating this template");
    owners = preserveCodeowners("", maintainers);
  }

  before[workflowPath] = await readArtifact(root, workflowPath);
  const workflow = pinnedValidationWorkflow(revision);
  if (before[workflowPath] !== null && before[workflowPath] !== workflow)
    throw new Error("The existing .github/workflows/grait.yml conflicts with the pinned workflow");

  const policy = await generateProjectArtifacts({ ...options, existing });
  for (const [path, content] of Object.entries(existing)) {
    if (/grait:policy:(?:start|end)/.test(content) && policy[path] !== content)
      throw new Error(`Existing managed policy cannot be verified for migration: ${path}`);
  }
  const artifacts = {
    ...policy,
    [configPath]: config,
    [ownersPath]: owners,
    [workflowPath]: workflow,
  };
  const record = {
    schemaVersion: 1,
    version,
    revision,
    repository: repo,
    harness,
    project,
    artifacts: Object.fromEntries(
      Object.entries(artifacts).map(([path, content]) => [path, artifactOwnership(path, content)]),
    ),
  };
  artifacts[installationPath] = `${JSON.stringify(record, null, 2)}\n`;

  const retained = [];
  const modes = new Map();
  for (const [path, entry] of template) {
    if (!isLegacyScaffold(path) || Object.hasOwn(artifacts, path)) continue;
    const stock = await verifiedTemplateFile(root, path, entry, indexed.get(path));
    if (!stock) {
      if (indexed.has(path)) retained.push(path);
      continue;
    }
    before[path] = stock.content;
    artifacts[path] = null;
    modes.set(path, stock.mode);
  }
  const changes = Object.keys(artifacts)
    .sort()
    .filter((path) => before[path] !== artifacts[path])
    .map((path) => ({ path, before: before[path], after: artifacts[path], mode: modes.get(path) }));
  return { artifacts, changes, retained };
}

function printPlan(plan) {
  console.log(renderInstallationPlan(plan));
  if (plan.retained.length)
    console.log(
      `Retained legacy files that differ from the pinned template:\n${plan.retained.join("\n")}`,
    );
}

function assertSameChanges(expected, actual) {
  if (
    expected.length !== actual.length ||
    expected.some(({ path, before, after, mode }, index) => {
      const change = actual[index];
      return (
        path !== change.path ||
        before !== change.before ||
        after !== change.after ||
        (mode !== undefined && mode !== change.mode)
      );
    })
  )
    throw new Error("Project artifacts changed since preview. Review the plan and retry");
}

async function clearTransaction(store, transaction) {
  delete store.state.artifactTransaction;
  try {
    await store.save();
  } catch (error) {
    store.state.artifactTransaction = transaction;
    throw error;
  }
  await rm(transaction.directory, { recursive: true, force: true });
}

async function applyMigration({ root, revision, legacyRevision, store, plan }) {
  const directory = await privateStagingDirectory(root, "grait-artifacts-");
  try {
    const staged = await stageArtifacts({
      root,
      artifacts: plan.artifacts,
      stateDirectory: directory,
    });
    assertSameChanges(plan.changes, staged.changes);
    const transaction = {
      operation: "migrate",
      directory,
      id: staged.id,
      revision,
      legacyRevision,
    };
    store.state.artifactTransaction = transaction;
    await store.save();
    await applyArtifacts({ root, stateDirectory: directory, id: staged.id });
    await clearTransaction(store, transaction);
  } finally {
    if (!store.state.artifactTransaction) await rm(directory, { recursive: true, force: true });
  }
}

export async function runMigration({ args, cwd, version }) {
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      plan: { type: "boolean" },
      yes: { type: "boolean" },
      revision: { type: "string" },
      "legacy-revision": { type: "string" },
    },
  });
  if (values.help) {
    console.log(
      "grait migrate --plan --revision GIT_PIN --legacy-revision TEMPLATE_SHA\nPreview migration of a configured template repository. Use the full SHA of its original GRAIT template commit. Review the plan, then rerun without --plan or use --yes to apply it.",
    );
    return 0;
  }
  if (values.plan && values.yes) throw new Error("Choose either --plan or --yes");
  const legacyRevision = validateLegacyRevision(values["legacy-revision"]);
  const revision = await resolveInstallRevision(values.revision, {
    requireInstalled: !values.plan,
  });
  const root = await realpath(await targetRoot(cwd));
  const config = await readArtifact(root, configPath);
  if (config === null)
    throw new Error("A configured template repository needs workflow.config.json");
  const {
    controllerRepository: repo,
    engine: harness,
    humanOperators: maintainers = [],
  } = validateConfig(JSON.parse(config));
  validateTarget({ repository: repo, harness, version });

  const store = await installerStore({ root, repo });
  const transaction = store.state.artifactTransaction;
  if (transaction && transaction.operation !== "migrate")
    throw new Error(
      `An artifact operation is interrupted. Finish grait ${transaction.operation ?? "init"} before migrating`,
    );
  if (
    transaction &&
    (transaction.revision !== revision || transaction.legacyRevision !== legacyRevision)
  )
    throw new Error(
      "Retry the interrupted migration with its original package and template Git pins",
    );

  if (transaction && values.plan) {
    console.log(
      "An interrupted migration needs recovery. A confirmed retry will recover its journal before previewing the remaining changes.",
    );
    return 0;
  }
  const template = await loadLegacyTemplate(root, legacyRevision);
  const inputs = { root, config, repo, harness, maintainers, version, revision, template };
  const preview = transaction ? null : await migrationPlan(inputs);
  if (preview) printPlan(preview);
  if (values.plan || (preview && !preview.changes.length)) return 0;
  await confirm(
    transaction
      ? "Recover the interrupted migration and preview the remaining changes?"
      : "Apply this migration plan?",
    values.yes,
  );
  await store.acquire();
  try {
    if (transaction) {
      await recoverArtifacts({ root, stateDirectory: transaction.directory, id: transaction.id });
      await clearTransaction(store, transaction);
    }
    const plan = await migrationPlan(inputs);
    if (preview) assertSameChanges(preview.changes, plan.changes);
    else {
      printPlan(plan);
      if (plan.changes.length) await confirm("Apply this migration plan?", values.yes);
    }
    if (!plan.changes.length) return 0;
    await applyMigration({ root, revision, legacyRevision, store, plan });
  } finally {
    await store.release();
  }
  console.log("Migration applied. Review and commit the complete artifact changes together.");
  return 0;
}

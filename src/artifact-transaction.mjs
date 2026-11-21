import { rm } from "node:fs/promises";
import { applyArtifacts, recoverArtifacts, stageArtifacts } from "./artifact-stage.mjs";
import { privateStagingDirectory } from "./installer-services.mjs";

export function pendingArtifactTransaction(store, operation) {
  const transaction = store.state.artifactTransaction;
  if (transaction && (transaction.operation ?? "init") !== operation)
    throw new Error(
      `Another artifact operation is interrupted. Retry grait ${transaction.operation ?? "init"} from its original worktree and pinned package.`,
    );
  return transaction;
}

async function clearTransaction(store, transaction) {
  delete store.state.artifactTransaction;
  try {
    await store.save();
  } catch (error) {
    // Preserve the recovery files if the checkpoint could still refer to them.
    store.state.artifactTransaction = transaction;
    throw error;
  }
}

export async function recoverArtifactTransaction({ root, store, transaction }) {
  await recoverArtifacts({ root, stateDirectory: transaction.directory, id: transaction.id });
  await clearTransaction(store, transaction);
  await rm(transaction.directory, { recursive: true, force: true });
}

export function assertExpectedChanges(expected, actual) {
  if (
    actual.length !== expected.length ||
    actual.some(
      ({ path, before, after }, index) =>
        path !== expected[index].path ||
        before !== expected[index].before ||
        after !== expected[index].after,
    )
  )
    throw new Error("Project artifacts changed since preview. Review the plan and retry.");
}

/** Call while holding the target's setup lock. */
export async function applyArtifactTransaction({
  root,
  store,
  revision,
  operation,
  artifacts,
  changes,
  onPlan,
}) {
  const directory = await privateStagingDirectory(root, "grait-artifacts-");
  try {
    const plan = await stageArtifacts({ root, artifacts, stateDirectory: directory });
    assertExpectedChanges(changes, plan.changes);
    await onPlan?.(plan);
    const transaction = { directory, id: plan.id, revision, operation };
    store.state.artifactTransaction = transaction;
    await store.save();
    await applyArtifacts({ root, stateDirectory: directory, id: plan.id });
    await clearTransaction(store, transaction);
  } finally {
    if (!store.state.artifactTransaction) await rm(directory, { recursive: true, force: true });
  }
}

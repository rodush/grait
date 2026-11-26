import { realpath, rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import { command } from "../scripts/lib/setup-process.mjs";
import { SetupState } from "../scripts/lib/setup-state.mjs";
import { sameLogin } from "../scripts/lib/policy.mjs";
import { targetRoot } from "./runtime.mjs";
import { activateMain } from "../scripts/activate.mjs";
import { installWorkflow, planInstallation } from "./installer.mjs";
import { assertIntegrationBranch, initContext } from "./init-context.mjs";
import { preflightInstallation, privateStagingDirectory } from "./installer-services.mjs";
import {
  installerWorkflow,
  readInstallation,
  validateInstallation,
} from "./installation-record.mjs";
import { verifyInstallationMerge } from "./installation-merge.mjs";
import {
  fetchInitRevision,
  initSelector,
  requireInstalledProvenance,
} from "./installation-revision.mjs";
import { setupWarning } from "../scripts/lib/bootstrap.mjs";
import { confirmSetup } from "./setup-terminal.mjs";

export function renderInstallationPlan(plan) {
  return (
    plan.changes
      .map(
        ({ path, before, after }) =>
          `--- ${before === null ? "/dev/null" : `a/${path}`}\n+++ ${after === null ? "/dev/null" : `b/${path}`}\n@@\n${
            before === null
              ? ""
              : before
                  .split("\n")
                  .map((line) => `-${line}`)
                  .join("\n") + "\n"
          }${
            after === null
              ? ""
              : after
                  .split("\n")
                  .map((line) => `+${line}`)
                  .join("\n")
          }`,
      )
      .join("\n\n") || "No artifact changes."
  );
}

function selectedRevisionArgs(args, revision) {
  const forwarded = [];
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--revision") index++;
    else if (!option.startsWith("--revision=")) forwarded.push(option);
  }
  return [...forwarded, "--revision", revision];
}

async function runSelectedInit(root, selector, args) {
  const stage = await privateStagingDirectory(root, "grait-init-");
  try {
    const { cliPath, revision } = await fetchInitRevision({ stage, selector });
    const { code } = await command(
      process.execPath,
      [cliPath, "--cwd", root, "init", ...selectedRevisionArgs(args, revision)],
      { interactive: true, allowFailure: true },
    );
    return code ?? 1;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

function summarizeInputs(options) {
  const savedApps = Object.entries(options.state.apps)
    .filter(([, value]) => value.installed)
    .map(([role]) => role);
  const project =
    options.projectSummary ??
    (options.projectNumber
      ? [options.projectOwner ?? options.repo.split("/")[0], "#" + options.projectNumber].join(" ")
      : "Create or reuse the repository's Project");
  console.log(
    "\nGRAIT setup plan\n" +
      "  Repository: " +
      options.repo +
      "\n" +
      "  Revision: " +
      options.verifiedRevision +
      "\n" +
      "  Harness: " +
      options.harness +
      "\n" +
      "  Maintainers: " +
      (options.maintainers.length ? options.maintainers.join(", ") : "Applying administrator") +
      "\n" +
      "  Project: " +
      project +
      "\n" +
      "  Publishing Apps: " +
      (savedApps.length
        ? "Reuse verified " + savedApps.join(" and ") + " when available"
        : "Create or reconcile writer and reviewer"),
  );
}

export async function runInstallation({ command: operation, args, cwd, version }) {
  const initOptions = {
    plan: { type: "boolean" },
    yes: { type: "boolean" },
    repo: { type: "string" },
    harness: { type: "string" },
    revision: { type: "string" },
    maintainers: { type: "string" },
    "project-name": { type: "string" },
    "project-context": { type: "string" },
    "project-owner": { type: "string" },
    "project-number": { type: "string" },
    "writer-key": { type: "string" },
    "reviewer-key": { type: "string" },
    "no-browser": { type: "boolean" },
  };
  const { values } = parseArgs({
    args,
    options: {
      help: { type: "boolean", short: "h" },
      ...(operation === "init" ? initOptions : {}),
      ...(operation !== "validate" ? { "acknowledge-unenforced-rules": { type: "boolean" } } : {}),
    },
  });
  if (values.help) {
    console.log(
      operation === "init"
        ? "grait init [--plan|--yes] [--repo OWNER/REPO] [--revision SHA|vX.X.X] [--harness codex|claude|copilot]\nUses the verified installed Git revision by default. A 12-character SHA prefix is also accepted.\nOptional: --maintainers LOGIN,LOGIN --project-owner LOGIN --project-number N\n          --project-name TEXT --project-context TEXT --no-browser\n          --writer-key PATH --reviewer-key PATH --acknowledge-unenforced-rules"
        : operation === "activate"
          ? "grait activate [--acknowledge-unenforced-rules]\nRequires human merge of the installed artifacts, successful default-branch CI, and the configured administrator and App identities."
          : "grait validate\nCheck the installed workflow configuration and durable artifact ownership metadata. Run application tests separately.",
    );
    return 0;
  }
  const root = await realpath(await targetRoot(cwd));
  if (operation === "validate") {
    const { record } = await validateInstallation(root);
    console.log(
      "Installed GRAIT " +
        record.version +
        " at " +
        record.revision +
        " is valid. Run application checks separately.",
    );
    return 0;
  }
  if (operation === "activate") {
    return activateMain(args, {
      cwd: root,
      readInstalled: validateInstallation,
      verifyMerge: verifyInstallationMerge,
      workflow: installerWorkflow,
    });
  }

  if (values.plan && values.yes) throw new Error("Choose either --plan or --yes");
  const explicitSelector = initSelector(values.revision);
  const provenance = await requireInstalledProvenance();
  const { state: recordedState } = await SetupState.read(undefined, root);
  const transaction = recordedState.artifactTransaction;
  const sameTarget = !values.repo || sameLogin(values.repo, recordedState.repo);
  let savedRevision;
  if (!explicitSelector && sameTarget) {
    savedRevision =
      transaction && (transaction.operation ?? "init") === "init"
        ? transaction.revision
        : !(await readInstallation(root))
          ? recordedState.initAnswers?.revision
          : undefined;
  }
  const selector = explicitSelector ?? savedRevision;
  if (selector && !provenance.revision.startsWith(selector)) {
    if (
      savedRevision ||
      selector.startsWith("v") ||
      (provenance.kind === "global" && selector.length === 40)
    )
      return runSelectedInit(root, selector, args);
    throw new Error(
      "Requested Git revision " +
        selector +
        " does not match the running GRAIT package (" +
        provenance.revision +
        "). Run the Git-pinned npm exec package for the requested SHA.",
    );
  }

  let options = await initContext({
    root,
    version,
    verifiedRevision: provenance.revision,
    recordedState,
    repo: values.repo,
    harness: values.harness,
    maintainers: values.maintainers,
    projectOwner: values["project-owner"],
    projectNumber: values["project-number"],
    writerKey: values["writer-key"],
    reviewerKey: values["reviewer-key"],
    noBrowser: values["no-browser"],
    acknowledgeUnenforcedRules: values["acknowledge-unenforced-rules"],
    ...(values["project-name"] || values["project-context"]
      ? { project: { name: values["project-name"], context: values["project-context"] } }
      : {}),
  });
  const canApprove = values.yes || process.stdin.isTTY;
  const existingPlan = options.prior ? await planInstallation(options) : null;
  const unchanged = existingPlan && !existingPlan.pendingRecovery && !existingPlan.changes.length;
  if (!values.plan && !unchanged && options.defaultBranch)
    await assertIntegrationBranch(root, options.defaultBranch);
  if (!values.plan && canApprove && !unchanged) options = await preflightInstallation(options);
  const plan = unchanged ? existingPlan : await planInstallation(options);
  summarizeInputs(options);
  if (plan.pendingRecovery) {
    setupWarning(
      "An interrupted installation needs recovery. A confirmed retry will recover its journal before previewing the remaining artifact changes.",
    );
  } else {
    console.log("\n" + renderInstallationPlan(plan));
  }
  if (values.plan || unchanged) return 0;
  const additions = options.maintainers.filter(
    (login) =>
      !options.knownMaintainers.some((known) => known.toLowerCase() === login.toLowerCase()),
  );
  if (additions.length) {
    await confirmSetup(
      "Confirm the proposed maintainer access for " +
        additions.map((login) => "@" + login).join(", ") +
        ".",
      values.yes,
    );
  }
  await confirmSetup(
    plan.pendingRecovery
      ? "Recover the interrupted installation and preview the remaining changes?"
      : "Apply this plan and provision the local workflow? GitHub approvals remain interactive.",
    values.yes,
  );
  const result = await installWorkflow({
    ...options,
    revision: plan.revision,
    preview: plan.changes,
    pendingRecovery: plan.pendingRecovery,
    onRecoveredPlan: async (recoveredPlan) => {
      console.log("\n" + renderInstallationPlan(recoveredPlan));
      if (recoveredPlan.changes.length)
        await confirmSetup("Apply this plan and provision the local workflow?", values.yes);
    },
    onPlan: async (finalPlan) => {
      console.log("\n" + renderInstallationPlan(finalPlan));
      await confirmSetup("Apply this complete configuration to the worktree?", values.yes);
    },
  });
  if (result.changes.length) {
    console.log(
      "\nWorkflow artifacts applied together.\n" +
        "1. Review and commit the generated files together, then push your integration branch.\n" +
        "2. Open a configuration PR into " +
        (options.defaultBranch ?? "the default branch") +
        " and have a human merge it.\n" +
        "3. Wait for GRAIT validation on the updated default branch, switch to it, then run grait activate.\n" +
        "A direct push of the setup files to the default branch blocks activation.",
    );
  } else {
    console.log("\nWorkflow installation is unchanged.");
  }
  return 0;
}

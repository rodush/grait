import { parseArgs } from "node:util";
import { confirm } from "../scripts/lib/setup-process.mjs";
import { runRuntime, targetRoot } from "./runtime.mjs";
import { installWorkflow, planInstallation } from "./installer.mjs";
import { validateInstallation } from "./installation-record.mjs";

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

export async function runInstallation({ command, args, cwd, version }) {
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
      ...(command === "init" ? initOptions : {}),
      ...(command !== "validate" ? { "acknowledge-unenforced-rules": { type: "boolean" } } : {}),
    },
  });
  if (values.help) {
    console.log(
      command === "init"
        ? "grait init --plan --repo OWNER/REPO --revision GIT_PIN [--harness codex|claude|copilot]\nUse the full Git commit SHA or its 12-character prefix. Review the plan, then run the same command with --yes.\nOptional: --maintainers LOGIN,LOGIN --project-owner LOGIN --project-number N\n          --project-name TEXT --project-context TEXT --no-browser\n          --writer-key PATH --reviewer-key PATH --acknowledge-unenforced-rules\nNo GRAIT source or development dependencies are installed in the application."
        : command === "activate"
          ? "grait activate [--acknowledge-unenforced-rules]\nRequires human merge of the installed artifacts, successful default-branch CI, and the configured administrator and App identities."
          : "grait validate\nCheck the installed workflow configuration and durable artifact ownership metadata. Run application tests separately.",
    );
    return 0;
  }
  const root = await targetRoot(cwd);
  const options = {
    root,
    version,
    repo: values.repo,
    harness: values.harness,
    revision: values.revision,
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
  };
  if (command === "validate") {
    const { record } = await validateInstallation(root);
    console.log(
      `Installed GRAIT ${record.version} at ${record.revision} is valid. Run application checks separately.`,
    );
    return 0;
  }
  if (command === "activate") return runRuntime({ command, args, cwd: root });
  const plan = await planInstallation(options);
  console.log(
    plan.pendingRecovery
      ? "An interrupted installation needs recovery. A confirmed retry will recover its journal before previewing the remaining artifact changes."
      : renderInstallationPlan(plan),
  );
  if (values.plan) return 0;
  await confirm(
    plan.pendingRecovery
      ? "Recover the interrupted installation and preview the remaining changes?"
      : "Apply this plan and provision the local workflow? GitHub approvals remain interactive.",
    values.yes,
  );
  const result = await installWorkflow({
    ...options,
    repo: plan.repo,
    revision: plan.revision,
    preview: plan.changes,
    pendingRecovery: plan.pendingRecovery,
    onRecoveredPlan: async (recoveredPlan) => {
      console.log(renderInstallationPlan(recoveredPlan));
      if (recoveredPlan.changes.length)
        await confirm("Apply this plan and provision the local workflow?", values.yes);
    },
    onPlan: async (finalPlan) => {
      console.log(renderInstallationPlan(finalPlan));
      await confirm("Apply this complete configuration to the worktree?", values.yes);
    },
  });
  console.log(
    result.changes.length
      ? "Workflow artifacts applied together. Review and commit the complete change in one PR; a human must merge it before grait activate."
      : "Workflow installation is unchanged.",
  );
  return 0;
}

import { readFile } from "node:fs/promises";
import { GitHub } from "./lib/github.mjs";
import { Ledger } from "./lib/ledger.mjs";
import { issueDigest, positiveInteger, sameLogin } from "./lib/policy.mjs";

try {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const inputs = event.inputs || {};
  const repo = process.env.GITHUB_REPOSITORY;
  const config = JSON.parse(await readFile("workflow.config.json", "utf8"));
  if (process.env.AUTOMATION_ENABLED !== "true" || !sameLogin(config.controllerRepository, repo))
    throw new Error("Controller is not enabled for this repository");
  if (
    process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    process.env.GITHUB_REF !== `refs/heads/${event.repository.default_branch}`
  )
    throw new Error("Agent workflows must be dispatched on the default branch");
  if (!positiveInteger(inputs.number)) throw new Error("Invalid issue or PR number");
  const names = {
    "Agent triage": "triage",
    "Agent implementation": "implement",
    "Agent PR review": "review",
    "Agent fixes": "fix",
  };
  const kind = names[process.env.GITHUB_WORKFLOW];
  if (!kind) throw new Error("Unknown agent workflow");
  const api = new GitHub(process.env.GH_TOKEN);
  const { state } = await new Ledger(api, repo, process.env.AUTOMATION_LOGIN).load(
    Number(inputs.number),
  );
  if (
    state.paused ||
    state.pending?.operation !== inputs.operation_id ||
    state.pending?.kind !== kind
  )
    throw new Error("Dispatch does not match the active controller operation");
  for (const [key, value] of Object.entries(state.pending)) {
    if (["kind", "operation", "at", "patch"].includes(key)) continue;
    if (String(value) !== inputs[key])
      throw new Error(`Dispatch ${key} differs from its authorization`);
  }
  const issue = await api.request(`repos/${repo}/issues/${inputs.number}`);
  if (
    issue.labels.some((label) =>
      [config.labels.paused, config.labels.needsHuman].includes(label.name),
    )
  )
    throw new Error("Work was paused");
  if (["triage", "implement"].includes(kind)) {
    if (issue.state !== "open" || inputs.digest !== issueDigest(issue))
      throw new Error("Issue changed or closed since dispatch");
  } else {
    const pr = await api.request(`repos/${repo}/pulls/${inputs.number}`);
    if (pr.state !== "open" || pr.draft || pr.head.sha !== inputs.head)
      throw new Error("PR changed, closed, or became draft since dispatch");
    if (
      kind === "fix" &&
      (!sameLogin(pr.user.login, process.env.AUTOMATION_LOGIN) ||
        pr.head.repo?.full_name !== repo ||
        pr.head.ref !== `agent/issue-${inputs.issue}` ||
        !pr.labels.some((label) => label.name === config.labels.automated))
    )
      throw new Error("This branch is not owned by the managed implementation workflow");
  }
  console.log(`Authorized ${kind} operation for #${inputs.number}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

import { readFile } from "node:fs/promises";
import { admitted } from "./lib/admission.mjs";
import { GitHub } from "./lib/github.mjs";
import { Ledger } from "./lib/ledger.mjs";
import { issueDigest, positiveInteger, sameLogin } from "./lib/policy.mjs";

try {
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const inputs = event.inputs || {};
  if (
    process.env.GITHUB_RUN_ATTEMPT !== "1" ||
    !sameLogin(process.env.GITHUB_ACTOR, process.env.AUTOMATION_LOGIN)
  )
    throw new Error(
      "Only fresh controller dispatches may consume a budget reservation; reruns are forbidden",
    );
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
    "Agent tester": "test",
    "Agent developer": "develop",
    "TDD verification": "verify",
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
  const budgetNumber = Number(process.env.AUTOMATION_BUDGET_ISSUE);
  if (!positiveInteger(budgetNumber)) throw new Error("Missing budget issue");
  const budget = await new Ledger(api, repo, process.env.AUTOMATION_BUDGET_LOGIN).load(
    budgetNumber,
  );
  const reservations = budget.state.reservations?.filter(
    (entry) => entry.operation === inputs.operation_id,
  );
  if (
    !budget.comment ||
    reservations?.length !== 1 ||
    reservations[0].completed ||
    reservations[0].kind !== kind
  )
    throw new Error("Dispatch has no active budget reservation");
  const issue = await api.request(`repos/${repo}/issues/${inputs.number}`);
  if (!(await admitted(api, repo, issue, config, process.env.AUTOMATION_LOGIN)))
    throw new Error("Issue or PR no longer admitted for automation");
  if (
    issue.labels.some((label) =>
      [config.labels.paused, config.labels.needsHuman].includes(label.name),
    )
  )
    throw new Error("Work was paused");
  if (["test", "develop", "verify"].includes(kind)) {
    const tdd = state.tdd;
    if (
      !tdd ||
      tdd.head !== inputs.head ||
      tdd.acceptanceDigest !== inputs.digest ||
      Number(inputs.cycle) !== tdd.cycle ||
      issue.state !== "open" ||
      issueDigest(issue) !== inputs.digest
    )
      throw new Error("Stale TDD handoff");
    const owner = kind === "test" ? "tester" : kind === "develop" ? "implementer" : tdd.owner;
    if (
      tdd.owner !== owner ||
      (kind === "test" && tdd.stage !== "test") ||
      (kind === "develop" && tdd.stage !== "develop")
    )
      throw new Error("TDD role does not own this handoff");
    if (Number(inputs.pr)) {
      const pr = await api.request(`repos/${repo}/pulls/${inputs.pr}`);
      if (
        pr.state !== "open" ||
        pr.head.sha !== inputs.head ||
        !(
          sameLogin(pr.user.login, process.env.AUTOMATION_LOGIN) ||
          sameLogin(pr.user.login, tdd.localActor)
        ) ||
        pr.head.repo?.full_name !== repo ||
        pr.head.ref !== tdd.branch
      )
        throw new Error("Managed TDD branch changed");
    }
    if (kind === "verify" && !["verify-red", "verify-green"].includes(tdd.stage))
      throw new Error("Unexpected TDD verification phase");
  } else if (["triage", "implement"].includes(kind)) {
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

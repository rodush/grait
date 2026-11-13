import { sanitizeObservation } from "../adapters/test-observation.mjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { digest } from "./policy.mjs";
import { issueDigest, parseBlock, sameLogin } from "./policy.mjs";
import {
  assertRoleChanges,
  createHandoff,
  validateTddExemption,
  handoffToImplementer,
  returnToTester,
  completeImplementation,
} from "./tdd.mjs";

export class TddCoordinator {
  constructor(controller) {
    this.c = controller;
  }
  async start(item, state, { pr = null, rethink = false, persist = true } = {}) {
    const c = this.c;
    const exemption = validateTddExemption(state.tddPolicy);
    if (!exemption.required) return false;
    if (!c.config.tdd?.runner?.command?.length)
      throw new Error("Configure a TDD runner before claiming testable work");
    const baseline =
      pr?.head.sha ||
      (
        await c.api.request(
          `repos/${c.repo}/commits/${encodeURIComponent(c.repository.default_branch)}`,
        )
      ).sha;
    state.tdd = {
      ...createHandoff({
        issue: item.content.number,
        branch: `agent/issue-${item.content.number}`,
        head: baseline,
        baseline,
        acceptanceDigest: state.triagedDigest,
      }),
      pr: pr?.number || 0,
      followup: !!pr,
      rethink,
      stage: "test",
      expectedFailures: [],
    };
    if (persist) await c.ledger.save(item.content.number);
    return true;
  }
  async metadata(number, operation) {
    const c = this.c;
    const comments = await c.api.list(`repos/${c.repo}/issues/${number}/comments`);
    const matches = comments
      .filter(
        (entry) =>
          sameLogin(entry.user.login, c.writer) && entry.body.includes("```workflow-handoff"),
      )
      .map((entry) => {
        try {
          return parseBlock(entry.body, "workflow-handoff");
        } catch {
          return null;
        }
      })
      .filter((value) => value?.operation === operation);
    if (matches.length !== 1)
      throw new Error("Expected one writer handoff for the active TDD operation");
    return matches[0];
  }
  async pr(tdd) {
    const c = this.c;
    if (!tdd.pr) {
      const prs = await c.api.list(
        `repos/${c.repo}/pulls?state=open&head=${encodeURIComponent(c.repository.owner.login + ":" + tdd.branch)}`,
      );
      const matching = prs.filter(
        (pr) =>
          (sameLogin(pr.user.login, c.writer) || sameLogin(pr.user.login, tdd.localActor)) &&
          pr.head.repo?.full_name === c.repo &&
          pr.head.ref === tdd.branch,
      );
      if (matching.length !== 1)
        throw new Error("Tester did not create exactly one managed issue PR");
      tdd.pr = matching[0].number;
    }
    const pr = await c.api.request(`repos/${c.repo}/pulls/${tdd.pr}`);
    if (
      pr.state !== "open" ||
      !(sameLogin(pr.user.login, c.writer) || sameLogin(pr.user.login, tdd.localActor)) ||
      pr.head.repo?.full_name !== c.repo ||
      pr.head.ref !== tdd.branch ||
      !pr.labels.some((label) => label.name === c.config.labels.automated)
    )
      throw new Error("TDD PR is not the managed shared issue branch");
    return pr;
  }
  async changed(base, head, role) {
    const c = this.c;
    const comparison = await c.api.request(`repos/${c.repo}/compare/${base}...${head}`);
    if (
      !comparison.files?.length ||
      comparison.files.length >= 300 ||
      comparison.status !== "ahead" ||
      comparison.merge_base_commit?.sha !== base
    )
      throw new Error("TDD handoff must be a complete, forward-only change");
    assertRoleChanges(comparison.files, role, c.config);
  }
  async proof(pending) {
    const c = this.c;
    const run = await c.findRun(pending);
    if (
      run.path !== ".github/workflows/tdd-verify.yml" ||
      run.event !== "workflow_dispatch" ||
      run.run_attempt !== 1 ||
      !sameLogin(run.actor?.login, c.writer) ||
      run.head_branch !== c.repository.default_branch ||
      run.conclusion !== "success"
    )
      throw new Error("Untrusted TDD verifier run");
    const artifacts = await c.api.list(
      `repos/${c.repo}/actions/runs/${run.id}/artifacts`,
      "artifacts",
    );
    const matches = artifacts.filter(
      (artifact) =>
        artifact.name === "tdd-proof" && !artifact.expired && artifact.workflow_run?.id === run.id,
    );
    if (
      matches.length !== 1 ||
      matches[0].size_in_bytes > 1000000 ||
      !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest || "")
    )
      throw new Error("Missing or invalid TDD proof artifact");
    const bytes = await c.api.request(`repos/${c.repo}/actions/artifacts/${matches[0].id}/zip`, {
      binary: true,
    });
    if (bytes.length > 1000000 || `sha256:${digest(bytes)}` !== matches[0].digest)
      throw new Error("TDD artifact integrity mismatch");
    const directory = await mkdtemp(join(tmpdir(), "tdd-proof-"));
    let report;
    try {
      const archive = join(directory, "proof.zip");
      await writeFile(archive, bytes);
      const result = await promisify(execFile)("unzip", ["-p", archive, "proof.json"], {
        maxBuffer: 65536,
        timeout: 10000,
      });
      report = JSON.parse(result.stdout);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    if (report.operation !== pending.operation || report.runId !== String(run.id))
      throw new Error("TDD proof workflow provenance mismatch");
    return report;
  }
  async reconcile(item, state) {
    const c = this.c,
      number = item.content.number,
      t = state.tdd;
    if (!t || t.stage === "done") return false;
    if (t.acceptanceDigest !== issueDigest(item.content))
      throw new Error("TDD acceptance criteria changed");
    const pending = await c.completed(number, state);
    if (state.paused) return true;
    if (pending) {
      if (["test", "develop"].includes(pending.kind)) {
        const info = await this.metadata(number, pending.operation);
        if (info.action === "needs-triage")
          throw new Error(
            "TDD acceptance dispute requires triage or operator resolution; see the visible issue handoff",
          );
        const pr = await this.pr(t);
        const role = pending.kind === "test" ? "tester" : "implementer";
        if (pr.head.sha !== pending.head) await this.changed(pending.head, pr.head.sha, role);
        t.head = pr.head.sha;
        state.pr = pr.number;
        if (pending.kind === "test") {
          if (
            info.action !== "tests-ready" ||
            pr.head.sha === pending.head ||
            !Array.isArray(info.expectedFailures) ||
            !info.expectedFailures.length
          )
            throw new Error("Tester must supply changed tests and expected assertion failures");
          t.expectedFailures = info.expectedFailures;
          t.stage = "verify-red";
        } else if (info.action === "tests-needed") {
          const next = returnToTester(t, info.reason);
          Object.assign(t, next, { stage: "test" });
        } else {
          if (info.action !== "implemented" || pr.head.sha === pending.head)
            throw new Error(
              "Implementer must publish a production change or reasoned test handback",
            );
          t.stage = "verify-green";
        }
        state.pending = null;
      } else if (pending.kind === "verify") {
        const pr = await this.pr(t);
        if (pr.head.sha !== pending.head)
          throw new Error("Branch advanced during TDD verification");
        const report = await this.proof(pending);
        if (pending.phase === "red") {
          // The issue ledger is the implementer's public black-box feedback.
          // Retain identifiers and sanitized scalar outcomes, never test source.
          t.failures = report.failed.slice(0, 32).map((test) => ({
            id: test.id,
            ...(test.observation ? { observation: sanitizeObservation(test.observation) } : {}),
          }));
          t.failureCount = report.failed.length;
          Object.assign(t, handoffToImplementer(t, report, t.expectedFailures), {
            stage: "develop",
          });
        } else {
          Object.assign(t, completeImplementation(t, report), { stage: "done" });
          const prState = (await c.ledger.load(pr.number)).state;
          if (t.followup) prState.fixAttempts = (prState.fixAttempts || 0) + 1;
          prState.tddGreenHead = t.head;
          await c.ledger.save(pr.number);
          if (pr.draft)
            await c.api.graphql(
              `mutation($id: ID!) { markPullRequestReadyForReview(input:{pullRequestId:$id}) { pullRequest { id } } }`,
              { id: pr.node_id },
            );
          state.phase = "review";
          await c.project.move(item, c.config.statuses.review);
        }
        state.pending = null;
      } else throw new Error("Unexpected operation owns the TDD issue");
      await c.ledger.save(number);
    }
    if (
      state.pending ||
      state.paused ||
      t.stage === "done" ||
      (t.localActor && ["test", "develop"].includes(t.stage))
    )
      return true;
    const inputs = { digest: t.acceptanceDigest, head: t.head, pr: t.pr, cycle: t.cycle };
    if (t.stage === "test") await c.dispatch(number, state, "test", inputs);
    else if (t.stage === "develop") await c.dispatch(number, state, "develop", inputs);
    else
      await c.dispatch(number, state, "verify", {
        ...inputs,
        baseline: t.stage === "verify-red" ? t.baseline : t.redHead,
        phase: t.stage === "verify-red" ? "red" : "green",
        expected: JSON.stringify(t.expectedFailures),
      });
    return true;
  }
}

import { admitted, DispatchBudget } from "./admission.mjs";
import { randomUUID } from "node:crypto";
import { Ledger } from "./ledger.mjs";
import { Project } from "./project.mjs";
import {
  assertAcyclic,
  availableSlots,
  conventionalTitle,
  dependencyComplete,
  issueDigest,
  loopDecision,
  parseBlock,
  patchDigest,
  positiveInteger,
  sameLogin,
  validateConfig,
  validateReview,
  validateTriage,
} from "./policy.mjs";

const WORKFLOWS = {
  triage: "triage.lock.yml",
  implement: "implement.lock.yml",
  review: "review.lock.yml",
  fix: "fix.lock.yml",
};
const issueRef = (issue) =>
  `${issue.repository_url.split("/repos/")[1]}#${issue.number}`.toLowerCase();

export class Controller {
  constructor({
    api,
    projectApi,
    repo,
    projectId,
    writer,
    reviewer,
    config,
    budgetIssue,
    budgetLogin,
    now = () => new Date(),
  }) {
    this.api = api;
    this.projectApi = projectApi;
    this.repo = repo;
    this.writer = writer;
    this.reviewer = reviewer;
    this.config = validateConfig(config);
    this.now = now;
    this.ledger = new Ledger(api, repo, writer);
    this.project = new Project(projectApi, projectId, config.statuses);
    this.dependencies = new Map();
    this.budgetIssue = Number(budgetIssue);
    this.budget = new DispatchBudget(
      new Ledger(api, repo, budgetLogin),
      this.budgetIssue,
      config.budget,
      (pending) => this.findRun(pending),
      now,
    );
    if (!writer || !reviewer || sameLogin(writer, reviewer))
      throw new Error("Distinct implementation and review identities are required");
    if (!sameLogin(config.controllerRepository, repo))
      throw new Error("This repository is not the designated project controller");
  }

  async initialize() {
    this.repository = await this.api.request(`repos/${this.repo}`);
    await this.project.load();
    if (!sameLogin(this.project.controller, this.repo))
      throw new Error("Project binding does not name this controller repository");
    return this;
  }

  async pause(number, state, reason) {
    state.paused = true;
    state.reason = reason;
    state.lastStoppedOperation = state.pending || null;
    state.pending = null;
    await this.ledger.save(number);
    if (state.lastStoppedOperation) {
      const run = await this.findRun(state.lastStoppedOperation);
      if (run && run.status !== "completed") {
        await this.api.request(`repos/${this.repo}/actions/runs/${run.id}/cancel`, {
          method: "POST",
        });
      }
    }
    await this.api.request(`repos/${this.repo}/issues/${number}/labels`, {
      method: "POST",
      body: { labels: [this.config.labels.needsHuman] },
    });
    await this.ledger.save(number);
  }

  async dispatch(number, state, kind, inputs, onReserved = async () => {}) {
    const operation = `${kind}-${number}-${randomUUID()}`;
    const pending = { kind, operation, at: this.now().toISOString(), ...inputs };
    if (!(await this.budget.reserve(pending))) {
      state.reason = "Waiting for global automation concurrency or rolling daily credit budget";
      await this.ledger.save(number);
      return false;
    }
    await onReserved();
    state.pending = pending;
    await this.ledger.save(number); // Persist intent before dispatch; uncertain dispatches are never retried blindly.
    try {
      await this.api.request(`repos/${this.repo}/actions/workflows/${WORKFLOWS[kind]}/dispatches`, {
        method: "POST",
        body: {
          ref: this.repository.default_branch,
          inputs: {
            number: String(number),
            operation_id: operation,
            ...Object.fromEntries(
              Object.entries(inputs)
                .filter(([key]) => key !== "patch")
                .map(([key, value]) => [key, String(value)]),
            ),
          },
        },
      });
    } catch {
      await this.pause(
        number,
        state,
        `Could not confirm ${kind} dispatch; inspect Actions before resuming`,
      );
    }
    return true;
  }

  async findRun(pending) {
    const runs = await this.api.list(
      `repos/${this.repo}/actions/workflows/${WORKFLOWS[pending.kind]}/runs?event=workflow_dispatch&created=%3E%3D${encodeURIComponent(pending.at)}`,
      "workflow_runs",
    );
    return runs.find(
      (run) =>
        run.display_title === pending.operation &&
        run.head_branch === this.repository.default_branch,
    );
  }

  async completed(number, state) {
    if (!state.pending) return null;
    const pending = state.pending;
    const run = await this.findRun(pending);
    if (!run || run.status !== "completed") {
      if (!run && this.now() - new Date(pending.at) > 20 * 60_000)
        await this.pause(number, state, "Dispatched workflow did not appear within twenty minutes");
      return null;
    }
    if (run.conclusion !== "success") {
      await this.pause(
        number,
        state,
        `${pending.kind} workflow ended with ${run.conclusion}; inspect Actions run ${run.id}`,
      );
      return null;
    }
    return pending;
  }

  async blockers(repo, number) {
    const ref = `${repo}#${number}`;
    if (!this.dependencies.has(ref))
      this.dependencies.set(
        ref,
        await this.projectApi.list(`repos/${repo}/issues/${number}/dependencies/blocked_by`),
      );
    return this.dependencies.get(ref);
  }

  async checkDependencyGraph(root, proposed = []) {
    root = root.toLowerCase();
    proposed = proposed.map((ref) => ref.toLowerCase());
    const graph = new Map();
    const visit = async (ref) => {
      if (graph.has(ref)) return;
      if (graph.size >= 500)
        throw new Error(
          "Dependency graph exceeds the 500-issue safety bound; split or review it manually",
        );
      const [repo, number] = ref.split("#");
      const native = await this.blockers(repo, Number(number));
      const edges = [...new Set([...native.map(issueRef), ...(ref === root ? proposed : [])])];
      graph.set(ref, edges);
      for (const edge of edges) await visit(edge);
    };
    await visit(root);
    assertAcyclic(graph);
    return graph;
  }

  async materializeBlockers(issue, refs) {
    await this.checkDependencyGraph(`${this.repo}#${issue.number}`, refs);
    const existing = await this.blockers(this.repo, issue.number);
    for (const ref of new Set(refs)) {
      if (existing.some((entry) => issueRef(entry).toLowerCase() === ref.toLowerCase())) continue;
      const [repo, number] = ref.split("#");
      const dependency = await this.projectApi.request(`repos/${repo}/issues/${number}`);
      if (dependency.pull_request) throw new Error("Blocking dependencies must be issues");
      await this.api.request(`repos/${this.repo}/issues/${issue.number}/dependencies/blocked_by`, {
        method: "POST",
        body: { issue_id: dependency.id },
      });
    }
    this.dependencies.delete(`${this.repo}#${issue.number}`);
  }

  async canClaim(issue) {
    await this.checkDependencyGraph(`${this.repo}#${issue.number}`);
    const blockers = await this.blockers(this.repo, issue.number);
    return blockers.every(dependencyComplete);
  }

  async claim(item, state, local = false) {
    const current = await this.api.request(`repos/${this.repo}/issues/${item.content.number}`);
    if (!(await admitted(this.api, this.repo, current, this.config, this.writer))) return false;
    if (issueDigest(current) !== state.triagedDigest) return false;
    if (state.paused || state.pending || state.triagedDigest !== issueDigest(item.content))
      return false;
    if (
      item.status !== this.config.statuses.ready ||
      !availableSlots(this.project.items, this.config)
    )
      return false;
    if (!(await this.canClaim(item.content))) return false;
    const reserveSlot = async () => {
      await this.project.move(item, this.config.statuses.inProgress);
      state.phase = local ? "local" : "implementing";
      state.claimedAt = this.now().toISOString();
      state.reason = local
        ? "Local claim granted; implementation may start"
        : "Hosted claim granted";
    };
    if (local) {
      await reserveSlot();
      await this.ledger.save(item.content.number);
      return true;
    }
    return this.dispatch(
      item.content.number,
      state,
      "implement",
      { digest: state.triagedDigest },
      reserveSlot,
    );
  }

  async reconcileIssue(item) {
    const number = item.content.number;
    const issue = await this.api.request(`repos/${this.repo}/issues/${number}`);
    if (
      number === this.budgetIssue ||
      !(await admitted(this.api, this.repo, issue, this.config, this.writer))
    )
      return;
    item.content = { ...item.content, title: issue.title, body: issue.body };
    const { state } = await this.ledger.load(number);
    if (issue.state === "closed") return;
    if (
      issue.labels.some((label) =>
        [this.config.labels.paused, this.config.labels.needsHuman].includes(label.name),
      )
    ) {
      if (!state.paused) await this.pause(number, state, "Automation paused by label");
      return;
    }
    if (state.paused) return;
    if (state.dependencyRefs) {
      const refs = (await this.blockers(this.repo, number)).map(issueRef).sort();
      if (JSON.stringify(refs) !== JSON.stringify(state.dependencyRefs)) {
        if (["ready", "backlog"].includes(state.phase)) state.triagedDigest = null;
        else {
          await this.pause(
            number,
            state,
            "Blocking dependencies changed after implementation started",
          );
          return;
        }
      }
    }
    if (
      state.triagedDigest &&
      state.triagedDigest !== issueDigest(issue) &&
      !["backlog", "ready"].includes(state.phase)
    ) {
      await this.pause(
        number,
        state,
        "Issue scope changed after implementation started; triage and reconcile the existing work",
      );
      return;
    }
    const pending = await this.completed(number, state);
    if (state.paused) return;
    if (!state.pending && state.retry === "implement") {
      const prs = await this.api.list(
        `repos/${this.repo}/pulls?state=open&head=${encodeURIComponent(this.repository.owner.login + ":agent/issue-" + number)}`,
      );
      const existing = prs.find(
        (pr) =>
          sameLogin(pr.user.login, this.writer) &&
          pr.head.ref === `agent/issue-${number}` &&
          pr.head.repo?.full_name === this.repo,
      );
      if (existing) {
        state.retry = null;
        state.pr = existing.number;
        state.phase = existing.draft ? "implementing" : "review";
        if (!existing.draft) await this.project.move(item, this.config.statuses.review);
        await this.ledger.save(number);
      } else {
        if (item.status !== this.config.statuses.inProgress)
          throw new Error("An implementation retry requires its existing In Progress reservation");
        if (await this.dispatch(number, state, "implement", { digest: state.triagedDigest })) {
          state.retry = null;
          await this.ledger.save(number);
        }
      }
      return;
    }
    if (pending?.kind === "triage") {
      const comments = await this.api.list(`repos/${this.repo}/issues/${number}/comments`);
      const comment = comments
        .filter(
          (entry) =>
            sameLogin(entry.user.login, this.writer) &&
            entry.created_at >= pending.at &&
            entry.body.includes("```workflow-triage"),
        )
        .at(-1);
      if (!comment) throw new Error("Completed triage did not publish its attestation");
      const triage = validateTriage(parseBlock(comment.body, "workflow-triage"), issue);
      if (triage.operation !== pending.operation)
        throw new Error("Triage operation does not match the dispatch");
      await this.materializeBlockers(issue, triage.blockers);
      state.pending = null;
      state.triagedDigest = issueDigest(issue);
      state.dependencyRefs = (await this.blockers(this.repo, number)).map(issueRef).sort();
      state.phase = triage.ready ? (state.pr ? "review" : "ready") : "backlog";
      state.reason = triage.ready
        ? "Triage complete; waiting for dependencies and capacity"
        : "Triage found questions; update the issue description to answer them";
      await this.project.move(
        item,
        triage.ready
          ? state.pr
            ? this.config.statuses.review
            : this.config.statuses.ready
          : this.config.statuses.backlog,
      );
      await this.ledger.save(number);
    } else if (pending?.kind === "implement") {
      const prs = await this.api.list(
        `repos/${this.repo}/pulls?state=open&head=${encodeURIComponent(this.repository.owner.login + ":agent/issue-" + number)}`,
      );
      const pr = prs.find(
        (entry) =>
          sameLogin(entry.user.login, this.writer) &&
          entry.head.repo.full_name === this.repo &&
          entry.head.ref === `agent/issue-${number}`,
      );
      if (!pr) throw new Error("Implementation completed without the expected PR");
      state.pending = null;
      state.pr = pr.number;
      state.phase = pr.draft ? "implementing" : "review";
      if (!pr.draft) await this.project.move(item, this.config.statuses.review);
      await this.ledger.save(number);
    }
    if (state.pending) return;
    if (!state.triagedDigest || state.triagedDigest !== issueDigest(issue)) {
      await this.project.move(item, this.config.statuses.backlog);
      state.phase = "backlog";
      await this.dispatch(number, state, "triage", { digest: issueDigest(issue) });
    }
  }

  async linkedItem(pr) {
    const [owner, name] = this.repo.split("/");
    const { repository } = await this.api.graphql(
      `query($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) { pullRequest(number: $number) {
        closingIssuesReferences(first: 100) { totalCount nodes { number repository { nameWithOwner } } }
      } }
    }`,
      { owner, name, number: pr.number },
    );
    const linked = repository.pullRequest.closingIssuesReferences;
    if (linked.totalCount !== 1 || linked.nodes[0]?.repository.nameWithOwner !== this.repo)
      return null;
    return this.project.find(this.repo, linked.nodes[0].number);
  }

  async check(pr, state, conclusion, summary) {
    if (
      state.check?.head === pr.head.sha &&
      state.check.conclusion === conclusion &&
      state.check.summary === summary
    )
      return;
    await this.api.request(`repos/${this.repo}/statuses/${pr.head.sha}`, {
      method: "POST",
      body: {
        context: "Agent review",
        state: conclusion || "pending",
        description: summary.slice(0, 140),
      },
    });
    state.check = { head: pr.head.sha, conclusion, summary };
    await this.ledger.save(pr.number);
  }

  async reconcilePR(pr) {
    if (!(await admitted(this.api, this.repo, pr, this.config, this.writer))) return;
    const { state } = await this.ledger.load(pr.number);
    state.history ||= [];
    let item = await this.linkedItem(pr);
    let issueState = item ? (await this.ledger.load(item.content.number)).state : null;
    if (pr.merged_at) {
      if (item && issueState.pr === pr.number) {
        await this.project.move(item, this.config.statuses.done);
        issueState.phase = "done";
        await this.ledger.save(item.content.number);
      }
      return;
    }
    if (pr.state !== "open") {
      if (item && issueState.pr === pr.number)
        await this.pause(
          item.content.number,
          issueState,
          "PR closed without merge; human triage is required",
        );
      return;
    }
    if (
      item &&
      ((issueState.pr && issueState.pr !== pr.number) ||
        (issueState.pending?.kind === "implement" &&
          !(
            sameLogin(pr.user.login, this.writer) &&
            pr.head.repo?.full_name === this.repo &&
            pr.head.ref === `agent/issue-${item.content.number}`
          )))
    ) {
      state.deliveryReason =
        "The linked story already has another active implementation or PR; an operator must reconcile competing deliveries";
      item = null;
      issueState = null;
    }
    if (
      pr.labels.some((label) =>
        [this.config.labels.paused, this.config.labels.needsHuman].includes(label.name),
      ) ||
      state.paused
    ) {
      if (!state.paused) await this.pause(pr.number, state, "Automation paused by label");
      await this.check(pr, state, "failure", state.reason || "Automation is paused");
      return;
    }
    if (issueState?.paused) {
      await this.pause(pr.number, state, "Linked issue requires human reconciliation");
      await this.check(pr, state, "failure", state.reason);
      return;
    }
    if (pr.draft) return;
    if (item) {
      if (!issueState.triagedDigest || issueState.triagedDigest !== issueDigest(item.content)) {
        await this.check(pr, state, "failure", "Linked issue needs current triage before delivery");
        return;
      }
      if (issueState.pr && issueState.pr !== pr.number)
        throw new Error("Another PR already owns this issue's delivery");
      issueState.pr = pr.number;
      if (issueState.phase !== "rethink") {
        await this.project.move(item, this.config.statuses.review);
        issueState.phase = "review";
      }
      await this.ledger.save(item.content.number);
    }
    const pending = await this.completed(pr.number, state);
    if (state.paused) return;
    if (pending?.kind === "review") {
      const reviews = await this.api.list(`repos/${this.repo}/pulls/${pr.number}/reviews`);
      const review = reviews
        .filter(
          (entry) =>
            sameLogin(entry.user.login, this.reviewer) &&
            entry.submitted_at >= pending.at &&
            entry.commit_id === pending.head &&
            entry.state !== "DISMISSED",
        )
        .at(-1);
      if (!review)
        throw new Error("Completed workflow did not publish a review from the configured reviewer");
      const data = validateReview(parseBlock(review.body, "workflow-review"), review, {
        number: pr.number,
        head: pending.head,
        round: pending.round,
      });
      if (data.operation !== pending.operation)
        throw new Error("Review operation does not match the dispatch");
      state.history.push({
        ...data,
        patch: pending.patch,
        reviewId: review.id,
        fixAttempts: state.fixAttempts || 0,
      });
      state.pending = null;
      await this.ledger.save(pr.number);
      // A review on an old head is retained for audit, but never approves or fixes the new head.
      if (pr.head.sha !== pending.head) return;
    } else if (pending?.kind === "fix") {
      state.pending = null;
      if (pr.head.sha === pending.head)
        throw new Error("Fix workflow completed without changing the PR head");
      state.fixAttempts = (state.fixAttempts || 0) + 1;
      if (item) {
        issueState.phase = "review";
        await this.project.move(item, this.config.statuses.review);
        await this.ledger.save(item.content.number);
      }
      await this.ledger.save(pr.number);
    }
    if (state.pending) return;
    if (state.resumeAwaitHead === pr.head.sha) {
      await this.check(
        pr,
        state,
        "failure",
        "Apply a new revision after resolving the stopped review before requesting another round",
      );
      return;
    }
    delete state.resumeAwaitHead;
    const latest = state.history.at(-1);
    if (!latest || latest.head !== pr.head.sha) {
      if (state.history.length >= this.config.maxReviewRounds) {
        await this.pause(
          pr.number,
          state,
          "Ten review rounds exhausted; human review is required for further revisions",
        );
        await this.check(pr, state, "failure", state.reason);
        return;
      }
      const files = await this.api.list(`repos/${this.repo}/pulls/${pr.number}/files`);
      if (files.length !== pr.changed_files)
        throw new Error("PR diff is incomplete; cannot safely review this revision");
      await this.check(pr, state, null, "Waiting for hosted review of the current head");
      if (item && issueState.phase === "rethink") {
        issueState.phase = "review";
        await this.project.move(item, this.config.statuses.review);
        await this.ledger.save(item.content.number);
      }
      await this.dispatch(pr.number, state, "review", {
        head: pr.head.sha,
        round: state.history.length + 1,
        issue: item?.content.number || 0,
        patch: patchDigest(files),
      });
      return;
    }
    const decision = loopDecision(state.history.slice(state.resumeIndex || 0), this.config);
    if (state.history.length >= this.config.maxReviewRounds && latest.verdict !== "APPROVE") {
      await this.pause(pr.number, state, "Ten review rounds exhausted");
      await this.check(pr, state, "failure", state.reason);
      return;
    }
    if (decision.action === "pause") {
      await this.pause(pr.number, state, decision.reason);
      await this.check(pr, state, "failure", decision.reason);
      return;
    }
    if (decision.action === "human-merge") {
      if (!conventionalTitle(pr.title)) {
        await this.check(
          pr,
          state,
          "failure",
          "Use a Conventional Commit PR title before human merge",
        );
        return;
      }
      if (item && !(await this.canClaim(item.content))) {
        await this.check(
          pr,
          state,
          "failure",
          "Blocking dependencies must complete before delivery",
        );
        return;
      }
      await this.check(
        pr,
        state,
        item ? "success" : "failure",
        item
          ? "Agent approved the current head; human approval and squash merge are required"
          : state.deliveryReason ||
              "Agent review completed, but exactly one project issue must be linked with a closing keyword",
      );
      return;
    }
    await this.check(pr, state, "failure", "Agent requested changes on the current head");
    const managed =
      item &&
      issueState.pr === pr.number &&
      sameLogin(pr.user.login, this.writer) &&
      pr.head.repo?.full_name === this.repo &&
      pr.head.ref === `agent/issue-${item.content.number}` &&
      pr.labels.some((label) => label.name === this.config.labels.automated);
    if (decision.action === "rethink") {
      if (!item) {
        await this.pause(
          pr.number,
          state,
          "An approach change requires a linked project issue and a reserved In Progress slot",
        );
        return;
      }
      if (
        item.status !== this.config.statuses.inProgress &&
        !availableSlots(this.project.items, this.config)
      ) {
        state.reason = "Approach change is waiting for an In Progress slot";
        await this.ledger.save(pr.number);
        return;
      }
      await this.project.move(item, this.config.statuses.inProgress);
      issueState.phase = "rethink";
      await this.ledger.save(item.content.number);
    }
    if (!managed) return; // Fork authors and human authors receive reviews, but their branches are never changed automatically.
    await this.dispatch(pr.number, state, "fix", {
      head: pr.head.sha,
      issue: item.content.number,
      round: state.history.length,
      rethink: decision.action === "rethink",
    });
  }

  async operatorTask(task, number, actor) {
    if (!positiveInteger(number))
      throw new Error("This task requires a positive issue or PR number");
    const user = await this.api.request(`users/${encodeURIComponent(actor)}`);
    const permission = await this.api.request(
      `repos/${this.repo}/collaborators/${encodeURIComponent(actor)}/permission`,
    );
    if (
      user.type !== "User" ||
      !this.config.humanOperators.some((login) => sameLogin(login, actor)) ||
      !["admin", "maintain", "write"].includes(permission.permission)
    )
      throw new Error(
        "Operator tasks require a configured human operator with repository write access",
      );
    const { state } = await this.ledger.load(number);
    if (task === "resume") {
      if (!state.paused) throw new Error("Only paused work may be resumed");
      if (state.history?.length >= this.config.maxReviewRounds)
        throw new Error("The ten-round lifetime limit cannot be reset");
      const stopped = state.lastStoppedOperation;
      if (stopped) {
        const run = await this.findRun(stopped);
        if (run && run.status !== "completed")
          throw new Error("Wait for the previous workflow to finish or cancel before resuming");
      }
      state.paused = false;
      state.pending = null;
      state.resumeIndex = Math.max(0, (state.history?.length || 0) - 1);
      state.resumedOperation = stopped;
      state.lastStoppedOperation = null;
      delete state.resumeAwaitHead;
      if (stopped?.kind === "implement") state.retry = "implement";
      if (stopped?.kind === "triage") {
        state.triagedDigest = null;
        state.phase = "backlog";
      }
      if (state.history?.length && !stopped) state.resumeAwaitHead = state.history.at(-1).head;
      state.reason = `Resumed by ${actor}; previous rounds remain counted`;
      for (const label of [this.config.labels.needsHuman, this.config.labels.paused]) {
        try {
          await this.api.request(
            `repos/${this.repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
            { method: "DELETE" },
          );
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
      await this.ledger.save(number);
    } else if (task === "claim-local") {
      const item = this.project.find(this.repo, number);
      if (!item || !(await this.claim(item, state, true)))
        throw new Error(
          "Issue cannot be claimed: check readiness, dependencies, pause state, and capacity",
        );
    } else if (task === "triage") {
      if (state.pending)
        throw new Error("Pause and finish the active workflow before requesting new triage");
      if (state.lastStoppedOperation) {
        const run = await this.findRun(state.lastStoppedOperation);
        if (run && run.status !== "completed")
          throw new Error("Wait for cancellation before requesting new triage");
      }
      const issue = await this.api.request(`repos/${this.repo}/issues/${number}`);
      if (issue.pull_request || issue.state !== "open")
        throw new Error("Triage requires an open issue");
      state.paused = false;
      state.retry = null;
      state.triagedDigest = null;
      state.phase = "backlog";
      for (const label of [this.config.labels.needsHuman, this.config.labels.paused]) {
        try {
          await this.api.request(
            `repos/${this.repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
            { method: "DELETE" },
          );
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
      await this.ledger.save(number);
    } else throw new Error("Unknown operator task");
  }

  async run({ task = "reconcile", number, actor, event = {} } = {}) {
    if (task !== "reconcile") await this.operatorTask(task, Number(number), actor);
    if (
      event.issue &&
      !event.issue.pull_request &&
      event.issue.number !== this.budgetIssue &&
      (await admitted(this.api, this.repo, event.issue, this.config, this.writer))
    )
      await this.project.add(event.issue, this.repo);
    if (event.pull_request?.number) {
      const pr = await this.api.request(`repos/${this.repo}/pulls/${event.pull_request.number}`);
      await this.reconcilePR(pr);
    }
    const issues = await this.api.list(`repos/${this.repo}/issues?state=open`);
    for (const issue of issues.filter((entry) => !entry.pull_request))
      if (
        issue.number !== this.budgetIssue &&
        (await admitted(this.api, this.repo, issue, this.config, this.writer))
      )
        await this.project.add(issue, this.repo);
    const all = this.project.items.filter(
      (item) =>
        !item.isArchived &&
        item.content?.number !== this.budgetIssue &&
        item.content?.__typename === "Issue" &&
        item.content.repository.nameWithOwner === this.repo,
    );
    const work = all.filter((item) => item.content.state?.toLowerCase() !== "closed");
    for (const item of work) {
      try {
        await this.reconcileIssue(item);
      } catch (error) {
        await this.pause(
          item.content.number,
          (await this.ledger.load(item.content.number)).state,
          error.message,
        );
      }
    }
    const prs = await this.api.list(`repos/${this.repo}/pulls?state=open`);
    for (const item of all) {
      const { state } = await this.ledger.load(item.content.number);
      if (state.pr && state.phase !== "done" && !prs.some((pr) => pr.number === state.pr))
        prs.push({ number: state.pr });
    }
    for (const summary of prs) {
      const pr = await this.api.request(`repos/${this.repo}/pulls/${summary.number}`);
      try {
        await this.reconcilePR(pr);
      } catch (error) {
        const { state } = await this.ledger.load(pr.number);
        await this.pause(pr.number, state, error.message);
        await this.check(pr, state, "failure", error.message);
      }
    }
    for (const item of work) {
      const { state } = await this.ledger.load(item.content.number);
      if (task === "claim-local" && item.content.number === Number(number)) continue;
      await this.claim(item, state);
    }
  }
}

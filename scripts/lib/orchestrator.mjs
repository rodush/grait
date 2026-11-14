import { randomUUID } from "node:crypto";
import { Ledger } from "./ledger.mjs";
import {
  availableSlots,
  assertAcyclic,
  dependencyComplete,
  issueDigest,
  loopDecision,
  patchDigest,
  sameLogin,
  validateReview,
  validateTriage,
} from "./policy.mjs";

const labels = (item) =>
  (item.labels || []).map((label) => (typeof label === "string" ? label : label.name));

// The CLI serializes mutations on the designated host. This class never invokes a model
// or dispatches Actions; the signed-in native harness owns agent execution.
export class LocalOrchestrator {
  constructor({ api, reviewerApi, project, repo, writer, reviewer, config }) {
    if (!sameLogin(config.controllerRepository, repo) || !sameLogin(project.controller, repo))
      throw new Error("Repository and Project must be bound to this orchestrator");
    if (
      !writer ||
      !reviewer ||
      sameLogin(writer, reviewer) ||
      config.humanOperators.some((login) => sameLogin(login, writer) || sameLogin(login, reviewer))
    )
      throw new Error("Human, writer, and reviewer identities must be separate");
    Object.assign(this, { api, reviewerApi, project, repo, writer, reviewer, config });
    this.ledger = new Ledger(api, repo, writer);
  }

  async issue(number) {
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("A positive issue number is required");
    const issue = await this.api.request(`repos/${this.repo}/issues/${number}`);
    if (issue.pull_request || issue.state?.toLowerCase() !== "open")
      throw new Error("An open issue is required");
    await this.admit(issue);
    return issue;
  }

  async admit(item) {
    const names = labels(item);
    if (names.includes(this.config.labels.paused) || names.includes(this.config.labels.needsHuman))
      throw new Error("Work is paused or needs human resolution");
    if (
      this.config.humanOperators.some((login) => sameLogin(login, item.user?.login)) ||
      sameLogin(item.user?.login, this.writer) ||
      names.includes(this.config.labels.admitted)
    )
      return;
    if (item.user?.login && ["OWNER", "MEMBER", "COLLABORATOR"].includes(item.author_association)) {
      const permission = await this.api.request(
        `repos/${this.repo}/collaborators/${encodeURIComponent(item.user.login)}/permission`,
      );
      if (["admin", "maintain", "write"].includes(permission.permission)) return;
    }
    throw new Error("An outside submission requires maintainer admission");
  }

  async blockers(repo, number) {
    return this.api.list(`repos/${repo}/issues/${number}/dependencies/blocked_by`);
  }

  checkState(state) {
    if (state.pending)
      throw new Error(
        "A legacy hosted operation is still pending; stop its run and reconcile its evidence before local work",
      );
    if (state.paused) throw new Error("Work is paused; reconcile its recorded reason first");
  }

  reference(issue) {
    const repo =
      issue.repository?.full_name ||
      issue.repository?.nameWithOwner ||
      issue.repository_url?.split("/repos/")[1];
    if (!repo || !Number.isSafeInteger(issue.number))
      throw new Error("Dependency identity is inaccessible");
    return `${repo}#${issue.number}`;
  }

  async ready(number, assessment) {
    const issue = await this.issue(number);
    validateTriage(assessment, issue);
    const actual = await this.blockers(this.repo, number);
    const refs = actual.map((item) => this.reference(item)).sort();
    if (
      JSON.stringify(refs.map((ref) => ref.toLowerCase())) !==
      JSON.stringify([...new Set(assessment.blockers)].sort().map((ref) => ref.toLowerCase()))
    )
      throw new Error("Triage blockers must match the native GitHub blocking dependencies");
    const graph = new Map();
    const visit = async (repo, id) => {
      const key = `${repo.toLowerCase()}#${id}`;
      if (graph.has(key)) return;
      const dependencies = await this.blockers(repo, id);
      const next = dependencies.map((item) => this.reference(item).toLowerCase());
      graph.set(key, next);
      for (const ref of next) {
        const [owner, child] = ref.split("#");
        await visit(owner, Number(child));
      }
    };
    await visit(this.repo, number);
    assertAcyclic(graph);
    const { state } = await this.ledger.load(number);
    this.checkState(state);
    if (state.claim) throw new Error("An active claim must be reconciled before re-triage");
    const existing = this.project.find(this.repo, number);
    if (
      existing &&
      ![this.config.statuses.backlog, this.config.statuses.ready].includes(existing.status)
    )
      throw new Error("Active work must be reconciled before re-triage");
    state.triagedDigest = issueDigest(issue);
    state.triage = assessment;
    await this.ledger.save(number);
    const item = await this.project.add(issue, this.repo);
    await this.project.move(
      item,
      assessment.ready ? this.config.statuses.ready : this.config.statuses.backlog,
    );
    return { ready: assessment.ready, digest: state.triagedDigest };
  }

  async claim(number) {
    const issue = await this.issue(number);
    const { state } = await this.ledger.load(number);
    this.checkState(state);
    if (state.triagedDigest !== issueDigest(issue) || state.triage?.ready !== true)
      throw new Error("Fresh accepted triage is required before claiming");
    const item = this.project.find(this.repo, number);
    if (!item) throw new Error("Issue must be in the configured Project");
    const blockers = await this.blockers(this.repo, number);
    if (!blockers.every(dependencyComplete))
      throw new Error("Blocking dependencies must be completed successfully");
    const refs = blockers.map((item) => this.reference(item).toLowerCase()).sort();
    if (
      JSON.stringify(refs) !==
      JSON.stringify(state.triage.blockers.map((ref) => ref.toLowerCase()).sort())
    )
      throw new Error("Blocking dependencies changed; triage again");
    if (state.claim) {
      if (![this.config.statuses.inProgress, this.config.statuses.review].includes(item.status))
        throw new Error("Recorded claim and Project status disagree; reconcile before retrying");
      return state.claim;
    }
    if (item.status !== this.config.statuses.ready)
      throw new Error("Only Ready issues can be claimed");
    if (
      this.project.items.some(
        (entry) =>
          !entry.isArchived &&
          entry.content?.__typename !== "PullRequest" &&
          entry.status === this.config.statuses.review,
      )
    )
      throw new Error(
        "Finish existing Review stories before claiming new work; resolve pending reviews, fixes, or human/external waits first",
      );
    if (!availableSlots(this.project.items, this.config))
      throw new Error("The five-story In Progress capacity is exhausted");
    if (state.pendingClaim)
      throw new Error(
        "An earlier claim has an uncertain result; reconcile its Project status before retrying",
      );
    state.pendingClaim = { id: randomUUID(), digest: state.triagedDigest };
    await this.ledger.save(number);
    await this.project.move(item, this.config.statuses.inProgress);
    state.claim = {
      issue: number,
      branch: `agent/issue-${number}`,
      digest: state.triagedDigest,
      at: new Date().toISOString(),
    };
    delete state.pendingClaim;
    await this.ledger.save(number);
    return state.claim;
  }

  async review(number, data) {
    if (!Number.isSafeInteger(number) || number < 1 || !/^[a-f0-9]{40}$/.test(data.head))
      throw new Error("Review requires a positive PR number and exact head SHA");
    const pr = await this.api.request(`repos/${this.repo}/pulls/${number}`);
    await this.admit(pr);
    if (
      pr.state !== "open" ||
      pr.draft ||
      pr.head?.sha !== data.head ||
      data.pr !== number ||
      sameLogin(pr.user?.login, this.reviewer)
    )
      throw new Error(
        "Review requires an open ready PR at the exact requested head and an independent reviewer",
      );
    const { state } = await this.ledger.load(number);
    this.checkState(state);
    if (
      state.reviews &&
      state.history &&
      JSON.stringify(state.reviews) !== JSON.stringify(state.history)
    )
      throw new Error("Conflicting local and legacy review histories require human reconciliation");
    const history = state.reviews || state.history || [];
    if (history.length >= this.config.maxReviewRounds)
      throw new Error("Ten review rounds exhausted");
    if (history.some((entry) => entry.head === data.head))
      throw new Error("This PR head was already reviewed");
    if (data.round !== history.length + 1)
      throw new Error("Review round does not match the recorded history");
    validateReview(
      data,
      {
        commit_id: data.head,
        state: { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" }[
          data.verdict
        ],
      },
      { number, head: data.head, round: data.round },
    );
    if (state.pendingReview)
      throw new Error("An earlier review has an uncertain result; inspect GitHub before resuming");
    if (!this.reviewerApi) throw new Error("Reviewer publishing identity is required");
    const comments = data.comments || [];
    if (
      !Array.isArray(comments) ||
      comments.length > 100 ||
      comments.some(
        (comment) =>
          !comment.path ||
          !Number.isInteger(comment.line) ||
          comment.line < 1 ||
          !["LEFT", "RIGHT"].includes(comment.side) ||
          typeof comment.body !== "string",
      )
    )
      throw new Error("Inline findings require a path, diff line, side, and body");
    const files = await this.api.list(`repos/${this.repo}/pulls/${number}/files`);
    if (Number.isInteger(pr.changed_files) && files.length !== pr.changed_files)
      throw new Error("PR diff is incomplete; cannot safely review this revision");
    const linked = (pr.body || "").match(
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9]\d*)\b/i,
    );
    if (linked) {
      const { state: issueState } = await this.ledger.load(Number(linked[1]));
      this.checkState(issueState);
      if (
        issueState.tdd &&
        (issueState.tdd.phase !== "review" || issueState.tdd.head !== pr.head.sha)
      )
        throw new Error("Current-head Green evidence is required before review");
    }
    if (comments.some((comment) => !files.some((file) => file.filename === comment.path)))
      throw new Error("Inline finding is outside the PR diff");
    const metadata = { ...data };
    delete metadata.comments;
    delete metadata.body;
    const body = `${data.body || "Agent review"}\n\n\`\`\`workflow-review\n${JSON.stringify(metadata)}\n\`\`\``;
    if (Buffer.byteLength(body) > 50000) throw new Error("Review report is too large");
    state.pendingReview = { head: data.head, round: data.round };
    await this.ledger.save(number);
    const published = await this.reviewerApi.request(`repos/${this.repo}/pulls/${number}/reviews`, {
      method: "POST",
      body: { commit_id: data.head, event: data.verdict, body, comments },
    });
    if (!sameLogin(published.user?.login, this.reviewer))
      throw new Error("Review was not published by the configured reviewer");
    validateReview(data, published, { number, head: data.head, round: data.round });
    history.push({
      ...metadata,
      patch: patchDigest(files),
      fixAttempts: state.fixAttempts || history.at(-1)?.fixAttempts || 0,
    });
    state.reviews = history;
    if (state.history) state.history = history;
    delete state.pendingReview;
    const decision = loopDecision(history, this.config);
    if (decision.action === "pause") {
      state.paused = true;
      state.reason = decision.reason;
    }
    await this.ledger.save(number);
    await this.api.request(`repos/${this.repo}/statuses/${data.head}`, {
      method: "POST",
      body: {
        context: "Agent review",
        state:
          decision.action === "human-merge"
            ? "success"
            : decision.action === "pause"
              ? "error"
              : "failure",
        description:
          decision.action === "human-merge"
            ? "Current revision approved; human merge required"
            : (decision.reason || "Review findings require corrections").slice(0, 140),
      },
    });
    return decision;
  }

  async sync(number) {
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("A positive PR number is required");
    const pr = await this.api.request(`repos/${this.repo}/pulls/${number}`);
    const matches = [
      ...(pr.body || "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9]\d*)\b/gi),
    ];
    const issues = [...new Set(matches.map((match) => Number(match[1])))];
    if (issues.length !== 1)
      throw new Error("PR must close exactly one issue in this repository, using Closes #N");
    const issueNumber = issues[0];
    const { state } = await this.ledger.load(issueNumber);
    if (!state.claim) throw new Error("Linked issue has no accepted claim");
    const item = this.project.find(this.repo, issueNumber);
    if (!item) throw new Error("Claimed issue is missing from the Project");
    if (pr.merged === true) {
      await this.project.move(item, this.config.statuses.done);
      state.completedPR = number;
      await this.ledger.save(issueNumber);
    } else if (pr.state === "closed") {
      return { action: "needs-triage", issue: issueNumber };
    } else {
      await this.admit(pr);
      await this.issue(issueNumber);
      this.checkState(state);
      if (
        !pr.draft &&
        state.tdd &&
        (state.tdd.phase !== "review" || state.tdd.head !== pr.head.sha)
      )
        throw new Error("Current-head Green evidence is required before Review");
      if (
        pr.draft &&
        item.status !== this.config.statuses.inProgress &&
        !availableSlots(this.project.items, this.config)
      )
        throw new Error("Draft work is waiting for In Progress capacity");
      await this.project.move(
        item,
        pr.draft ? this.config.statuses.inProgress : this.config.statuses.review,
      );
    }
    return { issue: issueNumber, status: item.status };
  }
}

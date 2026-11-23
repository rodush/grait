import { randomUUID } from "node:crypto";
import { lstat, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Ledger } from "./ledger.mjs";
import { command, withoutCredentials } from "./setup-process.mjs";
import {
  availableSlots,
  assertAcyclic,
  defaultMaxReady,
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

const closingIssues = (pr) => [
  ...new Set(
    [
      ...(pr.body || "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#([1-9]\d*)\b/gi),
    ].map((match) => Number(match[1])),
  ),
];

const exactHead = (head) => typeof head === "string" && /^[a-f0-9]{40}$/.test(head);
const issueBranch = (issue) => `agent/issue-${issue}`;

function within(path, directory) {
  const fromDirectory = relative(directory, path);
  return (
    !isAbsolute(fromDirectory) && fromDirectory !== ".." && !fromDirectory.startsWith(`..${sep}`)
  );
}

// An absent leaf is safe only if its existing ancestors have their expected identity.
async function directoryExists(path) {
  const stat = await lstat(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (!stat) {
    await directoryExists(dirname(path));
    return false;
  }
  if (!stat.isDirectory() || (await realpath(path)) !== path)
    throw new Error(`Expected a real directory without symlinked parents at ${path}`);
  return true;
}

function parseWorktrees(output) {
  return output
    .split("\0\0")
    .filter(Boolean)
    .map((record) =>
      Object.fromEntries(
        record
          .split("\0")
          .map((line) => line.match(/^(\S+)(?: ([\s\S]*))?$/))
          .filter(Boolean)
          .map(([, key, value = ""]) => [key, value]),
      ),
    );
}

// The caller must establish that the claim completed at this merged head and
// that workers have relinquished ownership before invoking local cleanup.
export async function cleanupTaskArtifacts({ issue, branch, head, cwd = process.cwd(), repo }) {
  const result = { removed: [], failures: [] };
  try {
    if (
      !Number.isSafeInteger(issue) ||
      issue < 1 ||
      branch !== issueBranch(issue) ||
      !exactHead(head) ||
      typeof repo !== "string" ||
      !/^[\w.-]+\/[\w.-]+$/.test(repo) ||
      [".", ".."].includes(repo.split("/")[1])
    )
      throw new Error("Task cleanup requires a repository, canonical issue branch, and exact head");

    const env = withoutCredentials();
    const localVars = await command("git", ["rev-parse", "--local-env-vars"], { cwd, env });
    for (const name of localVars.stdout.trim().split("\n")) delete env[name];
    const git = async (args, directory = cwd) => {
      const { stdout, stderr, code } = await command("git", args, {
        cwd: directory,
        env,
        allowFailure: true,
      });
      if (code !== 0 || stderr.trim())
        throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || `exit ${code}`}`);
      return stdout;
    };
    const common = resolve(
      cwd,
      (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"])).trimEnd(),
    );
    if (!(await directoryExists(common)))
      throw new Error(`Git common directory is missing at ${common}`);
    // Match the placement used by the orchestrator's worktree and worker commands.
    const target = join(dirname(common), "..", `${repo.split("/")[1]}-worktrees`, `issue-${issue}`);
    const scratch = join(common, "grait-setup", "issue-scratch", `issue-${issue}`);
    const ref = `refs/heads/${branch}`;
    const listWorktrees = async () =>
      parseWorktrees(await git(["worktree", "list", "--porcelain", "-z"]));
    const worktrees = await listWorktrees();
    const [primary] = worktrees;
    if (!primary?.worktree) throw new Error("Cannot identify the primary worktree");
    const currentDirectories = await Promise.all([realpath(cwd), realpath(process.cwd())]);
    const registered = worktrees.filter(
      (entry) => entry.worktree === target || entry.branch === ref,
    );
    const refOutput = await git([
      "for-each-ref",
      "--format=%(refname) %(objectname) %(symref)",
      ref,
    ]);
    const branchRef = refOutput.split("\n").find((line) => line.startsWith(`${ref} `));
    if (branchRef && branchRef !== `${ref} ${head} `)
      throw new Error(`Local branch ${branch} has diverged or is symbolic; expected ${head}`);
    const targetExists = await directoryExists(target);

    if (registered.length || targetExists) {
      const [entry] = registered;
      if (
        registered.length !== 1 ||
        entry.worktree !== target ||
        entry.branch !== ref ||
        !branchRef ||
        entry.HEAD !== head ||
        !targetExists
      )
        throw new Error(
          `Worktree at ${entry?.worktree || target} does not match the canonical task worktree and accepted head (${target})`,
        );
      if (
        entry === primary ||
        currentDirectories.some((directory) => within(directory, target)) ||
        "locked" in entry ||
        "prunable" in entry
      )
        throw new Error(`Worktree at ${target} is current, primary, locked, or prunable`);
      const identity = await git(
        ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "HEAD"],
        target,
      );
      if (
        !(await lstat(join(target, ".git"))).isFile() ||
        identity !== `${target}\n${common}\n${head}\n` ||
        (await git(["symbolic-ref", "HEAD"], target)).trimEnd() !== ref
      )
        throw new Error(`Worktree at ${target} has foreign or inconsistent Git metadata`);
      const status = await git(
        [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--ignored=matching",
          "--ignore-submodules=none",
        ],
        target,
      );
      const tracked = await git(["ls-files", "-v", "-z"], target);
      if (status || tracked.split("\0").some((entry) => /^[Sa-z] /.test(entry)))
        throw new Error(
          `Worktree at ${target} is dirty, contains ignored files, or has hidden index entries`,
        );
      await git(["worktree", "remove", "--", target]);
      result.removed.push(target);
    }

    if (branchRef) {
      if ((await listWorktrees()).some((entry) => entry.branch === ref))
        throw new Error(`Local branch ${branch} is still checked out in a worktree`);
      await git(["update-ref", "--no-deref", "-d", ref, head]);
      result.removed.push(branch);
    }

    if (await directoryExists(scratch)) {
      if (
        currentDirectories.some((directory) => within(directory, scratch)) ||
        worktrees.some((entry) => within(entry.worktree, scratch))
      )
        throw new Error(`Task scratch directory ${scratch} contains a working checkout`);
      await rm(scratch, { recursive: true });
      result.removed.push(scratch);
    }
  } catch (error) {
    result.failures.push(error.message);
  }
  return result;
}

// The CLI serializes mutations on the designated host. This class never invokes a model
// or dispatches Actions; the signed-in native harness owns agent execution.
export class LocalOrchestrator {
  constructor({
    api,
    reviewerApi,
    project,
    repo,
    writerId,
    reviewerId,
    config,
    cwd = process.cwd(),
  }) {
    if (!sameLogin(config.controllerRepository, repo) || !sameLogin(project.controller, repo))
      throw new Error("Repository and Project must be bound to this orchestrator");
    if (
      !Number.isSafeInteger(writerId) ||
      writerId < 1 ||
      !Number.isSafeInteger(reviewerId) ||
      reviewerId < 1 ||
      writerId === reviewerId
    )
      throw new Error("Writer and reviewer must have distinct verified bot user IDs");
    Object.assign(this, {
      api,
      reviewerApi,
      project,
      repo,
      writerId,
      reviewerId,
      config,
      cwd,
    });
    this.ledger = new Ledger(api, repo, writerId);
  }

  async issue(number, options) {
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("A positive issue number is required");
    const issue = await this.api.request(`repos/${this.repo}/issues/${number}`);
    if (issue.pull_request || issue.state?.toLowerCase() !== "open")
      throw new Error("An open issue is required");
    await this.admit(issue, options);
    return issue;
  }

  checkControlLabels(item, { reportingHumanAttention = false } = {}) {
    const names = labels(item);
    if (
      names.includes(this.config.labels.paused) ||
      (!reportingHumanAttention && names.includes(this.config.labels.needsHuman))
    )
      throw new Error("Work is paused or needs human resolution");
  }

  async admit(item, options) {
    this.checkControlLabels(item, options);
    const names = labels(item);
    if (
      (item.user?.type !== "Bot" &&
        this.config.humanOperators.some((login) => sameLogin(login, item.user?.login))) ||
      item.user?.id === this.writerId ||
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

  async publishHumanAttention(issue, attention) {
    const label = this.config.labels.needsHuman;
    if (!labels(issue).includes(label))
      await this.api.request(`repos/${this.repo}/issues/${issue.number}/labels`, {
        method: "POST",
        body: { labels: [label] },
      });
    const { state } = await this.ledger.load(issue.number);
    state.humanAttention = attention;
    await this.ledger.save(issue.number);
  }

  async ready(number, assessment) {
    const issue = await this.issue(number, { reportingHumanAttention: true });
    const { humanAttention, ...triage } = validateTriage(assessment, issue);
    this.checkControlLabels(issue, { reportingHumanAttention: Boolean(humanAttention) });
    const actual = await this.blockers(this.repo, number);
    const refs = actual.map((item) => this.reference(item)).sort();
    if (
      JSON.stringify(refs.map((ref) => ref.toLowerCase())) !==
      JSON.stringify([...new Set(assessment.blockers)].sort().map((ref) => ref.toLowerCase()))
    )
      throw new Error("Triage blockers must match the native GitHub blocking dependencies");
    if (assessment.ready) {
      const incomplete = actual.filter((item) => !dependencyComplete(item));
      if (incomplete.length)
        throw new Error(
          `Ready requires completed blocking dependencies: ${incomplete.map((item) => this.reference(item)).join(", ")}`,
        );
    }
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
    const existing = this.project.find(this.repo, number);
    if (humanAttention && state.pendingClaim)
      throw new Error(
        "An earlier claim has an uncertain result; reconcile its Project status before retrying",
      );
    if (state.claim) {
      if (!humanAttention) throw new Error("An active claim must be reconciled before re-triage");
      if (
        !existing ||
        ![this.config.statuses.inProgress, this.config.statuses.review].includes(existing.status)
      )
        throw new Error("Recorded claim and Project status disagree; reconcile before retrying");
      await this.publishHumanAttention(issue, humanAttention);
      return { ready: false, digest: triage.digest };
    }
    if (
      existing &&
      ![this.config.statuses.backlog, this.config.statuses.ready].includes(existing.status)
    )
      throw new Error("Active work must be reconciled before re-triage");
    if (assessment.ready && existing?.status !== this.config.statuses.ready) {
      const readyCount = this.project.items.filter(
        (item) =>
          !item.isArchived &&
          item.content?.__typename !== "PullRequest" &&
          item.status === this.config.statuses.ready,
      ).length;
      const maxReady = this.config.maxReady ?? defaultMaxReady;
      if (readyCount >= maxReady)
        throw new Error(`The Ready capacity is exhausted at ${maxReady} stories (maxReady)`);
    }
    state.triagedDigest = issueDigest(issue);
    state.triage = triage;
    if (humanAttention) {
      await this.publishHumanAttention(issue, humanAttention);
    } else {
      delete state.humanAttention;
      await this.ledger.save(number);
    }
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
      branch: issueBranch(number),
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
      pr.user?.id === this.reviewerId
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
    const issues = closingIssues(pr);
    const [issueNumber] = issues;
    let linkedIssue;
    if (issueNumber) {
      linkedIssue = await this.api.request(`repos/${this.repo}/issues/${issueNumber}`);
      this.checkControlLabels(linkedIssue);
      const { state: issueState } = await this.ledger.load(issueNumber);
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
    if (published.user?.id !== this.reviewerId)
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
    if (
      data.conflicts &&
      issues.length === 1 &&
      linkedIssue &&
      !linkedIssue.pull_request &&
      linkedIssue.state !== "closed"
    ) {
      await this.publishHumanAttention(linkedIssue, {
        blocker: decision.reason,
        action: `Reconcile the conflicting reviewer instructions on PR #${number} and verify the review ledger before resuming.`,
      });
    }
    return decision;
  }

  async sync(number) {
    if (!Number.isSafeInteger(number) || number < 1)
      throw new Error("A positive PR number is required");
    const pr = await this.api.request(`repos/${this.repo}/pulls/${number}`);
    const issues = closingIssues(pr);
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
      const cleanup = await this.cleanupCompletedIssue(issueNumber, number, item, pr, state);
      return { issue: issueNumber, status: item.status, cleanup };
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

  async cleanupCompletedIssue(issue, number, item, pr, state) {
    const { claim, tdd } = state;
    const head = pr.head?.sha;
    const blocked = (reason) => ({ removed: [], failures: [reason] });
    if (item.status !== this.config.statuses.done)
      return blocked(`Project issue #${issue} must be Done before task cleanup`);
    if (tdd?.owner || state.pending || state.pendingClaim || state.pendingReview || state.fixPR)
      return blocked(`Issue #${issue} has an active role owner or unfinished operation`);
    if (
      claim.issue !== issue ||
      claim.branch !== issueBranch(issue) ||
      (pr.number !== undefined && pr.number !== number) ||
      pr.head?.ref !== claim.branch ||
      !sameLogin(pr.head?.repo?.full_name, this.repo) ||
      (pr.base?.repo?.full_name && !sameLogin(pr.base.repo.full_name, this.repo)) ||
      !exactHead(head)
    )
      return blocked(
        `Merged PR #${number} does not match the repository and claim for issue #${issue}`,
      );
    if (
      tdd &&
      (tdd.issue !== issue ||
        tdd.branch !== claim.branch ||
        !claim.digest ||
        tdd.acceptanceDigest !== claim.digest ||
        tdd.phase !== "review" ||
        tdd.head !== head)
    )
      return blocked(`Merged PR #${number} does not match the accepted head for issue #${issue}`);
    return cleanupTaskArtifacts({
      issue,
      branch: claim.branch,
      head,
      cwd: this.cwd,
      repo: this.repo,
    });
  }
}

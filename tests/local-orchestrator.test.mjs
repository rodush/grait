import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { issueDigest } from "../scripts/lib/policy.mjs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoot =
  process.env.GRAIT_TEST_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url));
const { LocalOrchestrator } = await import(
  pathToFileURL(resolve(sourceRoot, "scripts/lib/orchestrator.mjs"))
);
const baseConfig = JSON.parse(await readFile(resolve(sourceRoot, "workflow.config.json"), "utf8"));
const repo = "acme/service";
const head = "a".repeat(40);

function fixture() {
  const config = {
    ...baseConfig,
    controllerRepository: repo,
    humanOperators: ["operator"],
    labels: { ...baseConfig.labels },
  };
  const issue = {
    number: 1,
    node_id: "issue-node",
    title: "Ship the accepted outcome",
    body: "Acceptance criteria",
    state: "open",
    user: { login: "operator" },
    labels: [],
  };
  const pull = {
    number: 7,
    title: "feat: deliver outcome",
    body: "Closes #1",
    user: { login: "writer[bot]", id: 10101, type: "Bot" },
    head: { sha: head, repo: { full_name: repo } },
    base: { repo: { full_name: repo } },
    state: "open",
    merged: false,
    draft: false,
  };
  const issues = new Map([[1, issue]]);
  const comments = new Map();
  const blockers = new Map([[1, []]]);
  const requests = [];
  const publishedReviews = [];
  const moves = [];
  let commentId = 100;
  const item = {
    id: "item-1",
    status: config.statuses.backlog,
    content: { __typename: "Issue", number: 1, repository: { nameWithOwner: repo } },
  };
  const project = {
    controller: repo,
    items: [item],
    find(repository, number) {
      return this.items.find(
        (entry) =>
          entry.content?.repository?.nameWithOwner === repository &&
          entry.content.number === number,
      );
    },
    async add(value, repository) {
      const found = this.find(repository, value.number);
      if (found) return found;
      const added = {
        id: `item-${value.number}`,
        status: config.statuses.backlog,
        content: { ...value, __typename: "Issue", repository: { nameWithOwner: repository } },
      };
      this.items.push(added);
      return added;
    },
    async move(entry, status) {
      moves.push({ number: entry.content?.number, status });
      entry.status = status;
    },
  };
  const api = {
    async request(path, options = {}) {
      requests.push({ path, ...options });
      const method = options.method || "GET";
      const issueMatch = path.match(/^repos\/acme\/service\/issues\/(\d+)$/);
      if (method === "GET" && issueMatch) return issues.get(Number(issueMatch[1]));
      if (method === "GET" && path === `repos/${repo}/pulls/7`) return pull;
      if (path.endsWith("/permission"))
        return { permission: path.includes("outsider") ? "read" : "write" };
      if (method === "POST" && /\/issues\/\d+\/comments$/.test(path)) {
        const number = Number(path.match(/\/issues\/(\d+)\/comments$/)[1]);
        const comment = {
          id: commentId++,
          user: { login: "writer[bot]", id: 10101, type: "Bot" },
          body: options.body.body,
        };
        comments.set(number, [...(comments.get(number) || []), comment]);
        return comment;
      }
      if (method === "PATCH" && /\/issues\/comments\/\d+$/.test(path)) {
        const id = Number(path.split("/").at(-1));
        for (const values of comments.values()) {
          const comment = values.find((value) => value.id === id);
          if (comment) {
            comment.body = options.body.body;
            return comment;
          }
        }
      }
      if (method === "POST" && /\/statuses\//.test(path)) return { state: options.body.state };
      const labelsMatch = path.match(/\/issues\/(\d+)\/labels$/);
      if (method === "POST" && labelsMatch) {
        const labeledIssue = issues.get(Number(labelsMatch[1]));
        for (const name of options.body.labels) {
          if (!labeledIssue.labels.some((label) => label.name === name))
            labeledIssue.labels.push({ name });
        }
        return labeledIssue.labels;
      }
      throw new Error(`Unsupported local API operation: ${method} ${path}`);
    },
    async list(path) {
      const match = path.match(/\/issues\/(\d+)\/comments$/);
      if (match) return comments.get(Number(match[1])) || [];
      const dependencyMatch = path.match(/\/issues\/(\d+)\/dependencies\/blocked_by$/);
      if (dependencyMatch) return blockers.get(Number(dependencyMatch[1])) || [];
      if (path.endsWith("/pulls/7/files"))
        return [
          {
            filename: "src/outcome.mjs",
            status: "modified",
            patch: `+${pull.head.sha}`,
            sha: pull.head.sha,
          },
        ];
      if (path.endsWith("/pulls/7/reviews")) return publishedReviews;
      throw new Error(`Unsupported local API listing: ${path}`);
    },
  };
  const reviewerApi = {
    async request(path, options = {}) {
      requests.push({ identity: "reviewer", path, ...options });
      assert.equal(path, `repos/${repo}/pulls/7/reviews`);
      assert.equal(options.method, "POST");
      const response = {
        id: publishedReviews.length + 1,
        user: { login: "reviewer[bot]", id: 10102, type: "Bot" },
        commit_id: options.body.commit_id,
        state: { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" }[
          options.body.event
        ],
      };
      publishedReviews.push(response);
      return response;
    },
  };
  const newOrchestrator = () =>
    new LocalOrchestrator({
      api,
      reviewerApi,
      project,
      repo,
      writer: "writer[bot]",
      reviewer: "reviewer[bot]",
      writerId: 10101,
      reviewerId: 10102,
      config,
    });
  const assessment = (overrides = {}) => ({
    version: 1,
    issue: 1,
    digest: issueDigest(issue),
    ready: true,
    blockers: [],
    questions: [],
    checklist: Object.fromEntries(
      ["scope", "acceptance", "validation", "dependencies", "alignment"].map((name) => [
        name,
        true,
      ]),
    ),
    tdd: { required: true, reason: null },
    ...overrides,
  });
  const review = (overrides = {}) => ({
    version: 1,
    pr: 7,
    head: pull.head.sha,
    round: 1,
    verdict: "APPROVE",
    blockers: [],
    rethink: false,
    conflicts: false,
    body: "Accepted outcome verified",
    ...overrides,
  });
  return {
    config,
    api,
    reviewerApi,
    orchestrator: newOrchestrator(),
    newOrchestrator,
    project,
    item,
    issue,
    issues,
    pull,
    blockers,
    requests,
    moves,
    comments,
    publishedReviews,
    assessment,
    review,
  };
}

test("local triage records fresh readiness and claims once without workflow dispatch", async () => {
  const f = fixture();
  await f.orchestrator.ready(1, f.assessment());
  assert.equal(f.item.status, f.config.statuses.ready);
  const first = await f.orchestrator.claim(1);
  assert.ok(first);
  assert.equal(f.item.status, f.config.statuses.inProgress);
  const moveCount = f.moves.length;
  const second = await f.orchestrator.claim(1);
  assert.deepEqual(second, first);
  assert.equal(f.moves.length, moveCount);
  assert.ok(!f.requests.some(({ path }) => /\/actions\/|\/dispatches/.test(path)));
});

test("local readiness cannot invent native blockers or accept unanswered questions", async () => {
  for (const change of [{ blockers: ["acme/service#2"] }, { questions: ["Which outcome?"] }]) {
    const f = fixture();
    await assert.rejects(() => f.orchestrator.ready(1, f.assessment(change)));
    assert.equal(f.item.status, f.config.statuses.backlog);
    assert.ok(
      !f.requests.some(({ path, method }) => path.includes("/dependencies/") && method !== "GET"),
    );
  }
});

test("local claiming rejects stale scope and native blocker-set changes", async () => {
  const f = fixture();
  await f.orchestrator.ready(1, f.assessment());
  f.issue.body = "Changed acceptance criteria";
  await assert.rejects(() => f.orchestrator.claim(1));
  assert.equal(f.item.status, f.config.statuses.ready);
  const g = fixture();
  await g.orchestrator.ready(1, g.assessment());
  g.blockers.set(1, [
    {
      number: 2,
      repository_url: "https://api.github.com/repos/acme/service",
      state: "closed",
      state_reason: "completed",
    },
  ]);
  await assert.rejects(() => g.orchestrator.claim(1));
  assert.equal(g.item.status, g.config.statuses.ready);
});

test("local readiness keeps a blocked issue in Backlog until its dependencies complete", async () => {
  const f = fixture();
  const blocker = openNativeDependency(f);
  const assessment = f.assessment({ blockers: [`${repo}#2`] });
  for (const state of ["open", "closed"]) {
    blocker.state = state;
    blocker.state_reason = "not_planned";
    await assert.rejects(() => f.orchestrator.ready(1, assessment), /acme\/service#2/);
    assert.equal(f.item.status, f.config.statuses.backlog);
    assert.equal(f.comments.size, 0);
  }
  blocker.state_reason = "completed";
  await f.orchestrator.ready(1, assessment);
  assert.equal(f.item.status, f.config.statuses.ready);
});

function openNativeDependency(f) {
  const dependency = {
    number: 2,
    repository_url: "https://api.github.com/repos/acme/service",
    state: "open",
  };
  f.blockers.set(1, [dependency]);
  return dependency;
}

const operatorDecision = {
  blocker: "The acceptance criteria require both retaining and removing the legacy export.",
  action: "Confirm whether the legacy export must remain available.",
};

function hasReadableBlocker(f, report) {
  return (f.comments.get(1) || []).some(({ body }) => {
    const readable = body.replace(/^\`\`\`[^\n]*\n[\s\S]*?^\`\`\`[^\n]*$/gm, "");
    return readable.includes(report.blocker) && readable.includes(report.action);
  });
}

test("dependency-only triage stays in Backlog without an operator signal", async () => {
  const f = fixture();
  const dependency = openNativeDependency(f);
  await f.orchestrator.ready(1, f.assessment({ ready: false, blockers: [`${repo}#2`] }));
  assert.equal(f.item.status, f.config.statuses.backlog);
  assert.deepEqual(f.issue.labels, []);
  assert.deepEqual(f.blockers.get(1), [dependency]);
});

test("triage publishes the configured label and a readable operator action only once", async () => {
  const f = fixture();
  f.config.labels.needsHuman = "team:operator-input";
  f.issue.labels.push({ name: "existing-label" });
  const report = f.assessment({
    ready: false,
    humanAttention: operatorDecision,
  });

  await f.orchestrator.ready(1, report);
  assert.deepEqual(f.issue.labels.map(({ name }) => name).sort(), [
    "existing-label",
    "team:operator-input",
  ]);
  assert.equal(f.item.status, f.config.statuses.backlog);
  assert.ok(hasReadableBlocker(f, operatorDecision));
  await assert.rejects(() => f.newOrchestrator().ready(1, f.assessment()), /paused|human/i);
  await assert.rejects(() => f.newOrchestrator().claim(1), /paused|human/i);

  const firstComments = structuredClone(f.comments.get(1));
  await f.newOrchestrator().ready(1, report);
  assert.deepEqual(f.comments.get(1), firstComments);
  assert.equal(
    f.requests.filter(({ method, path }) => method === "POST" && path.endsWith("/labels")).length,
    1,
  );
});

test("operator clearance permits fresh triage while native dependencies still gate Ready", async () => {
  const f = fixture();
  const dependency = openNativeDependency(f);
  const nativeRefs = { blockers: [`${repo}#2`] };
  await f.orchestrator.ready(
    1,
    f.assessment({
      ...nativeRefs,
      ready: false,
      humanAttention: operatorDecision,
    }),
  );
  assert.deepEqual(f.issue.labels, [{ name: f.config.labels.needsHuman }]);
  assert.deepEqual(f.blockers.get(1), [dependency]);

  // An authorized GitHub operator removes the human-attention label in GitHub.
  f.issue.labels = [];
  await assert.rejects(
    () => f.newOrchestrator().ready(1, f.assessment(nativeRefs)),
    /acme\/service#2/,
  );
  await f.newOrchestrator().ready(1, f.assessment({ ...nativeRefs, ready: false }));
  assert.equal(f.item.status, f.config.statuses.backlog);
  assert.deepEqual(f.issue.labels, []);

  f.issue.labels = [{ name: f.config.labels.paused }];
  await assert.rejects(
    () =>
      f
        .newOrchestrator()
        .ready(1, f.assessment({ ...nativeRefs, ready: false, humanAttention: operatorDecision })),
    /paused/i,
  );
  assert.deepEqual(f.issue.labels, [{ name: f.config.labels.paused }]);
  dependency.state = "closed";
  dependency.state_reason = "completed";
  await assert.rejects(() => f.newOrchestrator().ready(1, f.assessment(nativeRefs)), /paused/i);
  f.issue.labels = [];
  await f.newOrchestrator().ready(1, f.assessment(nativeRefs));
  assert.equal(f.item.status, f.config.statuses.ready);
});

test("delivery can report a blocker without dropping the current claim", async () => {
  const f = fixture();
  await f.orchestrator.ready(1, f.assessment());
  const claim = await f.orchestrator.claim(1);
  const publishingScope = {
    blocker: "The accepted change requires a protected workflow file.",
    action: "Make the workflow change through the maintainer process.",
  };

  await assert.doesNotReject(() =>
    f.newOrchestrator().ready(1, f.assessment({ ready: false, humanAttention: publishingScope })),
  );
  assert.equal(f.item.status, f.config.statuses.inProgress);
  assert.deepEqual(f.issue.labels, [{ name: f.config.labels.needsHuman }]);
  assert.ok(hasReadableBlocker(f, publishingScope));
  await assert.rejects(() => f.newOrchestrator().claim(1), /paused|human/i);
  f.issue.labels = [];
  assert.deepEqual(await f.newOrchestrator().claim(1), claim);
});

test("review honors the linked issue's human-attention label", async () => {
  const f = fixture();
  await f.orchestrator.ready(1, f.assessment());
  await f.orchestrator.claim(1);
  f.issue.labels.push({ name: f.config.labels.needsHuman });
  await assert.rejects(() => f.orchestrator.review(7, f.review()), /paused|human/i);
  assert.equal(f.publishedReviews.length, 0);
});

for (const configuredLimit of [undefined, 3, 7]) {
  const limit = configuredLimit ?? 5;
  test(`local readiness enforces the ${limit}-story Ready limit across the Project`, async () => {
    const f = fixture();
    if (configuredLimit === undefined) delete f.config.maxReady;
    else f.config.maxReady = configuredLimit;
    const ready = f.config.statuses.ready;
    const backlog = f.config.statuses.backlog;
    f.project.items.push(
      ...Array.from({ length: limit - 2 }, (_, index) => ({
        status: ready,
        content: {
          __typename: "Issue",
          number: index + 20,
          repository: { nameWithOwner: "other/repo" },
        },
      })),
      { status: ready, content: null },
      { status: ready, isArchived: true },
      { status: ready, content: { __typename: "PullRequest" } },
    );
    await f.orchestrator.ready(1, f.assessment());
    assert.equal(f.item.status, ready);
    await f.orchestrator.ready(1, f.assessment());

    const next = { ...f.issue, number: 2, node_id: "issue-node-2" };
    f.issues.set(next.number, next);
    const assessment = f.assessment({ issue: next.number, digest: issueDigest(next) });
    await assert.rejects(
      () => f.orchestrator.ready(next.number, assessment),
      new RegExp(`Ready capacity is exhausted.*${limit}`),
    );
    assert.equal(f.project.find(repo, next.number), undefined);
    assert.equal(f.comments.has(next.number), false);

    await f.orchestrator.ready(1, f.assessment({ ready: false }));
    assert.equal(f.item.status, backlog);
    await f.orchestrator.ready(next.number, assessment);
    assert.equal(f.project.find(repo, next.number).status, ready);
  });
}

test("local claiming counts every active Project story and treats unknown work conservatively", async () => {
  const f = fixture();
  await f.orchestrator.ready(1, f.assessment());
  f.project.items.push(
    ...Array.from({ length: 4 }, (_, index) => ({
      id: `other-${index}`,
      status: f.config.statuses.inProgress,
      content: {
        __typename: "Issue",
        number: index + 20,
        repository: { nameWithOwner: "other/repo" },
      },
    })),
    { id: "opaque", status: f.config.statuses.inProgress, content: null },
  );
  await assert.rejects(() => f.orchestrator.claim(1));
  assert.equal(f.item.status, f.config.statuses.ready);
});

test("local claiming rejects paused issues and unadmitted outsiders", async () => {
  const f = fixture();
  await f.orchestrator.ready(1, f.assessment());
  f.issue.labels.push({ name: f.config.labels.paused });
  await assert.rejects(() => f.orchestrator.claim(1));
  assert.equal(f.item.status, f.config.statuses.ready);
  const g = fixture();
  g.issue.user.login = "outsider";
  await assert.rejects(() => g.orchestrator.ready(1, g.assessment()));
  assert.equal(g.item.status, g.config.statuses.backlog);
});

test("local review publishes through the separate reviewer at the exact current PR head", async () => {
  const f = fixture();
  await f.orchestrator.ready(1, f.assessment());
  await f.orchestrator.claim(1);
  await f.orchestrator.review(7, f.review());
  assert.equal(f.publishedReviews.length, 1);
  assert.equal(f.publishedReviews[0].commit_id, head);
  assert.ok(
    f.requests.some(
      ({ path, body }) =>
        path.endsWith(`/statuses/${head}`) &&
        body.context === "Agent review" &&
        body.state === "success",
    ),
  );
  await assert.rejects(() => f.orchestrator.review(7, f.review()));
  assert.equal(f.publishedReviews.length, 1);
});

test("local review rejects stale heads and the PR author's own reviewer identity", async () => {
  const f = fixture();
  await assert.rejects(() => f.orchestrator.review(7, f.review({ head: "b".repeat(40) })));
  assert.equal(f.publishedReviews.length, 0);
  f.pull.user = { login: "reviewer[bot]", id: 10102, type: "Bot" };
  await assert.rejects(() => f.orchestrator.review(7, f.review()));
  assert.equal(f.publishedReviews.length, 0);
});

test("local review stops conflicting instructions before another automatic fix", async () => {
  const f = fixture();
  const result = await f.orchestrator.review(
    7,
    f.review({ verdict: "REQUEST_CHANGES", blockers: ["behavior:wrong-result"], conflicts: true }),
  );
  assert.equal(result.action, "pause");
  assert.ok(
    !f.requests.some(({ path, body }) => path.includes("/statuses/") && body.state === "success"),
  );
});

test("local sync keeps drafts active, sends ready PRs to Review, and completes only merged work", async () => {
  const f = fixture();
  await f.orchestrator.ready(1, f.assessment());
  await f.orchestrator.claim(1);
  f.pull.draft = true;
  await f.orchestrator.sync(7);
  assert.equal(f.item.status, f.config.statuses.inProgress);
  f.pull.draft = false;
  await f.orchestrator.sync(7);
  assert.equal(f.item.status, f.config.statuses.review);
  f.pull.state = "closed";
  await f.orchestrator.sync(7);
  assert.notEqual(f.item.status, f.config.statuses.done);
  f.pull.merged = true;
  await f.orchestrator.sync(7);
  assert.equal(f.item.status, f.config.statuses.done);
});

test("local sync never completes unrelated or unclaimed issues", async () => {
  const f = fixture();
  f.pull.merged = true;
  await assert.rejects(() => f.orchestrator.sync(7));
  assert.notEqual(f.item.status, f.config.statuses.done);
  f.pull.body = "No closing reference";
  await assert.rejects(() => f.orchestrator.sync(7));
  assert.notEqual(f.item.status, f.config.statuses.done);
});

test("local admission checks current access rather than stale contributor association", async () => {
  const f = fixture();
  f.issue.user.login = "outsider";
  f.issue.author_association = "COLLABORATOR";
  await assert.rejects(() => f.orchestrator.ready(1, f.assessment()));
  assert.equal(f.item.status, f.config.statuses.backlog);
  assert.equal(f.comments.size, 0);
  f.issue.labels.push({ name: f.config.labels.admitted });
  await f.orchestrator.ready(1, f.assessment());
  assert.equal(f.item.status, f.config.statuses.ready);
});

function seedState(f, number, state) {
  f.comments.set(number, [
    {
      id: 500 + number,
      user: { login: "writer[bot]", id: 10101, type: "Bot" },
      body:
        "<!-- workflow-state:v1 -->\n\n```json\n" +
        JSON.stringify({ version: 1, number, ...state }) +
        "\n```",
    },
  ]);
}

test("local review preserves the lifetime cap recorded by legacy history", async () => {
  const f = fixture();
  seedState(f, 7, {
    history: Array.from({ length: 10 }, (_, index) => ({
      head: `${index}`.padStart(40, "0"),
      verdict: "REQUEST_CHANGES",
      blockers: [`finding-${index}`],
      fixAttempts: index,
      patch: `patch-${index}`,
    })),
  });
  await assert.rejects(() => f.orchestrator.review(7, f.review()));
  assert.equal(f.publishedReviews.length, 0);
  const g = fixture();
  seedState(g, 7, {
    history: Array.from({ length: 9 }, (_, index) => ({
      head: `${index}`.padStart(40, "0"),
      verdict: "REQUEST_CHANGES",
      blockers: [`finding-${index}`],
      fixAttempts: index,
      patch: `patch-${index}`,
    })),
  });
  const decision = await g.orchestrator.review(7, g.review({ round: 10 }));
  assert.equal(decision.action, "human-merge");
  assert.equal(g.publishedReviews.length, 1);
});

test("legacy pending hosted operations require reconciliation before local claims or reviews", async () => {
  const f = fixture();
  seedState(f, 7, { pending: { operation: "legacy-operation", kind: "review", head } });
  await assert.rejects(() => f.orchestrator.review(7, f.review()));
  assert.equal(f.publishedReviews.length, 0);
  const g = fixture();
  g.item.status = g.config.statuses.ready;
  seedState(g, 1, {
    triagedDigest: issueDigest(g.issue),
    triage: g.assessment(),
    pending: { operation: "legacy-implementation", kind: "implement" },
  });
  await assert.rejects(() => g.orchestrator.claim(1));
  assert.equal(g.item.status, g.config.statuses.ready);
});

test("local review requires current-head Green whenever the linked claim has TDD evidence", async () => {
  const f = fixture();
  seedState(f, 1, {
    claim: { issue: 1, branch: "agent/issue-1", digest: issueDigest(f.issue) },
    tdd: {
      version: 1,
      issue: 1,
      phase: "review",
      owner: null,
      head: "b".repeat(40),
      evidence: ["previous-green"],
    },
  });
  await assert.rejects(() => f.orchestrator.review(7, f.review()));
  assert.equal(f.publishedReviews.length, 0);
  const g = fixture();
  seedState(g, 1, {
    claim: { issue: 1, branch: "agent/issue-1", digest: issueDigest(g.issue) },
    tdd: {
      version: 1,
      issue: 1,
      phase: "review",
      owner: null,
      head,
      evidence: ["current-green"],
    },
  });
  assert.equal((await g.orchestrator.review(7, g.review())).action, "human-merge");
});

test("local sync cannot move a paused linked issue", async () => {
  for (const pauseKind of ["ledger", "label"]) {
    const f = fixture();
    f.item.status = f.config.statuses.review;
    f.pull.draft = true;
    seedState(f, 1, {
      claim: { issue: 1, branch: "agent/issue-1", digest: issueDigest(f.issue) },
      ...(pauseKind === "ledger" ? { paused: true } : {}),
    });
    if (pauseKind === "label") f.issue.labels.push({ name: f.config.labels.paused });
    await assert.rejects(() => f.orchestrator.sync(7));
    assert.equal(f.item.status, f.config.statuses.review);
    assert.equal(f.moves.length, 0);
  }
});

test("converting a reviewed PR to draft must acquire capacity before returning In Progress", async () => {
  const f = fixture();
  await f.orchestrator.ready(1, f.assessment());
  await f.orchestrator.claim(1);
  await f.orchestrator.sync(7);
  assert.equal(f.item.status, f.config.statuses.review);
  f.project.items.push(
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `busy-${index}`,
      status: f.config.statuses.inProgress,
      content: {
        __typename: "Issue",
        number: index + 30,
        repository: { nameWithOwner: "other/repo" },
      },
    })),
  );
  f.pull.draft = true;
  await assert.rejects(() => f.orchestrator.sync(7));
  assert.equal(f.item.status, f.config.statuses.review);
  f.project.items.pop();
  await f.orchestrator.sync(7);
  assert.equal(f.item.status, f.config.statuses.inProgress);
});

test("new claims wait until every unarchived Review story is finished", async () => {
  const reviewStories = [
    { content: { __typename: "Issue", number: 20, repository: { nameWithOwner: repo } } },
    {
      content: {
        __typename: "Issue",
        number: 21,
        repository: { nameWithOwner: "another/repository" },
      },
    },
    { content: { __typename: "DraftIssue", title: "Draft awaiting review" } },
    { content: null },
    {
      content: {
        __typename: "Issue",
        number: 22,
        labels: [{ name: "agent:paused" }],
        repository: { nameWithOwner: repo },
      },
    },
    {
      content: {
        __typename: "Issue",
        number: 23,
        labels: [{ name: "agent:needs-human" }],
        repository: { nameWithOwner: repo },
      },
    },
  ];
  for (const story of reviewStories) {
    const f = fixture();
    await f.orchestrator.ready(1, f.assessment());
    f.project.items.push({ id: "review-story", status: f.config.statuses.review, ...story });
    const before = f.requests.length;
    const moves = f.moves.length;
    await assert.rejects(() => f.orchestrator.claim(1), /review/i);
    assert.equal(f.item.status, f.config.statuses.ready);
    assert.equal(f.moves.length, moves);
    assert.ok(
      !f.requests.slice(before).some(({ method }) => ["POST", "PATCH", "PUT"].includes(method)),
      "Finish-before-start must reject before recording claim intent or moving the Project item",
    );
  }
});

test("Review work is reported before the capacity guard when a new claim is blocked", async () => {
  const f = fixture();
  await f.orchestrator.ready(1, f.assessment());
  f.project.items.push({ id: "review-story", status: f.config.statuses.review, content: null });
  f.project.items.push(
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `busy-${index}`,
      status: f.config.statuses.inProgress,
      content: { __typename: "Issue" },
    })),
  );
  await assert.rejects(() => f.orchestrator.claim(1), /review/i);
  assert.equal(f.item.status, f.config.statuses.ready);
});

test("archived Review stories and explicit PR items do not block a new story claim", async () => {
  const f = fixture();
  await f.orchestrator.ready(1, f.assessment());
  f.project.items.push(
    {
      id: "archived-review",
      status: f.config.statuses.review,
      isArchived: true,
      content: { __typename: "Issue", number: 9 },
    },
    {
      id: "pr-review",
      status: f.config.statuses.review,
      content: { __typename: "PullRequest", number: 7 },
    },
  );
  assert.ok(await f.orchestrator.claim(1));
  assert.equal(f.item.status, f.config.statuses.inProgress);
});

test("accepted claims resume during Review work without starting another story", async () => {
  for (const ownStatus of ["inProgress", "review"]) {
    const f = fixture();
    await f.orchestrator.ready(1, f.assessment());
    const accepted = await f.orchestrator.claim(1);
    f.item.status = f.config.statuses[ownStatus];
    f.project.items.push({
      id: "another-review",
      status: f.config.statuses.review,
      content: { __typename: "Issue", number: 9, repository: { nameWithOwner: "another/repo" } },
    });
    const moves = f.moves.length;
    assert.deepEqual(await f.orchestrator.claim(1), accepted);
    assert.equal(f.moves.length, moves);
    assert.equal(f.item.status, f.config.statuses[ownStatus]);
  }
});

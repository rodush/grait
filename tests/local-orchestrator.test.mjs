import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { issueDigest } from "../scripts/lib/policy.mjs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sourceRoot =
  process.env.GRAIT_TEST_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url));
const orchestratorModule = await import(
  pathToFileURL(resolve(sourceRoot, "scripts/lib/orchestrator.mjs"))
);
const { LocalOrchestrator, cleanupTaskArtifacts } = orchestratorModule;
const setupStateUrl = pathToFileURL(resolve(sourceRoot, "scripts/lib/setup-state.mjs"));
const { SetupState } = await import(setupStateUrl);
const baseConfig = JSON.parse(await readFile(resolve(sourceRoot, "workflow.config.json"), "utf8"));
const repo = "acme/service";
const head = "a".repeat(40);

function fixture({
  store,
  ci,
  defaultBranch = "main",
  closingIssueNodes = [{ number: 1, repository: { nameWithOwner: repo } }],
} = {}) {
  const config = {
    ...baseConfig,
    controllerRepository: repo,
    humanOperators: ["operator"],
    labels: { ...baseConfig.labels },
  };
  delete config.ci;
  if (ci) config.ci = ci;
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
    head: { ref: "agent/issue-1", sha: head, repo: { full_name: repo } },
    base: { ref: defaultBranch, repo: { full_name: repo } },
    state: "open",
    merged: false,
    draft: false,
  };
  const issues = new Map([[1, issue]]);
  const comments = new Map();
  const blockers = new Map([[1, []]]);
  const requests = [];
  const publishedReviews = [];
  const linkedReviewPulls = new Map();
  const reviewPulls = new Map();
  const checkRuns = new Map();
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
    async graphql(query, { owner, name, number } = {}) {
      if (/\bclosedByPullRequestsReferences\b/.test(query)) {
        const nodes = linkedReviewPulls.get(`${owner}/${name}#${number}`) || [];
        return {
          repository: {
            issue: {
              closedByPullRequestsReferences: {
                totalCount: nodes.length,
                nodes: nodes.slice(0, 2),
                pageInfo: { hasNextPage: nodes.length > 2 },
              },
            },
          },
        };
      }
      if (!/\bclosingIssuesReferences\b/.test(query))
        throw new Error("Unsupported local GraphQL query");
      return {
        repository: {
          pullRequest: {
            closingIssuesReferences: {
              nodes: closingIssueNodes,
              pageInfo: { hasNextPage: false },
            },
          },
        },
      };
    },
    async request(path, options = {}) {
      requests.push({ path, ...options });
      const method = options.method || "GET";
      const issueMatch = path.match(/^repos\/acme\/service\/issues\/(\d+)$/);
      if (method === "GET" && issueMatch) return issues.get(Number(issueMatch[1]));
      if (method === "GET" && path === `repos/${repo}/pulls/7`) return pull;
      if (method === "GET" && reviewPulls.has(path)) return reviewPulls.get(path).pull;
      if (method === "GET" && path === `repos/${repo}`)
        return { full_name: repo, default_branch: defaultBranch };
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
    async list(path, key) {
      const checks = path.match(
        /^repos\/acme\/service\/commits\/([a-f0-9]{40})\/check-runs(?:\?|$)/,
      );
      if (checks) {
        requests.push({ path, key });
        assert.equal(key, "check_runs");
        const runs = checkRuns.get(checks[1]);
        if (runs instanceof Error) throw runs;
        return runs || [];
      }
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
      const pullListing = path.match(/^(.*\/pulls\/\d+)\/(reviews|comments)$/);
      if (pullListing) {
        const evidence = reviewPulls.get(pullListing[1]);
        if (pullListing[2] === "comments" && evidence) return evidence.findings;
        if (evidence?.reviews instanceof Error) throw evidence.reviews;
        if (evidence) return evidence.reviews;
      }
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
  const newOrchestrator = (orchestratorStore = store) =>
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
      store: orchestratorStore,
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
    linkedReviewPulls,
    reviewPulls,
    checkRuns,
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

function readableIssueComments(f) {
  return (f.comments.get(1) || []).map(({ body }) =>
    body.replace(/^\`\`\`[^\n]*\n[\s\S]*?^\`\`\`[^\n]*$/gm, ""),
  );
}

function hasReadableBlocker(f, report) {
  return readableIssueComments(f).some(
    (comment) => comment.includes(report.blocker) && comment.includes(report.action),
  );
}

test("dependency-only triage stays in Backlog without an operator signal", async () => {
  const f = fixture();
  const dependency = openNativeDependency(f);
  await f.orchestrator.ready(1, f.assessment({ ready: false, blockers: [`${repo}#2`] }));
  assert.equal(f.item.status, f.config.statuses.backlog);
  assert.deepEqual(f.issue.labels, []);
  assert.deepEqual(f.blockers.get(1), [dependency]);
});

test("ordinary triage questions surface the operator decision on the issue", async () => {
  const f = fixture();
  const dependency = openNativeDependency(f);
  const question = "Should the release retain the legacy export or remove it?";
  await f.orchestrator.ready(
    1,
    f.assessment({ ready: false, blockers: [`${repo}#2`], questions: [question] }),
  );

  assert.equal(f.item.status, f.config.statuses.backlog);
  assert.deepEqual(f.blockers.get(1), [dependency]);
  assert.deepEqual(f.issue.labels, [{ name: f.config.labels.needsHuman }]);
  assert.ok(readableIssueComments(f).some((comment) => comment.includes(question)));
  await assert.rejects(() => f.newOrchestrator().claim(1), /paused|human/i);
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

test("a replenishment pass fills only available Ready slots and reopens after a claim", async () => {
  const f = fixture();
  delete f.config.maxReady;
  const { backlog, ready, inProgress, review } = f.config.statuses;
  const dependency = openNativeDependency(f);
  const assess = async (number, fields = {}) => {
    const issue = f.issues.get(number);
    return f.orchestrator.ready(
      number,
      f.assessment({ issue: number, digest: issueDigest(issue), ...fields }),
    );
  };
  const status = (number) => f.project.find(repo, number)?.status;
  const readyNumbers = () =>
    f.project.items.filter((item) => item.status === ready).map((item) => item.content.number);

  for (let number = 2; number <= 8; number++) {
    const issue = { ...f.issue, number, node_id: `issue-node-${number}` };
    f.issues.set(number, issue);
    await f.project.add(issue, repo);
  }
  f.project.items.push({
    status: review,
    content: {
      __typename: "Issue",
      number: 20,
      repository: { nameWithOwner: "other/repo" },
    },
  });

  await assess(1, { ready: false, blockers: [`${repo}#2`] });
  for (const number of [2, 3, 4, 5, 6]) await assess(number);
  assert.deepEqual(readyNumbers(), [2, 3, 4, 5, 6]);
  await assert.rejects(() => assess(7), /Ready capacity is exhausted/);
  assert.equal(status(1), backlog);
  assert.equal(status(7), backlog);
  assert.equal(status(8), backlog);

  await f.orchestrator.claim(2);
  await assess(7);
  assert.equal(status(2), inProgress);
  assert.deepEqual(readyNumbers(), [3, 4, 5, 6, 7]);
  assert.equal(status(1), backlog);

  await f.orchestrator.claim(3);
  dependency.state = "closed";
  dependency.state_reason = "completed";
  await assess(1, { blockers: [`${repo}#2`] });
  assert.deepEqual(readyNumbers(), [1, 4, 5, 6, 7]);
  assert.equal(status(8), backlog);
});

test("a small replenishment pass can exhaust eligible Backlog before filling Ready", async () => {
  const f = fixture();
  const { backlog, ready } = f.config.statuses;
  openNativeDependency(f);
  const eligible = { ...f.issue, number: 2, node_id: "issue-node-2" };
  f.issues.set(eligible.number, eligible);
  await f.project.add(eligible, repo);

  await f.orchestrator.ready(1, f.assessment({ ready: false, blockers: [`${repo}#2`] }));
  await f.orchestrator.ready(2, f.assessment({ issue: 2, digest: issueDigest(eligible) }));

  assert.deepEqual(
    f.project.items.map(({ status, content }) => [content.number, status]),
    [
      [1, backlog],
      [2, ready],
    ],
  );
});

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

test("review requires current successful check runs from every configured publisher", async () => {
  const candidate = "b".repeat(40);
  const requiredChecks = [
    { name: "Compile", appId: 17 },
    { name: "Integration", appId: 18 },
  ];
  const run = (required, overrides = {}) => ({
    id: 100,
    name: required.name,
    app: { id: required.appId },
    head_sha: candidate,
    status: "completed",
    conclusion: "success",
    details_url: "https://github.com/acme/service/actions/runs/12",
    ...overrides,
  });
  const compile = run(requiredChecks[0]);
  const integration = run(requiredChecks[1], { id: 110 });
  for (const [label, runs] of [
    ["missing", [compile]],
    ["unavailable", new Error("Check runs unavailable")],
    ["in progress", [compile, { ...integration, status: "in_progress", conclusion: null }]],
    ["failed", [compile, { ...integration, conclusion: "failure" }]],
    ["skipped", [compile, { ...integration, conclusion: "skipped" }]],
    ["wrong publisher", [compile, { ...integration, app: { id: 17 } }]],
    ["stale result", [compile, { ...integration, head_sha: head }]],
    [
      "newer rerun pending",
      [{ ...integration, id: 111, status: "queued", conclusion: null }, compile, integration],
    ],
  ]) {
    const f = fixture({ ci: { requiredChecks } });
    f.pull.head.sha = candidate;
    f.checkRuns.set(
      head,
      [compile, integration].map((check) => ({ ...check, head_sha: head })),
    );
    f.checkRuns.set(candidate, runs);
    await assert.rejects(() => f.orchestrator.review(7, f.review()), undefined, label);
    assert.equal(f.publishedReviews.length, 0, label);
    assert.ok(
      f.requests.some(({ path }) =>
        path.startsWith(`repos/${repo}/commits/${candidate}/check-runs`),
      ),
      label,
    );
    assert.ok(!f.requests.some(({ path }) => path.includes(`/commits/${head}/check-runs`)), label);
  }

  const f = fixture({ ci: { requiredChecks } });
  f.pull.head.sha = candidate;
  f.checkRuns.set(candidate, [
    integration,
    { ...integration, id: 109, conclusion: "failure" },
    { ...compile, id: 300, app: { id: 99 }, conclusion: "failure" },
    compile,
  ]);
  await f.orchestrator.review(7, f.review());
  assert.equal(f.publishedReviews.length, 1);
  assert.equal(f.publishedReviews[0].commit_id, candidate);
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

test("conflicting reviews surface the operator action on the linked issue and preserve the review pause", async () => {
  const f = fixture();
  f.config.labels.needsHuman = "team:operator-input";
  await f.orchestrator.ready(1, f.assessment());
  await f.orchestrator.claim(1);
  await f.orchestrator.sync(7);

  const result = await f.orchestrator.review(
    7,
    f.review({ verdict: "REQUEST_CHANGES", conflicts: true }),
  );

  assert.equal(result.action, "pause");
  assert.equal(f.item.status, f.config.statuses.review);
  assert.equal(f.publishedReviews.length, 1);
  assert.deepEqual(f.issue.labels, [{ name: f.config.labels.needsHuman }]);
  assert.ok(
    readableIssueComments(f).some(
      (comment) => /conflict/i.test(comment) && /reconcil|resolv|decide|clarif/i.test(comment),
    ),
  );

  // Removing the issue label alone does not clear the separately recorded PR pause.
  f.issue.labels = [];
  f.pull.head.sha = "b".repeat(40);
  await assert.rejects(() => f.newOrchestrator().review(7, f.review({ round: 2 })), /paused/i);
  assert.equal(f.publishedReviews.length, 1);
});

test("local sync keeps drafts active, sends ready PRs to Review, and completes only merged work", async (t) => {
  await inTaskRepository(t, async ({ f }) => {
    Object.assign(f.pull, { merged: false, state: "open", draft: true });
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
});

test("local sync rejects a same-repository merge outside the default branch before completion", async (t) => {
  await inTaskRepository(
    t,
    async ({ f, git, branch, head, worktree, scratch }) => {
      f.item.status = f.config.statuses.review;
      f.pull.base.ref = "main";

      await assert.rejects(() => f.orchestrator.sync(7), /default.branch/i);
      assert.equal(f.item.status, f.config.statuses.review);
      assert.equal((await f.orchestrator.ledger.load(1)).state.completedPR, undefined);
      assert.ok(existsSync(worktree));
      assert.ok(existsSync(scratch));
      assert.equal(git("rev-parse", `refs/heads/${branch}`), head);
    },
    { defaultBranch: "delivery" },
  );
});

test("local sync rejects a default-branch merge without a GitHub-recognized closing reference", async (t) => {
  await inTaskRepository(
    t,
    async ({ f, git, branch, head, worktree, scratch }) => {
      f.item.status = f.config.statuses.review;
      f.pull.body = "Example syntax: `Closes #1`";
      const moves = f.moves.length;
      const graphql = f.api.graphql.bind(f.api);
      let returnedReferences;
      f.api.graphql = async (...args) => {
        const result = await graphql(...args);
        returnedReferences = result.repository.pullRequest.closingIssuesReferences;
        return result;
      };

      await assert.rejects(
        () => f.orchestrator.sync(7),
        "a raw body match without a GitHub closing reference must not complete the claim",
      );
      assert.deepEqual(returnedReferences, { nodes: [], pageInfo: { hasNextPage: false } });
      assert.equal(f.moves.length, moves);
      assert.equal(f.item.status, f.config.statuses.review);
      assert.equal((await f.orchestrator.ledger.load(1)).state.completedPR, undefined);
      assert.equal(await readFile(join(worktree, "delivery.txt"), "utf8"), "delivered content");
      assert.equal(await readFile(join(scratch, "notes"), "utf8"), "completed task scratch");
      assert.equal(git("rev-parse", `refs/heads/${branch}`), head);
    },
    { closingIssueNodes: [] },
  );
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

async function inTaskRepository(
  t,
  run,
  { foreignPath = false, defaultBranch = "main", tddRequired = false, closingIssueNodes } = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "grait-task-cleanup-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "service");
  const worktree = join(root, foreignPath ? "operator-checkouts" : "service-worktrees", "issue-1");
  const scratchRoot = join(cwd, ".git", "grait-setup", "issue-scratch");
  const scratch = join(scratchRoot, "issue-1");
  const branch = "agent/issue-1";
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();

  await mkdir(cwd);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  await writeFile(join(scratch, "notes"), "completed task scratch");
  const { dev, ino } = await stat(scratch);
  const scratchIdentity = { dev, ino };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Cleanup Test");
  git("config", "user.email", "cleanup@example.test");
  git("config", "commit.gpgsign", "false");
  git("remote", "add", "origin", `https://github.com/${repo}.git`);
  git("commit", "--allow-empty", "-m", "Base");
  git("commit", "--allow-empty", "-m", "Main history");
  await mkdir(resolve(worktree, ".."), { recursive: true });
  git("worktree", "add", "-b", branch, worktree);
  await writeFile(join(worktree, "delivery.txt"), "delivered content");
  git("-C", worktree, "add", "delivery.txt");
  git("-C", worktree, "commit", "-m", "Deliver issue");
  const head = git("-C", worktree, "rev-parse", "HEAD");
  git("merge", "--squash", branch);
  git("commit", "-m", "Squash merge issue");
  assert.ok(!git("rev-list", "main").split("\n").includes(head));

  const reservations = new Set();
  const f = fixture({
    defaultBranch,
    closingIssueNodes,
    store: {
      prepareIssueArtifacts() {},
      hasIssueReservation: (issue) => reservations.has(issue),
      issueScratchIdentity: (issue) => (issue === 1 ? scratchIdentity : null),
    },
  });
  await f.orchestrator.ready(
    1,
    f.assessment({
      tdd: {
        required: tddRequired,
        reason: tddRequired ? null : "Fixture uses a TDD-exempt claim",
      },
    }),
  );
  await f.orchestrator.claim(1);
  Object.assign(f.pull, {
    merged: true,
    state: "closed",
    merge_commit_sha: git("rev-parse", "main"),
  });
  Object.assign(f.pull.head, { ref: branch, sha: head });

  const previousCwd = process.cwd();
  process.chdir(cwd);
  try {
    await run({
      f,
      git,
      cwd,
      branch,
      head,
      worktree,
      scratch,
      scratchRoot,
      scratchIdentity,
      reservations,
    });
  } finally {
    process.chdir(previousCwd);
  }
}

test("local sync removes the completed squash-merged task and preserves active task artifacts", async (t) => {
  await inTaskRepository(t, async ({ f, git, cwd, branch, worktree, scratch, scratchRoot }) => {
    const active = resolve(worktree, "..", "issue-2");
    const activeScratch = join(scratchRoot, "issue-2");
    const shared = resolve(scratchRoot, "..", "operator-state");
    git("worktree", "add", "-b", "agent/issue-2", active, "main");
    await mkdir(activeScratch);
    await writeFile(join(activeScratch, "notes"), "active task scratch");
    await writeFile(shared, "shared operator data");
    const activeItem = await f.project.add({ number: 2 }, repo);
    await f.project.move(activeItem, f.config.statuses.review);

    const move = f.project.move.bind(f.project);
    f.project.move = async (item, status) => {
      assert.ok(existsSync(worktree), "task worktree must exist before Done");
      assert.ok(existsSync(scratch), "task scratch must exist before Done");
      await move(item, status);
    };
    const result = await f.orchestrator.sync(7);
    f.project.move = move;
    assert.equal(result.status, f.config.statuses.done);
    assert.equal((await f.orchestrator.ledger.load(1)).state.completedPR, 7);
    assert.equal(existsSync(worktree), false, "the completed task worktree is removed");
    assert.equal(git("branch", "--list", branch), "");
    assert.equal(existsSync(scratch), false);
    assert.equal(await readFile(join(cwd, "delivery.txt"), "utf8"), "delivered content");
    assert.equal(
      git("branch", "--list", "--format=%(refname:short)", "agent/issue-2"),
      "agent/issue-2",
    );
    assert.ok(existsSync(active));
    assert.equal(await readFile(join(activeScratch, "notes"), "utf8"), "active task scratch");
    assert.equal(await readFile(shared, "utf8"), "shared operator data");
    assert.equal(activeItem.status, f.config.statuses.review);
    assert.ok(result.cleanup?.removed?.length > 0, "sync reports removed artifacts");
    assert.deepEqual(result.cleanup.failures, []);

    const repeated = await f.orchestrator.sync(7);
    assert.equal(repeated.status, f.config.statuses.done);
    assert.deepEqual(repeated.cleanup?.removed, []);
    assert.deepEqual(repeated.cleanup?.failures, []);
  });
});

test("local sync removes only the completed issue's empty reservation directory", async (t) => {
  await inTaskRepository(t, async ({ f, cwd, scratch, scratchIdentity }) => {
    const directory = await SetupState.location(cwd);
    const store = new SetupState(directory, { version: 1, repo, apps: {} });
    const orchestrator = f.newOrchestrator(store);
    await store.acquire();
    try {
      const ownershipRecord = await store.issueArtifactPath(1, "issue-scratch-owners", true);
      await writeFile(ownershipRecord, JSON.stringify(scratchIdentity), { mode: 0o600 });
      const reservations = join(directory, "issue-reservations");
      const completedReservation = join(reservations, "issue-1");
      const otherReservation = join(reservations, "issue-2");
      await mkdir(completedReservation, { recursive: true, mode: 0o700 });
      await mkdir(otherReservation, { mode: 0o700 });

      const result = await orchestrator.sync(7);
      assert.equal(result.status, f.config.statuses.done);
      assert.deepEqual(result.cleanup.failures, []);
      assert.equal(existsSync(scratch), false);
      assert.ok((await stat(otherReservation)).isDirectory());
      assert.equal(existsSync(completedReservation), false, "the empty reservation is removed");

      const repeated = await orchestrator.sync(7);
      assert.equal(repeated.status, f.config.statuses.done);
      assert.deepEqual(repeated.cleanup.removed, []);
      assert.deepEqual(repeated.cleanup.failures, []);
      assert.equal(existsSync(completedReservation), false);
      assert.ok((await stat(otherReservation)).isDirectory());
    } finally {
      await store.release();
    }
  });
});

test("local claim prepares artifacts for the accepted issue", async () => {
  const prepared = [];
  const f = fixture({
    store: {
      prepareIssueArtifacts(issue) {
        prepared.push(issue);
      },
    },
  });
  await f.orchestrator.ready(1, f.assessment());
  await f.orchestrator.claim(1);

  assert.deepEqual(prepared, [1]);
});

test(
  "accepted commands can overlap for the same issue and retain cleanup protection until both exit",
  { timeout: 10_000 },
  async (t) => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "grait-reservation-test-")));
    const directory = join(home, "setup");
    const store = new SetupState(directory, { version: 1, repo, apps: {} });
    const children = [];
    t.after(async () => {
      for (const { child } of children) child.kill();
      await Promise.allSettled(children.map(({ closed }) => closed));
      await rm(home, { recursive: true, force: true });
    });

    async function startAcceptedCommand() {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `
          const [setupStateUrl, directory, repo] = process.argv.slice(1);
          const { SetupState } = await import(setupStateUrl);
          const store = new SetupState(directory, { version: 1, repo, apps: {} });
          await store.acquire();
          let preparationError;
          try {
            await store.prepareIssueArtifacts(1);
          } catch (error) {
            preparationError = error.message;
          } finally {
            await store.release();
          }
          process.send({ preparationError });
          for await (const chunk of process.stdin) {
            // Stay active after releasing the setup lock until the test closes stdin.
          }
          process.disconnect();
        `,
          setupStateUrl.href,
          directory,
          repo,
        ],
        { cwd: home, env: { HOME: home }, stdio: ["pipe", "ignore", "inherit", "ipc"] },
      );
      const closed = once(child, "close");
      children.push({ child, closed });
      const [{ preparationError }] = await Promise.race([
        once(child, "message"),
        closed.then(([code, signal]) => {
          throw new Error(
            `Command stopped before reporting preparation (code ${code}, signal ${signal})`,
          );
        }),
      ]);
      async function finish() {
        child.stdin.end();
        const [code, signal] = await closed;
        if (code !== 0)
          throw new Error(`Command did not exit normally (code ${code}, signal ${signal})`);
      }
      if (preparationError !== undefined) await finish();
      return { preparationError, finish };
    }

    const worker = await startAcceptedCommand();
    assert.equal(worker.preparationError, undefined, "the worker prepares the accepted issue");
    assert.equal(await store.hasIssueReservation(1), true);
    const publisher = await startAcceptedCommand();
    assert.equal(
      publisher.preparationError,
      undefined,
      "the publisher can prepare the same accepted issue while the worker is active",
    );
    assert.equal(await store.hasIssueReservation(1), true);

    await worker.finish();
    assert.equal(
      await store.hasIssueReservation(1),
      true,
      "the publisher still protects the issue",
    );
    await publisher.finish();
    assert.equal(await store.hasIssueReservation(1), false);
  },
);

for (const handoff of ["TDD-exempt claim", "released exact-head TDD handoff"]) {
  test(`local sync waits for a task reservation to release after a ${handoff}`, async (t) => {
    await inTaskRepository(
      t,
      async ({ f, git, branch, head, worktree, scratch, reservations }) => {
        const orchestrator = f.newOrchestrator();
        if (handoff === "released exact-head TDD handoff") {
          const { state } = await f.orchestrator.ledger.load(1);
          seedState(f, 1, {
            ...state,
            tdd: {
              version: 1,
              issue: 1,
              branch,
              acceptanceDigest: state.claim.digest,
              phase: "review",
              owner: null,
              head,
              evidence: ["current-green"],
            },
          });
        }
        reservations.add(1);
        reservations.add(2);

        const blocked = await orchestrator.sync(7);
        assert.ok(existsSync(worktree), "a live issue reservation preserves the task worktree");
        assert.equal(git("rev-parse", `refs/heads/${branch}`), head);
        assert.equal(await readFile(join(scratch, "notes"), "utf8"), "completed task scratch");
        assert.deepEqual(blocked.cleanup?.removed, []);
        assert.match(blocked.cleanup.failures.join("\n"), /reserv|worker|active/i);

        reservations.delete(1);
        const retried = await orchestrator.sync(7);
        assert.equal(retried.status, f.config.statuses.done);
        assert.deepEqual(retried.cleanup?.failures, []);
        assert.equal(existsSync(worktree), false);
        assert.equal(git("branch", "--list", branch), "");
        assert.equal(existsSync(scratch), false);
      },
      { tddRequired: handoff === "released exact-head TDD handoff" },
    );
  });
}

test("local sync preserves a dirty completed worktree and reports the cleanup failure", async (t) => {
  await inTaskRepository(t, async ({ f, git, branch, head, worktree }) => {
    const untracked = join(worktree, "operator-notes");
    await writeFile(untracked, "uncommitted notes");

    const result = await f.orchestrator.sync(7);
    assert.equal(result.status, f.config.statuses.done);
    assert.equal((await f.orchestrator.ledger.load(1)).state.completedPR, 7);
    assert.equal(await readFile(untracked, "utf8"), "uncommitted notes");
    assert.equal(git("rev-parse", branch), head);
    assert.ok(result.cleanup?.failures?.length > 0, "sync reports the blocked cleanup");
  });
});

test("local sync leaves task artifacts in place when the Project cannot move to Done", async (t) => {
  await inTaskRepository(t, async ({ f, git, branch, head, worktree, scratch }) => {
    f.project.move = async () => {
      throw new Error("Project move failed");
    };
    await assert.rejects(() => f.orchestrator.sync(7), /Project move failed/);
    assert.ok(existsSync(worktree));
    assert.ok(existsSync(scratch));
    assert.equal(git("rev-parse", branch), head);
    assert.equal((await f.orchestrator.ledger.load(1)).state.completedPR, undefined);
  });
});

for (const state of ["open", "closed"]) {
  test(`local sync preserves task artifacts for an unmerged ${state} PR`, async (t) => {
    await inTaskRepository(t, async ({ f, git, branch, head, worktree, scratch }) => {
      Object.assign(f.pull, { merged: false, state });
      await f.orchestrator.sync(7);
      assert.notEqual(f.item.status, f.config.statuses.done);
      assert.ok(existsSync(worktree));
      assert.ok(existsSync(scratch));
      assert.equal(git("rev-parse", branch), head);
    });
  });
}

test("task artifact cleanup preserves a divergent local branch and its worktree", async (t) => {
  await inTaskRepository(t, async ({ git, cwd, branch, head, worktree }) => {
    git("-C", worktree, "commit", "--allow-empty", "-m", "Unmerged operator work");
    const divergent = git("rev-parse", branch);
    const report = await cleanupTaskArtifacts({ issue: 1, branch, head, cwd, repo });
    assert.equal(git("rev-parse", branch), divergent);
    assert.ok(existsSync(worktree));
    assert.ok(report.failures.length > 0, "cleanup reports the divergent branch");
  });
});

test("task artifact cleanup preserves a worktree outside its canonical path", async (t) => {
  await inTaskRepository(
    t,
    async ({ git, cwd, branch, head, worktree }) => {
      const report = await cleanupTaskArtifacts({ issue: 1, branch, head, cwd, repo });
      assert.equal(git("rev-parse", branch), head);
      assert.ok(existsSync(worktree));
      assert.ok(report.failures.length > 0, "cleanup reports the foreign worktree");
    },
    { foreignPath: true },
  );
});

test("task artifact cleanup preserves the exact branch ref during a detached bisect in another worktree", async (t) => {
  await inTaskRepository(t, async ({ git, cwd, branch, head, worktree }) => {
    const bisect = resolve(worktree, "..", "operator-bisect");
    git("worktree", "remove", worktree);
    git("worktree", "add", bisect, branch);
    git("-C", bisect, "bisect", "start", "HEAD", "HEAD~2");
    assert.match(git("worktree", "list", "--porcelain"), /^detached$/m);
    const ref = `refs/heads/${branch}`;

    const report = await cleanupTaskArtifacts({ issue: 1, branch, head, cwd, repo });

    assert.equal(git("for-each-ref", "--format=%(objectname)", ref), head);
    assert.match(report.failures.join("\n"), /bisect|branch.*(use|worktree|checked out)/i);
  });
});

test("task artifact cleanup preserves unregistered scratch data", async (t) => {
  await inTaskRepository(t, async ({ cwd, branch, head, scratch }) => {
    const report = await cleanupTaskArtifacts({ issue: 1, branch, head, cwd, repo });

    assert.ok(existsSync(scratch), "a canonical path alone does not establish scratch ownership");
    assert.equal(await readFile(join(scratch, "notes"), "utf8"), "completed task scratch");
    assert.match(report.failures.join("\n"), /unregistered|ownership|identity|not.*registered/i);
  });
});

test("task artifact cleanup preserves replacement scratch with a different directory identity", async (t) => {
  await inTaskRepository(t, async ({ cwd, branch, head, scratch, scratchIdentity }) => {
    await rename(scratch, `${scratch}-original`);
    await mkdir(scratch);
    await writeFile(join(scratch, "operator-notes"), "replacement directory");

    const report = await cleanupTaskArtifacts({
      issue: 1,
      branch,
      head,
      cwd,
      repo,
      scratchIdentity,
    });

    assert.ok(existsSync(scratch), "the registered identity does not match the replacement");
    assert.equal(await readFile(join(scratch, "operator-notes"), "utf8"), "replacement directory");
    assert.match(report.failures.join("\n"), /identity|ownership|changed|mismatch/i);
  });
});

test("task artifact cleanup preserves an independent Git checkout inside registered scratch", async (t) => {
  await inTaskRepository(t, async ({ git, cwd, branch, head, scratch, scratchIdentity }) => {
    const checkout = join(scratch, "independent");
    await mkdir(checkout);
    git("-C", checkout, "init", "--initial-branch=main");
    const notes = join(checkout, "operator-notes");
    await writeFile(notes, "independent checkout data");

    const report = await cleanupTaskArtifacts({
      issue: 1,
      branch,
      head,
      cwd,
      repo,
      scratchIdentity,
    });

    assert.ok(existsSync(join(checkout, ".git", "HEAD")), "embedded Git metadata is preserved");
    assert.equal(await readFile(notes, "utf8"), "independent checkout data");
    assert.match(report.failures.join("\n"), /checkout|git metadata|\.git/i);
  });
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

function addInProgressStories(f, count) {
  for (let index = 0; index < count; index++) {
    f.project.items.push({
      id: `busy-${index}`,
      status: f.config.statuses.inProgress,
      content: { __typename: "Issue", number: 30 + index, repository: { nameWithOwner: repo } },
    });
  }
}

function addReviewStory(
  f,
  {
    number = 20,
    repository = "another/repository",
    currentHead = head,
    reviews = [],
    includePull = true,
    findings = [],
  } = {},
) {
  const item = {
    id: `review-${number}`,
    status: f.config.statuses.review,
    content: { __typename: "Issue", number, repository: { nameWithOwner: repository } },
  };
  f.project.items.push(item);
  const pullNumber = number + 100;
  const nodes = includePull
    ? [
        {
          number: pullNumber,
          state: "OPEN",
          isDraft: false,
          headRefOid: currentHead,
          repository: { nameWithOwner: repository },
          reviewThreads: {
            nodes: findings.map((finding) => ({
              isResolved: false,
              comments: { nodes: [finding] },
            })),
            pageInfo: { hasNextPage: false },
          },
        },
      ]
    : [];
  f.linkedReviewPulls.set(`${repository}#${number}`, nodes);
  const evidence = {
    pull: {
      number: pullNumber,
      state: "open",
      draft: false,
      head: { sha: currentHead },
    },
    reviews,
    findings,
  };
  if (includePull) f.reviewPulls.set(`repos/${repository}/pulls/${pullNumber}`, evidence);
  return { item, nodes, evidence };
}

function reviewDecision(state, reviewer, { id = reviewer, commit = head, body = "" } = {}) {
  return {
    id,
    user: { id: reviewer, login: `reviewer-${reviewer}`, type: reviewer === 1 ? "Bot" : "User" },
    state,
    commit_id: commit,
    submitted_at: new Date(Date.UTC(2026, 10, 23, 19, 0, id)).toISOString(),
    body,
  };
}

test("an approval at the current head frees a story slot even with unresolved findings", async () => {
  for (const unresolvedCount of [0, 2]) {
    const f = fixture();
    await f.orchestrator.ready(1, f.assessment());
    addInProgressStories(f, 4);
    const { item } = addReviewStory(f, {
      reviews: [reviewDecision("APPROVED", unresolvedCount === 0 ? 1 : 2)],
      findings: Array.from({ length: unresolvedCount }, (_, index) => ({
        id: index + 1,
        body: `Unresolved finding ${index + 1}`,
      })),
    });
    const claim = await f.orchestrator.claim(1).catch((error) => error.message);
    assert.equal(claim.issue, 1, `Expected claim with ${unresolvedCount} open findings: ${claim}`);
    assert.equal(item.status, f.config.statuses.review);
    assert.equal(f.item.status, f.config.statuses.inProgress);
  }
});

test("a pending, unverifiable, or rejected review reserves one slot without leaving Review", async () => {
  const cases = [
    ["first approval pending", { reviews: [reviewDecision("COMMENTED", 1)] }],
    ["pull request missing", { includePull: false }],
    ["review listing unavailable", { reviews: new Error("Review listing unavailable") }],
    [
      "request for changes despite approval",
      {
        reviews: [
          reviewDecision("APPROVED", 1),
          reviewDecision("CHANGES_REQUESTED", 2, { body: "P1 first finding\nP1 second finding" }),
        ],
        findings: [{ id: 1 }, { id: 2 }, { id: 3 }],
      },
    ],
  ];
  for (const [name, review] of cases) {
    for (const busyCount of [3, 4]) {
      const f = fixture();
      await f.orchestrator.ready(1, f.assessment());
      addInProgressStories(f, busyCount);
      const { item } = addReviewStory(f, review);
      const before = f.requests.length;
      if (busyCount === 3) {
        const claim = await f.orchestrator.claim(1).catch((error) => error.message);
        assert.equal(claim.issue, 1, `Expected one Review reservation for ${name}: ${claim}`);
        assert.equal(f.item.status, f.config.statuses.inProgress);
      } else {
        await assert.rejects(() => f.orchestrator.claim(1), undefined, name);
        assert.equal(f.item.status, f.config.statuses.ready);
        assert.ok(
          !f.requests.slice(before).some(({ method }) => ["POST", "PATCH", "PUT"].includes(method)),
          "A full Project must reject before recording claim intent or moving the Project item",
        );
      }
      assert.equal(item.status, f.config.statuses.review);
    }
  }
});

test("an unreadable or draft Project story reserves one slot", async () => {
  for (const content of [null, { __typename: "DraftIssue", title: "Draft awaiting review" }]) {
    for (const busyCount of [3, 4]) {
      const f = fixture();
      await f.orchestrator.ready(1, f.assessment());
      addInProgressStories(f, busyCount);
      f.project.items.push({ id: "review-story", status: f.config.statuses.review, content });
      if (busyCount === 3) {
        const claim = await f.orchestrator.claim(1).catch((error) => error.message);
        assert.equal(claim.issue, 1, `Expected an unverified story to occupy one slot: ${claim}`);
      } else {
        await assert.rejects(() => f.orchestrator.claim(1));
        assert.equal(f.item.status, f.config.statuses.ready);
      }
    }
  }
});

test("a fresh push invalidates earlier approval and the next claim reads the new verdict", async () => {
  const f = fixture();
  await f.orchestrator.ready(1, f.assessment());
  addInProgressStories(f, 4);
  const newHead = "b".repeat(40);
  const { evidence, item } = addReviewStory(f, {
    currentHead: newHead,
    reviews: [reviewDecision("APPROVED", 1)],
  });
  await assert.rejects(() => f.orchestrator.claim(1));
  assert.equal(f.item.status, f.config.statuses.ready);
  evidence.reviews.push(reviewDecision("APPROVED", 1, { id: 2, commit: newHead }));
  const claim = await f.orchestrator.claim(1).catch((error) => error.message);
  assert.equal(claim.issue, 1, `Expected claim to see approval on the new head: ${claim}`);
  assert.equal(item.status, f.config.statuses.review);
});

test("the latest decisive review from each reviewer takes effect at the current head", async () => {
  const f = fixture();
  await f.orchestrator.ready(1, f.assessment());
  addInProgressStories(f, 4);
  addReviewStory(f, {
    reviews: [
      reviewDecision("CHANGES_REQUESTED", 1),
      reviewDecision("APPROVED", 1, { id: 2 }),
      reviewDecision("COMMENTED", 1, { id: 3 }),
      reviewDecision("DISMISSED", 2, { id: 4 }),
      reviewDecision("CHANGES_REQUESTED", 3, { id: 5, commit: "b".repeat(40) }),
    ],
  });
  const claim = await f.orchestrator.claim(1).catch((error) => error.message);
  assert.equal(claim.issue, 1, `Expected current effective approval to free capacity: ${claim}`);
});

test("claim counts one Review story once at the five-story boundary", async () => {
  const f = fixture();
  await f.orchestrator.ready(1, f.assessment());
  addInProgressStories(f, 3);
  const { item } = addReviewStory(f);
  f.project.items.push({ ...item, id: "duplicate-review-story" });
  const claim = await f.orchestrator.claim(1).catch((error) => error.message);
  assert.equal(claim.issue, 1, `Expected one reservation for the duplicate story: ${claim}`);
  assert.equal(item.status, f.config.statuses.review);
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

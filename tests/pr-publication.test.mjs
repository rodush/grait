import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { issueDigest } from "../scripts/lib/policy.mjs";
import { createHandoff } from "../scripts/lib/tdd.mjs";
import { setupFixture } from "./helpers/setup-fixture.mjs";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" });
const apps = Object.fromEntries(
  ["writer", "reviewer"].map((role) => [
    role,
    {
      name: `grait-${role}`,
      slug: `grait-${role}`,
      id: role === "writer" ? 100 : 200,
      botUserId: role === "writer" ? 10001 : 20001,
      clientId: `Iv1.${role}`,
      pem,
      phase: "installed",
      installed: true,
    },
  ]),
);
const variables = [
  { name: "AUTOMATION_ENABLED", value: "true" },
  { name: "PROJECT_ID", value: "project-node" },
  { name: "PROJECT_NUMBER", value: "12" },
  { name: "PROJECT_OWNER", value: "acme" },
  { name: "AUTOMATION_LOGIN", value: "grait-writer[bot]" },
  { name: "REVIEW_LOGIN", value: "grait-reviewer[bot]" },
  { name: "AUTOMATION_APP_ID", value: "100" },
  { name: "AUTOMATION_BOT_USER_ID", value: "10001" },
  { name: "REVIEW_APP_ID", value: "200" },
  { name: "REVIEW_BOT_USER_ID", value: "20001" },
];

const requiredCheck = { name: "Delivery validation", appId: 7 };
const runLink = "https://github.com/acme/service/actions/runs/314";

async function fixture(t, { tdd = "green", exempt = false, runner } = {}) {
  const f = await setupFixture({
    configured: true,
    localEnabled: true,
    localApps: apps,
    variables,
  });
  t.after(() => f.close());
  const configuration = {
    ...f.config,
    ci: { requiredChecks: [requiredCheck] },
    ...(runner ? { tdd: { ...f.config.tdd, runner } } : {}),
  };
  await writeFile(join(f.directory, "workflow.config.json"), JSON.stringify(configuration));
  if (runner) {
    await mkdir(join(f.directory, "tests"));
    await writeFile(
      join(f.directory, "tests/unrelated.test.mjs"),
      'import test from "node:test"; import assert from "node:assert/strict"; test("unrelated test", () => assert.fail("local runner should omit this"));',
    );
    await writeFile(join(f.directory, "src/outcome.txt"), "original");
    await writeFile(join(f.directory, "src/regression.txt"), "original");
    await writeFile(
      join(f.directory, "tests/affected.test.mjs"),
      'import test from "node:test"; import assert from "node:assert/strict"; test("existing behavior", () => assert.ok(true));',
    );
  }
  f.git(["add", "."]);
  f.git(["commit", "--allow-empty", "-m", "test: configure delivery fixture"]);
  f.git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  f.git(["switch", "-c", "agent/issue-1"]);
  const head = f.git(["rev-parse", "HEAD"]);
  const issue = {
    number: 1,
    node_id: "issue-1",
    title: "Deliver validated outcome",
    body: "Accepted behavior",
    state: "open",
    user: { login: "operator", id: 42, type: "User" },
    labels: [],
  };
  const digest = issueDigest(issue);
  const recorded = {
    version: 1,
    number: 1,
    triagedDigest: digest,
    triage: {
      ready: true,
      blockers: [],
      tdd: {
        required: !exempt,
        reason: exempt ? "Documentation-only change" : null,
      },
    },
    claim: { issue: 1, branch: "agent/issue-1", digest },
  };
  if (runner) {
    recorded.tdd = createHandoff({
      issue: 1,
      head,
      baseline: head,
      branch: "agent/issue-1",
      acceptanceDigest: digest,
    });
  } else if (tdd !== "missing")
    recorded.tdd = {
      phase: tdd === "implementation" ? "implementation" : "review",
      head: tdd === "stale" ? "b".repeat(40) : head,
    };
  await f.update({
    remoteHead: head,
    checkRuns: [
      {
        id: 314,
        name: requiredCheck.name,
        app: { id: requiredCheck.appId },
        head_sha: head,
        status: "in_progress",
        conclusion: null,
        details_url: runLink,
        output: { text: "PRIVATE_UNBOUNDED_CHECK_OUTPUT" },
      },
    ],
    issue,
    issueComments: [
      {
        id: 701,
        user: { login: "grait-writer[bot]", id: 10001, type: "Bot" },
        body: "<!-- workflow-state:v1 -->\n\n```json\n" + JSON.stringify(recorded) + "\n```",
      },
    ],
    projectItems: [
      {
        id: "project-issue-1",
        isArchived: false,
        fieldValueByName: { name: "In Progress" },
        content: {
          __typename: "Issue",
          number: 1,
          repository: { nameWithOwner: "acme/service" },
        },
      },
    ],
  });
  const injection = join(f.directory, ".git/publication-ref.mjs");
  await writeFile(
    injection,
    `import { readFileSync, writeFileSync } from 'node:fs';
const request = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const path = new URL(url).pathname.slice(1);
  const method = options.method || 'GET';
  if ([
    'repos/acme/service/git/ref/heads/agent/issue-1',
    'repos/acme/service/pulls/99',
    'repos/acme/service/issues/comments/701',
    'repos/acme/service/pulls/99/files',
    'repos/acme/service/pulls/99/reviews',
    'repos/acme/service/issues/99/comments',
    'repos/acme/service/issues/comments/799',
  ].includes(path) || path.startsWith('repos/acme/service/commits/') && path.endsWith('/check-runs')
  || path.startsWith('repos/acme/service/statuses/')
  || path === 'graphql' && options.body?.includes('updateProjectV2ItemFieldValue')) {
    const state = JSON.parse(readFileSync(process.env.GRAIT_SETUP_FIXTURE_STATE, 'utf8'));
    state.calls.push({ path, method });
    let response;
    if (path.includes('/git/ref/')) response = { object: { sha: state.remoteHead } };
    if (path.endsWith('/pulls/99')) {
      const published = state.pullRequests?.find(pull => pull.number === 99);
      response = {
        number: 99, state: 'open', draft: false, ...published,
        head: { ref: published?.head, sha: state.remoteHead, repo: { full_name: 'acme/service' } },
        base: { ref: 'main', repo: { full_name: 'acme/service' } },
      };
    }
    if (path.endsWith('/pulls/99/files')) response = [{ filename: 'src/outcome.txt' }];
    if (path.endsWith('/pulls/99/reviews')) {
      if (method === 'POST') {
        response = {
          commit_id: JSON.parse(options.body).commit_id,
          state: "APPROVED",
          user: { id: 20001 },
        };
        (state.publishedReviews ||= []).push(response);
      } else response = state.publishedReviews || [];
    }
    if (path.endsWith('/check-runs'))
      response = { total_count: state.checkRuns.length, check_runs: state.checkRuns };
    if (method === 'PATCH' && path.endsWith('/comments/701')) {
      response = state.issueComments[0];
      response.body = JSON.parse(options.body).body;
    }
    if (path.endsWith('/issues/99/comments')) {
      if (method === 'POST') {
        response = { id: 799, user: { id: 10001 }, body: JSON.parse(options.body).body };
        state.pullComments = [response];
      } else response = state.pullComments || [];
    }
    if (method === 'PATCH' && path.endsWith('/comments/799')) {
      response = state.pullComments[0];
      response.body = JSON.parse(options.body).body;
    }
    if (path.includes('/statuses/')) response = { state: JSON.parse(options.body).state };
    if (path === 'graphql') {
      state.projectItems[0].fieldValueByName.name = JSON.parse(options.body).variables.option;
      response = { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: 'project-issue-1' } } } };
    }
    writeFileSync(process.env.GRAIT_SETUP_FIXTURE_STATE, JSON.stringify(state));
    return Response.json(response);
  }
  return request(url, options);
};`,
  );
  const bodyPath = join(f.directory, ".git/pr-body.md");
  await writeFile(
    bodyPath,
    "Deliver the accepted behavior.\n\nValidation: all scoped checks passed.\n",
  );
  const run = (entry, args) =>
    f.run(entry, args, {
      env: {
        NODE_OPTIONS: `--import=${join(f.directory, "preload.mjs")} --import=${injection}`,
      },
    });
  const publish = (extra = []) =>
    run("github.mjs", [
      "pr",
      "--issue",
      "1",
      "--title",
      "fix: deliver validated behavior",
      "--body-file",
      bodyPath,
      ...extra,
    ]);
  return { ...f, head, run, publish };
}

function assertNoPullCreated(state) {
  assert.equal(state.pullRequests?.length || 0, 0);
  assert.ok(
    !state.calls.some(
      ({ path, method }) => path === "repos/acme/service/pulls" && method === "POST",
    ),
  );
}

test("publisher opens a normal issue-linked PR by default after accepted Green for the exact head", async (t) => {
  const f = await fixture(t);
  const result = await f.publish();
  assert.equal(result.status, 0);
  const state = await f.state();
  assert.equal(state.pullRequests.length, 1);
  assert.equal(state.pullRequests[0].draft, false);
  assert.match(state.pullRequests[0].body, /Closes #1/);
  assert.equal(state.pullRequests[0].user.login, "grait-writer[bot]");
  assert.equal(state.pullRequests[0].head, "agent/issue-1");
  assert.equal(state.pullRequests[0].base, "main");
  assert.match(result.output, /https:\/\/github.com\/acme\/service\/pull\/99/);
  assert.ok(!state.calls.some(({ path }) => path.endsWith("/check-runs")));
});

test("check lookup reports the exact PR head with compact names conclusions and run links", async (t) => {
  const f = await fixture(t);
  const pending = await f.run("github.mjs", ["checks", "--pr", "99"]);
  assert.equal(pending.status, 0, pending.output);
  const pendingReport = JSON.parse(pending.output);
  assert.equal(pendingReport.head, f.head);
  assert.equal(pendingReport.ready, false);
  assert.equal(
    pendingReport.checks.find(({ name }) => name === requiredCheck.name)?.status,
    "in_progress",
  );

  const state = await f.state();
  state.checkRuns[0].status = "completed";
  state.checkRuns[0].conclusion = "success";
  await f.update({ checkRuns: state.checkRuns });
  const successful = await f.run("github.mjs", ["checks", "--pr", "99"]);
  assert.equal(successful.status, 0, successful.output);
  const successfulReport = JSON.parse(successful.output);
  assert.equal(successfulReport.head, f.head);
  assert.equal(successfulReport.ready, true);
  const check = successfulReport.checks.find(({ name }) => name === requiredCheck.name);
  assert.equal(check?.conclusion, "success");
  assert.equal(check?.detailsUrl, runLink);
  assert.doesNotMatch(successful.output, /PRIVATE_UNBOUNDED_CHECK_OUTPUT/);
  const checked = await f.state();
  const lookups = checked.calls.filter(({ path }) => path.endsWith("/check-runs"));
  assert.ok(lookups.length >= 2);
  assert.ok(
    lookups.every(({ path }) => path === `repos/acme/service/commits/${f.head}/check-runs`),
  );
  assert.ok(!checked.calls.some(({ path }) => path.endsWith("/logs")));
});

async function publishValidatedCandidate(t) {
  const f = await fixture(t, {
    runner: { command: [process.execPath, "{nodeAdapter}", "{testFiles}"] },
  });
  await writeFile(
    join(f.directory, "tests/new behavior.test.mjs"),
    'import test from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; test("new accepted behavior", () => assert.equal(readFileSync("src/outcome.txt", "utf8"), "accepted"));',
  );
  await writeFile(
    join(f.directory, "tests/affected.test.mjs"),
    'import test from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; test("existing behavior", () => assert.ok(true)); test("changed accepted behavior", () => assert.equal(readFileSync("src/outcome.txt", "utf8"), "accepted"));',
  );
  f.git(["add", "tests"]);
  f.git(["commit", "-m", "test: define accepted behavior"]);
  const redHead = f.git(["rev-parse", "HEAD"]);
  const expected = [
    "tests/new behavior.test.mjs::new accepted behavior",
    "tests/affected.test.mjs::changed accepted behavior",
  ];
  const expectedPath = join(f.directory, ".git/expected.json");
  await writeFile(expectedPath, JSON.stringify(expected));
  const red = await f.run("orchestrator.mjs", [
    "verify",
    "--issue",
    "1",
    "--phase",
    "red",
    "--expected",
    expectedPath,
  ]);
  assert.equal(red.status, 0, red.output);
  const redState = JSON.parse(red.output);
  assert.equal(redState.head, redHead);
  assert.equal(redState.owner, "implementer");
  assert.deepEqual(redState.report.failed.map(({ id }) => id).sort(), [...expected].sort());

  await writeFile(join(f.directory, "src/outcome.txt"), "accepted");
  f.git(["add", "src/outcome.txt"]);
  f.git(["commit", "-m", "fix: deliver accepted behavior"]);
  const greenHead = f.git(["rev-parse", "HEAD"]);
  const green = await f.run("orchestrator.mjs", ["verify", "--issue", "1", "--phase", "green"]);
  assert.equal(green.status, 0, green.output);
  const greenState = JSON.parse(green.output);
  assert.equal(greenState.head, greenHead);
  assert.equal(greenState.report.baseline, redHead);
  assert.equal(greenState.phase, "review");
  assert.deepEqual(
    greenState.report.passed.sort(),
    [...expected, "tests/affected.test.mjs::existing behavior"].sort(),
  );

  const push = await f.run("github.mjs", ["push", "--issue", "1"]);
  assert.equal(push.status, 0, push.output);
  await f.update({ remoteHead: greenHead });
  const opened = await f.publish();
  assert.equal(opened.status, 0, opened.output);
  const published = (await f.state()).pullRequests[0];
  assert.equal(published.draft, false);
  assert.match(published.body, /Closes #1/);
  return { f, greenHead };
}

test("claimed issue verifies only changed acceptance files through Red and Green before publication", async (t) => {
  await publishValidatedCandidate(t);
});

test("a failed required CI check authorizes a tester-first correction and fresh Green before review", async (t) => {
  const { f, greenHead } = await publishValidatedCandidate(t);
  const sync = await f.run("orchestrator.mjs", ["sync", "--pr", "99"]);
  assert.equal(sync.status, 0, sync.output);
  assert.equal(JSON.parse(sync.output).status, f.config.statuses.review);
  const original = (await f.state()).checkRuns[0];
  const failure = { ...original, head_sha: greenHead, status: "completed", conclusion: "failure" };
  const next = () => f.run("orchestrator.mjs", ["next", "--issue", "1", "--pr", "99", "--ci"]);
  const reviewPath = join(f.directory, ".git/review.json");
  async function review(prHead) {
    await writeFile(
      reviewPath,
      JSON.stringify({
        version: 1,
        pr: 99,
        head: prHead,
        round: 1,
        verdict: "APPROVE",
        blockers: [],
        rethink: false,
        conflicts: false,
      }),
    );
    return f.run("orchestrator.mjs", ["review", "--pr", "99", "--file", reviewPath]);
  }

  for (const runs of [
    [],
    [{ ...failure, head_sha: f.head }],
    [{ ...failure, app: { id: requiredCheck.appId + 1 } }],
    [{ ...failure, status: "in_progress", conclusion: null }],
    [{ ...failure, conclusion: "success" }],
    [{ ...failure, conclusion: "skipped" }],
  ]) {
    await f.update({ checkRuns: runs });
    assert.notEqual(
      (await next()).status,
      0,
      "Only a failure of a required check authorizes correction",
    );
  }

  await f.update({ checkRuns: [failure] });
  const blocked = await review(greenHead);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.output, /required CI checks/i);
  assert.equal((await f.state()).publishedReviews?.length ?? 0, 0);

  const started = await next();
  assert.equal(started.status, 0, started.output);
  const cycle = JSON.parse(started.output);
  assert.equal(cycle.owner, "tester");
  assert.equal(cycle.baseline, greenHead);
  assert.equal(cycle.head, greenHead);
  assert.equal(cycle.cycle, 2);
  assert.equal((await f.state()).projectItems[0].fieldValueByName.name, f.config.statuses.review);
  assert.notEqual((await next()).status, 0, "An active correction cycle cannot be restarted");

  await writeFile(
    join(f.directory, "tests/regression.test.mjs"),
    'import test from "node:test"; import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; test("full CI regression", () => assert.equal(readFileSync("src/regression.txt", "utf8"), "corrected"));',
  );
  f.git(["add", "tests"]);
  f.git(["commit", "-m", "test: reproduce CI regression"]);
  const redHead = f.git(["rev-parse", "HEAD"]);
  const expected = ["tests/regression.test.mjs::full CI regression"];
  const expectedPath = join(f.directory, ".git/ci-expected.json");
  await writeFile(expectedPath, JSON.stringify(expected));
  const red = await f.run("orchestrator.mjs", [
    "verify",
    "--issue",
    "1",
    "--phase",
    "red",
    "--expected",
    expectedPath,
  ]);
  assert.equal(red.status, 0, red.output);
  assert.equal(JSON.parse(red.output).owner, "implementer");
  await writeFile(join(f.directory, "src/regression.txt"), "corrected");
  f.git(["add", "src/regression.txt"]);
  f.git(["commit", "-m", "fix: correct CI regression"]);
  const corrected = f.git(["rev-parse", "HEAD"]);
  await f.update({
    remoteHead: corrected,
    checkRuns: [{ ...failure, id: failure.id + 1, head_sha: corrected, conclusion: "success" }],
  });
  const unverified = await review(corrected);
  assert.notEqual(unverified.status, 0);
  assert.match(unverified.output, /current-head Green/i);
  const green = await f.run("orchestrator.mjs", ["verify", "--issue", "1", "--phase", "green"]);
  assert.equal(green.status, 0, green.output);
  const result = JSON.parse(green.output);
  assert.equal(result.head, corrected);
  assert.equal(result.report.baseline, redHead);
  assert.deepEqual(result.report.passed, expected);
  const approved = await review(corrected);
  assert.equal(approved.status, 0, approved.output);
  assert.equal((await f.state()).publishedReviews[0].commit_id, corrected);
});

test("a distinct same-head branch success leaves a required PR merge failure ineligible for review", async (t) => {
  const f = await fixture(t);
  const original = (await f.state()).checkRuns[0];
  await f.update({
    checkRuns: [
      { ...original, status: "completed", conclusion: "failure" },
      {
        ...original,
        id: original.id + 1,
        name: "Branch validation",
        status: "completed",
        conclusion: "success",
      },
    ],
  });
  const lookup = await f.run("github.mjs", ["checks", "--pr", "99"]);
  assert.equal(lookup.status, 0, lookup.output);
  const checks = JSON.parse(lookup.output);
  assert.equal(checks.head, f.head);
  assert.equal(checks.ready, false);
  assert.equal(
    checks.required.find(({ name }) => name === requiredCheck.name)?.conclusion,
    "failure",
  );
});

test("publisher opens a normal PR for an accepted TDD exemption without Green evidence", async (t) => {
  const f = await fixture(t, { tdd: "missing", exempt: true });
  const result = await f.publish();
  assert.equal(result.status, 0);
  assert.equal((await f.state()).pullRequests[0].draft, false);
});

test("publisher permits an explicit draft for requested work in progress before Green", async (t) => {
  const f = await fixture(t, { tdd: "implementation" });
  const result = await f.publish(["--draft"]);
  assert.equal(result.status, 0);
  assert.equal((await f.state()).pullRequests[0].draft, true);
});

test("publisher rejects normal PR creation without current-head accepted Green", async (t) => {
  for (const tdd of ["missing", "implementation", "stale"]) {
    const f = await fixture(t, { tdd });
    const result = await f.publish();
    assert.notEqual(result.status, 0);
    assertNoPullCreated(await f.state());
  }
});

test("publisher rejects a remote head mismatch for normal and explicit draft PRs", async (t) => {
  for (const extra of [[], ["--draft"]]) {
    const f = await fixture(t);
    await f.update({ remoteHead: "c".repeat(40) });
    const result = await f.publish(extra);
    assert.notEqual(result.status, 0);
    assertNoPullCreated(await f.state());
  }
});

test("publisher still rejects dirty claimed branches before opening a PR", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.directory, "unrelated-user-work.txt"), "Preserve this work\n");
  const result = await f.publish();
  assert.notEqual(result.status, 0);
  assertNoPullCreated(await f.state());
});

test("publisher still rejects a checkout outside the claimed branch", async (t) => {
  const f = await fixture(t);
  f.git(["switch", "main"]);
  const result = await f.publish();
  assert.notEqual(result.status, 0);
  assertNoPullCreated(await f.state());
});

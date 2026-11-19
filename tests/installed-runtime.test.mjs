import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setupFixture } from "./helpers/setup-fixture.mjs";
import { issueDigest } from "../scripts/lib/policy.mjs";

const sourceRoot =
  process.env.GRAIT_TEST_SOURCE_ROOT || fileURLToPath(new URL("..", import.meta.url));
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const apps = Object.fromEntries(
  ["writer", "reviewer"].map((role) => [
    role,
    {
      name: `grait-${role}`,
      slug: `grait-${role}`,
      id: role === "writer" ? 100 : 200,
      clientId: `Iv1.${role}`,
      pem: privateKey.export({ type: "pkcs8", format: "pem" }),
      installed: true,
    },
  ]),
);
const variables = [
  { name: "AUTOMATION_ENABLED", value: "true" },
  { name: "PROJECT_ID", value: "project-node" },
  { name: "AUTOMATION_LOGIN", value: "grait-writer[bot]" },
  { name: "REVIEW_LOGIN", value: "grait-reviewer[bot]" },
];
const issue = {
  number: 1,
  node_id: "issue-1",
  title: "Deliver installed workflow",
  body: "Accepted public behavior",
  state: "open",
  user: { login: "operator" },
  labels: [],
};
const stateComment = (state, number = 1) => ({
  id: number === 1 ? 701 : 799,
  user: { login: "grait-writer[bot]" },
  body: `<!-- workflow-state:v1 -->\n\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\``,
});

async function installation(t) {
  const directory = await mkdtemp(join(tmpdir(), "grait-runtime-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(join(sourceRoot, "dist"), join(directory, "dist"), { recursive: true });
  await cp(join(sourceRoot, "package.json"), join(directory, "package.json"));
  return { directory, cli: join(directory, "dist/cli.mjs") };
}

async function fixture(t, { active = true, claimed = true, headState = "current" } = {}) {
  const installed = await installation(t);
  const f = await setupFixture({
    configured: true,
    localEnabled: active,
    localApps: apps,
    variables,
  });
  t.after(() => f.close());
  // The adopting application contains no GRAIT implementation or npm tooling.
  for (const path of [
    "scripts",
    "automation",
    "config",
    "node_modules",
    "package.json",
    "package-lock.json",
    ".npmrc",
    ".agents",
    ".claude",
    ".codex",
    ".github/agents",
    ".github/skills",
  ])
    await rm(join(f.directory, path), { recursive: true, force: true });
  await mkdir(join(f.directory, "app/nested"), { recursive: true });
  await writeFile(join(f.directory, "app/build.gradle.kts"), "// Existing Kotlin application\n");
  f.git(["add", "--all"]);
  f.git(["commit", "--quiet", "-m", "test: retain only adopting application artifacts"]);
  f.git(["switch", "-c", "agent/issue-1"]);
  const head = f.git(["rev-parse", "HEAD"]);
  const digest = issueDigest(issue);
  const record = {
    version: 1,
    number: 1,
    triagedDigest: digest,
    triage: { ready: true, blockers: [], tdd: { required: true } },
    ...(claimed
      ? {
          claim: { issue: 1, branch: "agent/issue-1", digest },
          tdd: { phase: "review", head: headState === "stale" ? "b".repeat(40) : head },
        }
      : {}),
  };
  await f.update({
    issue,
    remoteHead: head,
    issueComments: [stateComment(record)],
    prComments: [],
    projectItems: [
      {
        id: "project-issue-1",
        isArchived: false,
        fieldValueByName: { name: claimed ? "In Progress" : "Ready" },
        content: {
          __typename: "Issue",
          number: 1,
          title: issue.title,
          repository: { nameWithOwner: "acme/service" },
        },
      },
    ],
  });
  const injection = join(f.directory, ".git/runtime-service.mjs");
  await writeFile(injection, serviceExtension);
  const cliEntry = relative(join(f.directory, "scripts"), installed.cli);
  const run = (args) =>
    f.run(cliEntry, ["--cwd", join(f.directory, "app/nested"), ...args], {
      env: {
        NODE_OPTIONS: `--import=${join(f.directory, "preload.mjs")} --import=${injection}`,
      },
    });
  return { ...f, installed, head, record, run };
}

const serviceExtension = `
import { readFileSync, writeFileSync } from "node:fs";
const original = globalThis.fetch;
globalThis.fetch = async (url, options = {}) => {
  const parsed = new URL(url);
  if (parsed.hostname !== "api.github.com") throw new Error("Live network disabled");
  const path = parsed.pathname.slice(1), method = options.method || "GET";
  const state = JSON.parse(readFileSync(process.env.GRAIT_SETUP_FIXTURE_STATE, "utf8"));
  const identity = options.headers?.Authorization?.includes("synthetic-reviewer-installation") ? "reviewer" : options.headers?.Authorization?.includes("synthetic-writer-installation") ? "writer" : "human";
  const body = options.body ? JSON.parse(options.body) : undefined;
  let value;
  if (method === "GET" && path === "repos/acme/service/git/ref/heads/agent/issue-1") value = { object: { sha: state.remoteHead } };
  else if (method === "PATCH" && /^repos\\/acme\\/service\\/issues\\/comments\\/(701|799)$/.test(path)) {
    const comments = path.endsWith("701") ? state.issueComments : state.prComments;
    value = comments.find(comment => comment.id === Number(path.split("/").at(-1)));
    Object.assign(value, body);
  } else if (method === "GET" && path === "repos/acme/service/issues/99/comments") value = state.prComments;
  else if (method === "POST" && path === "repos/acme/service/issues/99/comments") {
    value = { id: 799, user: { login: "grait-writer[bot]" }, ...body }; state.prComments.push(value);
  } else if (method === "GET" && path === "repos/acme/service/pulls/99") value = { number: 99, state: "open", draft: false, changed_files: 1, body: "Closes #1", user: { login: "grait-writer[bot]" }, labels: [], head: { sha: state.remoteHead } };
  else if (method === "GET" && path === "repos/acme/service/pulls/99/files") value = [{ filename: "src/outcome.txt", status: "added", patch: "@@ -0,0 +1 @@\\n+Outcome" }];
  else if (method === "POST" && path === "repos/acme/service/pulls/99/reviews") {
    value = { id: 801, user: { login: identity === "reviewer" ? "grait-reviewer[bot]" : "wrong-identity" }, commit_id: body.commit_id, state: { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" }[body.event], body: body.body };
    state.publishedReviews = [...(state.publishedReviews || []), value];
  } else if (method === "POST" && path.startsWith("repos/acme/service/statuses/")) value = {};
  else return original(url, options);
  state.calls.push({ path, method, body, identity, query: parsed.search });
  writeFileSync(process.env.GRAIT_SETUP_FIXTURE_STATE, JSON.stringify(state));
  return Response.json(value);
};
`;

test("installed runtime dispatches both command help pages from an application subdirectory", async (t) => {
  const f = await fixture(t);
  for (const command of ["orchestrator", "github"]) {
    const result = await f.run([command, "--help"]);
    assert.equal(
      result.status,
      0,
      "Installed command help must work without target implementation files",
    );
    assert.match(result.output, command === "orchestrator" ? /claim.*--issue/s : /push.*--issue/s);
  }
  for (const path of ["scripts", "package.json", "node_modules"])
    assert.equal(existsSync(join(f.directory, path)), false);
});

test("installed orchestrator loads target configuration and Project status through fake services", async (t) => {
  const f = await fixture(t);
  const result = await f.run(["orchestrator", "status"]);
  assert.equal(result.status, 0, "Installed status must discover the application repository root");
  const items = JSON.parse(result.output.trim());
  assert.equal(items[0].issue, 1);
  assert.equal(items[0].status, "In Progress");
  const calls = (await f.state()).calls;
  assert.ok(calls.some(({ path }) => path === "graphql"));
  assert.equal(
    calls.some(
      ({ method, path }) =>
        method !== "GET" && !["graphql"].includes(path) && !path.endsWith("/access_tokens"),
    ),
    false,
  );
});

test("installed orchestrator refuses an inactive target before remote work", async (t) => {
  const f = await fixture(t, { active: false });
  const result = await f.run(["orchestrator", "claim", "--issue", "1"]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /not activated|activat.*host|host.*activat/i);
  assert.equal((await f.state()).calls.length, 0);
});

test("installed orchestrator claims accepted Ready work using the writer identity", async (t) => {
  const f = await fixture(t, { claimed: false });
  const result = await f.run(["orchestrator", "claim", "--issue", "1"]);
  assert.equal(
    result.status,
    0,
    "Installed claim must preserve existing readiness and ledger policy",
  );
  assert.equal(JSON.parse(result.output.trim()).branch, "agent/issue-1");
  const state = await f.state();
  assert.ok(
    state.calls.some(
      ({ path, method, identity }) =>
        path === "repos/acme/service/issues/comments/701" &&
        method === "PATCH" &&
        identity === "writer",
    ),
  );
  assert.ok(
    state.calls.some(
      ({ path, body }) =>
        path === "graphql" && body.query.includes("updateProjectV2ItemFieldValue"),
    ),
  );
  assert.match(state.issueComments[0].body, /"claim"/);
  assert.doesNotMatch(state.issueComments[0].body, /"pendingClaim"/);
});

test("installed publisher and reviewer preserve exact-head evidence and independent identities", async (t) => {
  const f = await fixture(t);
  const body = join(f.directory, ".git/pr-body.md");
  await writeFile(body, "Deliver accepted behavior. Validation passed.\n");
  const result = await f.run([
    "github",
    "pr",
    "--issue",
    "1",
    "--title",
    "feat: deliver accepted behavior",
    "--body-file",
    body,
  ]);
  assert.equal(result.status, 0, "Installed publisher must open an issue-linked ready PR");
  assert.equal((await f.state()).pullRequests[0].draft, false);
  const payload = join(f.directory, ".git/review.json");
  await writeFile(
    payload,
    JSON.stringify({
      version: 1,
      pr: 99,
      head: f.head,
      round: 1,
      verdict: "APPROVE",
      blockers: [],
      rethink: false,
      conflicts: false,
      body: "Accepted behavior verified at the exact head.",
      comments: [],
    }),
  );
  const review = await f.run(["orchestrator", "review", "--pr", "99", "--file", payload]);
  assert.equal(review.status, 0, "Installed reviewer must publish through its separate App");
  const state = await f.state();
  assert.equal(state.pullRequests[0].user.login, "grait-writer[bot]");
  assert.equal(state.publishedReviews[0].user.login, "grait-reviewer[bot]");
  assert.equal(state.publishedReviews[0].commit_id, f.head);
  assert.ok(
    state.calls.some(
      ({ path, method, identity, body }) =>
        path.endsWith(`/statuses/${f.head}`) &&
        method === "POST" &&
        identity === "writer" &&
        body.state === "success",
    ),
  );
  assert.equal(
    state.calls.some(({ path }) => /\/merge$|\/releases$/.test(path)),
    false,
  );
});

test("installed publisher rejects stale Green evidence before creating a PR", async (t) => {
  const f = await fixture(t, { headState: "stale" });
  const body = join(f.directory, ".git/pr-body.md");
  await writeFile(body, "Accepted behavior.\n");
  const result = await f.run([
    "github",
    "pr",
    "--issue",
    "1",
    "--title",
    "feat: deliver accepted behavior",
    "--body-file",
    body,
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Green.*exact|current.head.*Green|exact.*Green/i);
  assert.equal((await f.state()).pullRequests?.length || 0, 0);
});

test("installed verifier resolves its Node adapter from the package rather than the target", async (t) => {
  const installed = await installation(t);
  const modulePath = join(installed.directory, "dist/scripts/lib/verification.mjs");
  assert.ok(
    existsSync(modulePath),
    "The installed distribution must supply its verification runtime",
  );
  const { verifyCommits } = await import(pathToFileURL(modulePath));
  const f = await setupFixture();
  t.after(() => f.close());
  for (const path of ["scripts", "package.json", "package-lock.json", "node_modules"])
    await rm(join(f.directory, path), { recursive: true, force: true });
  await mkdir(join(f.directory, "tests"), { recursive: true });
  await writeFile(
    join(f.directory, "tests/outcome.test.mjs"),
    'import test from "node:test"; import assert from "node:assert/strict"; test("accepted outcome", () => assert.equal(1, 1));\n',
  );
  f.git(["add", "--all"]);
  f.git(["commit", "--quiet", "-m", "test: passing application baseline"]);
  const baseline = f.git(["rev-parse", "HEAD"]);
  await writeFile(
    join(f.directory, "tests/outcome.test.mjs"),
    'import test from "node:test"; import assert from "node:assert/strict"; test("accepted outcome", () => assert.equal(1, 2));\n',
  );
  f.git(["add", "--all"]);
  f.git(["commit", "--quiet", "-m", "test: failing application candidate"]);
  const head = f.git(["rev-parse", "HEAD"]);
  const report = await verifyCommits({
    root: f.directory,
    baseline,
    head,
    phase: "red",
    expectedFailures: ["tests/outcome.test.mjs::accepted outcome"],
    issue: 1,
    acceptanceDigest: "a".repeat(64),
    runner: { install: [], command: [process.execPath, "{nodeAdapter}", "tests/*.test.mjs"] },
  });
  assert.deepEqual(report.failed, [
    { id: "tests/outcome.test.mjs::accepted outcome", kind: "assertion" },
  ]);
  assert.deepEqual(report.infrastructureErrors, []);
  assert.equal(existsSync(join(f.directory, "scripts")), false);
});

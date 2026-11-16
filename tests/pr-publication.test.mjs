import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { issueDigest } from "../scripts/lib/policy.mjs";
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
];

async function fixture(t, { tdd = "green", exempt = false } = {}) {
  const f = await setupFixture({
    configured: true,
    localEnabled: true,
    localApps: apps,
    variables,
  });
  t.after(() => f.close());
  f.git(["switch", "-c", "agent/issue-1"]);
  const head = f.git(["rev-parse", "HEAD"]);
  const issue = {
    number: 1,
    node_id: "issue-1",
    title: "Deliver validated outcome",
    body: "Accepted behavior",
    state: "open",
    user: { login: "operator" },
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
      tdd: { required: !exempt, reason: exempt ? "Documentation-only change" : null },
    },
    claim: { issue: 1, branch: "agent/issue-1", digest },
  };
  if (tdd !== "missing")
    recorded.tdd = {
      phase: tdd === "implementation" ? "implementation" : "review",
      head: tdd === "stale" ? "b".repeat(40) : head,
    };
  await f.update({
    remoteHead: head,
    issue,
    issueComments: [
      {
        id: 701,
        user: { login: "grait-writer[bot]" },
        body: "<!-- workflow-state:v1 -->\n\n```json\n" + JSON.stringify(recorded) + "\n```",
      },
    ],
    projectItems: [
      {
        id: "project-issue-1",
        isArchived: false,
        fieldValueByName: { name: "In Progress" },
        content: { __typename: "Issue", number: 1, repository: { nameWithOwner: "acme/service" } },
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
  if (path === 'repos/acme/service/git/ref/heads/agent/issue-1') {
    const state = JSON.parse(readFileSync(process.env.GRAIT_SETUP_FIXTURE_STATE, 'utf8'));
    state.calls.push({ path, method: options.method || 'GET', identity: 'writer' });
    writeFileSync(process.env.GRAIT_SETUP_FIXTURE_STATE, JSON.stringify(state));
    return Response.json({ object: { sha: state.remoteHead } });
  }
  return request(url, options);
};`,
  );
  const bodyPath = join(f.directory, ".git/pr-body.md");
  await writeFile(
    bodyPath,
    "Deliver the accepted behavior.\n\nValidation: all scoped checks passed.\n",
  );
  return {
    ...f,
    head,
    publish: (extra = []) =>
      f.run(
        "github.mjs",
        [
          "pr",
          "--issue",
          "1",
          "--title",
          "fix: deliver validated behavior",
          "--body-file",
          bodyPath,
          ...extra,
        ],
        {
          env: {
            NODE_OPTIONS: `--import=${join(f.directory, "preload.mjs")} --import=${injection}`,
          },
        },
      ),
  };
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

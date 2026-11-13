import test from "node:test";
import assert from "node:assert/strict";
import { GitHub } from "../scripts/lib/github.mjs";
import { Ledger, STATE_MARKER } from "../scripts/lib/ledger.mjs";
import { Project } from "../scripts/lib/project.mjs";

test("REST pagination reads beyond the first hundred results", async () => {
  const pages = [];
  const api = new GitHub("secret", {
    fetcher: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      pages.push(page);
      return Response.json(page === 1 ? Array.from({ length: 100 }, (_, i) => i) : [100, 101]);
    },
  });
  assert.equal((await api.list("repos/a/b/issues")).length, 102);
  assert.deepEqual(pages, [1, 2]);
});

test("failed API requests do not log credentials or response bodies", async () => {
  const api = new GitHub("private-token", {
    fetcher: async () => new Response("sensitive response", { status: 403 }),
  });
  await assert.rejects(
    () => api.request("repos/a/b/issues"),
    (error) =>
      error.status === 403 &&
      !error.message.includes("private-token") &&
      !error.message.includes("sensitive response"),
  );
});

test("GraphQL partial responses fail closed", async () => {
  const api = new GitHub("token", {
    fetcher: async () =>
      Response.json({ data: { node: null }, errors: [{ message: "Not accessible" }] }),
  });
  await assert.rejects(() => api.graphql("query {}"), /incomplete/);
});

test("untrusted comments cannot impersonate the controller's ledger", async () => {
  const state = { version: 1, number: 1, paused: true };
  const api = {
    list: async () => [
      {
        user: { login: "contributor" },
        body: `${STATE_MARKER}\n\n\`\`\`json\n${JSON.stringify(state)}\n\`\`\``,
      },
    ],
  };
  const ledger = new Ledger(api, "org/repo", "controller[bot]");
  assert.equal((await ledger.load(1)).state.paused, undefined);
});

test("duplicate trusted ledgers require human reconciliation", async () => {
  const comment = { user: { login: "controller[bot]" }, body: STATE_MARKER };
  const ledger = new Ledger(
    { list: async () => [comment, comment] },
    "org/repo",
    "controller[bot]",
  );
  await assert.rejects(() => ledger.load(1), /Multiple/);
});

test("project pagination includes stories beyond the first page", async () => {
  const calls = [];
  const api = {
    graphql: async (query, variables) => {
      calls.push(variables);
      if (query.includes("fields(first:"))
        return {
          node: {
            shortDescription: "[agent-controller:org/repo]",
            fields: {
              nodes: [
                {
                  id: "status",
                  name: "Status",
                  options: ["Backlog", "Ready", "In Progress", "Review", "Done"].map((name) => ({
                    id: name,
                    name,
                  })),
                },
              ],
            },
          },
        };
      return {
        node: {
          items: {
            pageInfo: { hasNextPage: !variables.cursor, endCursor: "next" },
            nodes: variables.cursor
              ? [
                  {
                    id: "last",
                    fieldValueByName: { name: "In Progress" },
                    content: {
                      __typename: "Issue",
                      number: 101,
                      repository: { nameWithOwner: "org/repo" },
                    },
                  },
                ]
              : Array.from({ length: 100 }, (_, i) => ({ id: `item${i}`, content: null })),
          },
        },
      };
    },
  };
  const project = await new Project(api, "project", {
    backlog: "Backlog",
    ready: "Ready",
    inProgress: "In Progress",
    review: "Review",
    done: "Done",
  }).load();
  assert.equal(project.items.length, 101);
  assert.equal(project.find("org/repo", 101).status, "In Progress");
  assert.equal(project.controller, "org/repo");
  assert.equal(calls.at(-1).cursor, "next");
});

import test from "node:test";
import assert from "node:assert/strict";
import * as bootstrap from "../scripts/lib/bootstrap.mjs";

test("the CI publisher resolver uses the connected GitHub instance's Actions App identity", async () => {
  assert.equal(typeof bootstrap.resolveActionsAppId, "function");
  for (const id of [7, 98765, Number.MAX_SAFE_INTEGER]) {
    const paths = [];
    const api = {
      request: async (path) => {
        paths.push(path);
        return { slug: "github-actions", id };
      },
    };
    assert.equal(await bootstrap.resolveActionsAppId(api), id);
    assert.deepEqual(paths, ["apps/github-actions"]);
  }
});

test("the CI publisher resolver rejects missing or unrelated App identities", async () => {
  assert.equal(typeof bootstrap.resolveActionsAppId, "function");
  for (const response of [
    undefined,
    null,
    {},
    { id: 98765 },
    { slug: "untrusted-ci", id: 98765 },
    { slug: "GitHub-Actions", id: 98765 },
  ]) {
    await assert.rejects(() => bootstrap.resolveActionsAppId({ request: async () => response }));
  }
});

test("the CI publisher resolver requires a positive safe numeric App ID", async () => {
  assert.equal(typeof bootstrap.resolveActionsAppId, "function");
  for (const id of [
    undefined,
    null,
    "15368",
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    await assert.rejects(() =>
      bootstrap.resolveActionsAppId({
        request: async () => ({ slug: "github-actions", id }),
      }),
    );
  }
});

test("the CI publisher resolver propagates lookup failures without a fallback identity", async () => {
  assert.equal(typeof bootstrap.resolveActionsAppId, "function");
  const failure = Object.assign(new Error("GitHub App lookup denied"), { status: 403 });
  await assert.rejects(
    () =>
      bootstrap.resolveActionsAppId({
        request: async () => {
          throw failure;
        },
      }),
    (error) => error === failure,
  );
});

test("required CI checks bind the resolved publisher rather than a public GitHub numeric constant", () => {
  for (const id of [7, 98765]) {
    const gates = bootstrap.repositoryRules([{ id: 42 }], 1234, 4567, id)[0];
    const checks = gates.rules.find((rule) => rule.type === "required_status_checks").parameters
      .required_status_checks;
    assert.deepEqual(
      checks.find((check) => check.context === "Template validation"),
      {
        context: "Template validation",
        integration_id: id,
      },
    );
    assert.equal(checks.find((check) => check.context === "Agent review").integration_id, 1234);
    assert.deepEqual(gates.bypass_actors, []);
  }
});

test("ruleset generation refuses a missing or invalid CI publisher instead of creating an unbound gate", () => {
  for (const id of [
    undefined,
    null,
    "15368",
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(() => bootstrap.repositoryRules([{ id: 42 }], 1234, 4567, id));
  }
});

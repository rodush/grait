import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sanitizeObservation } from "../scripts/adapters/test-observation.mjs";
import reporter from "../scripts/adapters/node-test-reporter.mjs";

async function assertionReport(cause) {
  async function* events() {
    yield {
      type: "test:fail",
      data: {
        file: "/work/project/tests/behavior.mjs",
        name: "public contract",
        details: { error: { cause } },
      },
    };
  }
  let result = "";
  for await (const chunk of reporter(events())) result += chunk;
  return JSON.parse(result);
}

test("scalar public observations are bounded and source/path/non-scalar examples are withheld", () => {
  assert.equal(sanitizeObservation(undefined), undefined);
  assert.equal(sanitizeObservation(null), undefined);
  assert.deepEqual(sanitizeObservation({ operator: "strictEqual", expected: 2, observed: 1 }), {
    operator: "strictEqual",
    expected: 2,
    observed: 1,
  });
  assert.deepEqual(sanitizeObservation({ operator: "==", expected: true, observed: null }), {
    operator: "==",
    expected: true,
    observed: null,
  });
  for (const value of [{ private: "fixture" }, ["fixture"], () => {}, Symbol("fixture")])
    assert.match(sanitizeObservation({ expected: value, observed: 0 }).expected, /withheld/);
  for (const value of [
    "const secret = 'fixture'",
    "src/tests/private.spec.py",
    "at evaluator (/test.js:1:2)",
    "function privateTest() {}",
  ])
    assert.match(sanitizeObservation({ expected: value, observed: 0 }).expected, /withheld/);
  const bounded = sanitizeObservation({
    operator: "x\n".repeat(50),
    expected: "a\n\u0000".repeat(100),
    observed: Infinity,
  });
  assert.equal(bounded.operator, "assertion");
  assert.ok(bounded.expected.length <= 160);
  assert.ok(!/[\u0000-\u001f\u007f]/.test(bounded.expected));
  assert.match(bounded.observed, /non-finite/);
});

test("ordinary assertion values remain inside tester boundary unless explicitly marked public", async () => {
  const report = await assertionReport({
    code: "ERR_ASSERTION",
    operator: "strictEqual",
    expected: "private-fixture-input",
    actual: "private-fixture-output",
  });
  assert.equal(report.failed[0].kind, "assertion");
  assert.equal(report.failed[0].id, "tests/behavior.mjs::public contract");
  assert.equal(Object.hasOwn(report.failed[0].observation || {}, "expected"), false);
  assert.equal(Object.hasOwn(report.failed[0].observation || {}, "observed"), false);
  assert.ok(!JSON.stringify(report).includes("private-fixture"));
});

test("tester-authored publicObservation shares only sanitized public expected and observed behavior", async () => {
  const report = await assertionReport({
    code: "ERR_ASSERTION",
    operator: "strictEqual",
    expected: { secret: "internal" },
    actual: { secret: "internal" },
    publicObservation: { operator: "strictEqual", expected: 200, observed: 404 },
  });
  assert.deepEqual(report.failed[0].observation, {
    operator: "strictEqual",
    expected: 200,
    observed: 404,
  });
  assert.ok(!JSON.stringify(report).includes("secret"));
  const unsafe = await assertionReport({
    code: "ERR_ASSERTION",
    publicObservation: { expected: "const secret=1", observed: { private: "data" } },
  });
  assert.match(unsafe.failed[0].observation.expected, /withheld/);
  assert.match(unsafe.failed[0].observation.observed, /withheld/);
});

test("local role contracts preserve black-box test ownership", async () => {
  const implementer = await readFile(
    new URL("../automation/skills/grait-implement/SKILL.md", import.meta.url),
    "utf8",
  );
  const tester = await readFile(
    new URL("../automation/skills/grait-test/SKILL.md", import.meta.url),
    "utf8",
  );
  assert.match(implementer, /(?:do not|never) read test source/i);
  assert.match(implementer, /acceptance criteri/i);
  assert.match(tester, /never.*implementation|only.*test/i);
});

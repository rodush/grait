import test from "node:test";
import assert from "node:assert/strict";
import { canonicalizeActionComments } from "../scripts/lib/compilation.mjs";

const sha = "0123456789abcdef0123456789abcdef01234567";
const other = "abcdef0123456789abcdef0123456789abcdef01";

test("cache-derived duplicate SHA labels normalize consistently", () => {
  const reference = `        uses: owner/action@${sha}`;
  assert.equal(canonicalizeActionComments(`${reference} # ${sha}\n`), `${reference}\n`);
  assert.equal(
    canonicalizeActionComments(`#   - owner/action@${sha} # ${sha}\n`),
    `#   - owner/action@${sha}\n`,
  );
});

test("meaningful annotations, manifests, and script content remain unchanged", () => {
  for (const text of [
    `        uses: owner/action@${sha} # v1.2.3\n`,
    `        uses: owner/action@${sha} # ${other}\n`,
    `# gh-aw-manifest: {"sha":"${sha}"}\n`,
    `            uses: owner/action@${sha} # ${sha}\n`,
  ])
    assert.equal(canonicalizeActionComments(text), text);
});

test("changed action pins and workflow permissions still produce drift", () => {
  assert.notEqual(
    canonicalizeActionComments(`        uses: owner/action@${sha} # ${sha}`),
    canonicalizeActionComments(`        uses: owner/action@${other} # ${other}`),
  );
  assert.notEqual(
    canonicalizeActionComments("permissions:\n  contents: read\n"),
    canonicalizeActionComments("permissions:\n  contents: write\n"),
  );
});

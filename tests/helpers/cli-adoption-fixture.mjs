import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const sourceRoot =
  process.env.GRAIT_TEST_SOURCE_ROOT || fileURLToPath(new URL("../..", import.meta.url));
const runAsync = promisify(execFile);
const canonical = "https://github.com/rodush/grait.git";
const guidePath = "docs/project/cli-adoption-validation.md";

const commands = {
  "init preview":
    "init --plan --repo OWNER/REPOSITORY --revision GIT_PIN --harness codex --maintainers MAINTAINER --no-browser",
  "init apply":
    "init --yes --repo OWNER/REPOSITORY --revision GIT_PIN --harness codex --maintainers MAINTAINER --no-browser",
  activate: "activate",
  status: "orchestrator status",
  "upgrade preview": "upgrade --plan --revision UPGRADE_PIN",
  "upgrade apply": "upgrade --yes --revision UPGRADE_PIN",
  "migration preview": "migrate --plan --revision GIT_PIN --legacy-revision TEMPLATE_SHA",
  "migration apply": "migrate --yes --revision GIT_PIN --legacy-revision TEMPLATE_SHA",
};

function commandName(args) {
  const [command, subcommand] = args;
  if (command === "activate") return "activate";
  if (command === "orchestrator" && subcommand === "status") return "status";
  const operation = { init: "init", upgrade: "upgrade", migrate: "migration" }[command];
  if (operation && args.includes("--plan")) return operation + " preview";
  if (operation && args.includes("--yes")) return operation + " apply";
}

export async function adoptionGuide() {
  const guide = await readFile(join(sourceRoot, guidePath), "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (guide === null) return { examples: new Map(), versionedGuideExists: false };

  // Only the public CLI and its arguments are executed. Treat the rest of the
  // surrounding shell and Markdown as operator instructions, not test code.
  const examples = new Map();
  for (const [, block] of guide.matchAll(/^```(?:sh|bash)\s*\n([\s\S]*?)^```/gm)) {
    const joined = block.replace(/\\\n\s*/g, " ");
    for (const line of joined.split("\n")) {
      const match = /^grait\s+(.+)$/.exec(line.trim());
      if (!match) continue;
      const args = match[1]
        .split(/\s+/)
        .map((argument) => argument.replace(/^(['"])(.*)\1$/, "$2"));
      const name = commandName(args);
      if (name && !examples.has(name)) examples.set(name, args);
    }
  }
  return { examples, versionedGuideExists: true };
}

export function assertAdoptionExamples({ examples, versionedGuideExists }) {
  assert.ok(versionedGuideExists, "Publish a tested CLI adoption guide for operators");
  assert.deepEqual(
    [...examples.keys()].sort(),
    Object.keys(commands).sort(),
    "Provide runnable CLI examples for every documented lifecycle stage",
  );
}

export function adoptionArguments({ examples }, operation, values = {}) {
  return (examples.get(operation) ?? commands[operation].split(" ")).map(
    (argument) => values[argument] ?? argument,
  );
}

function execute(program, args, cwd, env) {
  const result = spawnSync(program, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 45_000,
  });
  if (result.error) throw result.error;
  return { status: result.status, output: result.stdout + result.stderr };
}

export const applicationStacks = {
  "shell application": {
    files: {
      "app/check.sh": "#!/bin/sh\ntest \"$(cat app/message.txt)\" = 'application ready'\n",
      "app/message.txt": "application ready\n",
    },
    command: ["sh", "app/check.sh"],
  },
  "npm application": {
    files: {
      "app/assert-app.mjs": "import assert from 'node:assert/strict';\nassert.equal(2 + 2, 4);\n",
      "package.json":
        JSON.stringify({
          name: "existing-app",
          version: "1.0.0",
          scripts: { test: "node app/assert-app.mjs" },
        }) + "\n",
      "package-lock.json":
        JSON.stringify({
          name: "existing-app",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: { "": { name: "existing-app", version: "1.0.0" } },
        }) + "\n",
    },
    command: ["npm", "test", "--silent"],
  },
};

export function applicationFiles(stack) {
  return {
    ...stack.files,
    ".github/workflows/application.yml": `name: Application
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
${stack.command[0] === "npm" ? "      - uses: actions/setup-node@v4\n        with:\n          node-version: 24\n" : ""}      - run: ${stack.command.join(" ")}
`,
  };
}

export async function assertApplicationWorks(target, stack, env) {
  for (const [path, contents] of Object.entries(applicationFiles(stack)))
    assert.equal(await readFile(join(target, path), "utf8"), contents);
  const [program, ...args] = stack.command;
  const result = execute(program, args, target, env);
  assert.equal(result.status, 0, result.output);
}

export async function gitPinnedDistribution(t) {
  const directory = await mkdtemp(join(tmpdir(), "grait-git-adoption-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, "source");
  const home = join(directory, "home");
  const runtime = join(directory, "runtime");
  for (const path of [repository, home, runtime]) await mkdir(path);
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_ALLOW_PROTOCOL: "file",
    npm_config_update_notifier: "false",
  };
  const git = (...args) => {
    const result = execute("git", args, repository, env);
    assert.equal(result.status, 0, result.output);
    return result.output.trim();
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "GRAIT Adoption Fixture");
  git("config", "user.email", "adoption@example.invalid");
  for (const path of ["package.json", "README.md", "LICENSE", "dist"])
    await cp(join(sourceRoot, path), join(repository, path), {
      recursive: true,
      dereference: true,
    });
  git("add", "--all");
  git("commit", "--quiet", "-m", "Initial prebuilt GRAIT distribution");
  const initial = git("rev-parse", "HEAD");
  git("commit", "--quiet", "--allow-empty", "-m", "Next reviewed GRAIT distribution");
  const next = git("rev-parse", "HEAD");
  for (const url of [
    canonical,
    "https://github.com/rodush/grait",
    "git@github.com:rodush/grait.git",
    "ssh://git@github.com/rodush/grait.git",
  ])
    git("config", "--global", "--add", `url.file://${repository}.insteadOf`, url);

  // npm tries the GitHub tarball first. Reply with a local 404 so npm
  // takes its normal Git fallback and Git's file-only transport resolves the pin.
  const proxy = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  proxy.on("connect", (_request, socket) =>
    socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"),
  );
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const proxyUrl = "http://127.0.0.1:" + proxy.address().port;

  const npmEnvironment = {
    ...env,
    npm_config_cache: join(directory, "npm-selected"),
    npm_config_https_proxy: proxyUrl,
    npm_config_proxy: proxyUrl,
    npm_config_fetch_retries: "0",
  };
  const install = async (pin) => {
    const cache = join(directory, "npm-" + pin);
    await runAsync(
      "npm",
      [
        "exec",
        "--yes",
        "--allow-git=root",
        "--ignore-scripts",
        "--cache",
        cache,
        `--package=git+${canonical}#${pin}`,
        "--",
        "grait",
        "--version",
      ],
      {
        cwd: runtime,
        timeout: 45_000,
        env: npmEnvironment,
      },
    );
    const [installed] = await readdir(join(cache, "_npx"));
    const prefix = join(cache, "_npx", installed);
    const lock = JSON.parse(await readFile(join(prefix, "package-lock.json"), "utf8"));
    const resolved = new URL(lock.packages["node_modules/grait"].resolved);
    assert.equal(resolved.host, "github.com");
    assert.equal(resolved.pathname, "/rodush/grait.git");
    assert.equal(resolved.hash, "#" + pin);
    const packageRoot = join(prefix, "node_modules/grait");
    return join(packageRoot, "dist/cli.mjs");
  };

  return {
    env,
    npmEnvironment,
    tag: (name, pin) => git("tag", "--force", name, pin),
    initial,
    next,
    install,
    includeLegacyTemplate: (legacyRepo, revision) =>
      git("fetch", "--quiet", legacyRepo, revision + ":refs/heads/legacy-template"),
  };
}

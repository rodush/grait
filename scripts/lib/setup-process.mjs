import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

export async function command(program, args = [], options = {}) {
  const {
    input,
    interactive = false,
    allowFailure = false,
    cwd = process.cwd(),
    env = process.env,
    timeoutMs = interactive ? 0 : 600000,
  } = options;
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      shell: false,
      stdio: interactive ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let exceeded = false;
    const collect = (chunk, channel) => {
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 8 * 1024 * 1024) {
        exceeded = true;
        child.kill("SIGKILL");
        return;
      }
      if (channel === "out") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout?.on("data", (chunk) => collect(chunk, "out"));
    child.stderr?.on("data", (chunk) => collect(chunk, "err"));
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error(`Unable to run ${program}; check that it is installed and accessible`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut || exceeded)
        reject(new Error(`${program} exceeded its execution or output limit`));
      else if (code !== 0 && !allowFailure)
        reject(
          new Error(
            `${program} command failed (exit ${code ?? "signal"}); resolve the reported setup step and rerun`,
          ),
        );
      else resolve({ stdout, stderr, code });
    });
    child.stdin?.on("error", () => {});
    if (!interactive) child.stdin?.end(input);
  });
}

export async function confirm(message, yes = false) {
  if (yes) return;
  if (!process.stdin.isTTY)
    throw new Error(
      "Interactive confirmation is required; inspect --plan and use --yes to authorize it explicitly",
    );
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`${message} [y/N] `);
    if (!/^y(?:es)?$/i.test(answer.trim()))
      throw new Error("Setup cancelled before applying this step");
  } finally {
    terminal.close();
  }
}

export function withoutCredentials(environment = process.env) {
  const result = { ...environment };
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "PROJECT_TOKEN",
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "COPILOT_GITHUB_TOKEN",
    "CODEX_ACCESS_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "AUTOMATION_TOKEN",
    "REVIEW_TOKEN",
    "AUTOMATION_APP_PRIVATE_KEY",
    "REVIEW_APP_PRIVATE_KEY",
    "RELEASE_APP_PRIVATE_KEY",
    "RELEASE_TOKEN",
  ])
    delete result[name];
  return result;
}

export async function requireSubscription(harness, { login = false } = {}) {
  if (!["codex", "claude"].includes(harness)) throw new Error("Choose Codex or Claude Code");
  const statusArgs = harness === "codex" ? ["login", "status"] : ["auth", "status"];
  let status = await command(harness, statusArgs, {
    allowFailure: true,
    env: withoutCredentials(),
  });
  if (status.code !== 0 && login) {
    await command(harness, harness === "codex" ? ["login"] : ["auth", "login"], {
      interactive: true,
      env: withoutCredentials(),
    });
    status = await command(harness, statusArgs, { allowFailure: true, env: withoutCredentials() });
  }
  let subscription = false;
  if (harness === "codex")
    subscription = /logged in using ChatGPT/i.test(status.stdout + status.stderr);
  else {
    try {
      const account = JSON.parse(status.stdout);
      subscription = account.loggedIn === true && account.authMethod === "claude.ai";
    } catch {
      /* Unknown status formats never authorize API billing. */
    }
  }
  if (status.code !== 0 || !subscription)
    throw new Error(
      "A native subscription login is required. Use codex login or claude auth login to sign in with your plan; API billing or an unrecognized login method is not accepted by this setup",
    );
}

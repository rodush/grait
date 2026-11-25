import { createInterface } from "node:readline";

function diagnostic(label, color, stream, message) {
  const styled = stream.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
  stream.write(
    "\n" + (styled ? "\x1b[" + color + "m" + label + "\x1b[0m" : label) + " " + message + "\n",
  );
}

export function setupWarning(message, stream = process.stdout) {
  diagnostic("WARNING", 33, stream, message);
}

export function setupError(message) {
  diagnostic("ERROR", 31, process.stderr, message);
}

export function interruptionError() {
  const error = new Error("Setup interrupted");
  error.code = "SETUP_INTERRUPTED";
  return error;
}

export async function setupQuestion(message, signal) {
  if (!process.stdin.isTTY) return null;
  signal?.throwIfAborted();
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const close = () => terminal.close();
  let interrupted = false;
  try {
    const answer = await new Promise((resolve) => {
      terminal.once("close", () => resolve(null));
      terminal.once("SIGINT", () => {
        interrupted = true;
        close();
      });
      signal?.addEventListener("abort", close, { once: true });
      terminal.question("\n" + message, resolve);
    });
    signal?.throwIfAborted();
    if (interrupted) throw interruptionError();
    return answer;
  } finally {
    signal?.removeEventListener("abort", close);
    close();
  }
}

export async function confirmSetup(message, yes) {
  if (yes) return;
  if (!process.stdin.isTTY)
    throw new Error(
      "Interactive confirmation is required; inspect --plan and use --yes to authorize it explicitly",
    );
  const answer = await setupQuestion(message + " Type 'yes' or 'y' to continue, or 'no' to stop: ");
  if (!/^y(?:es)?$/i.test(answer?.trim() ?? ""))
    throw new Error("Setup cancelled before applying this step");
}

export function askSetupRules(signal) {
  return setupQuestion(
    "Complete the configuration and type 'completed' to verify it. Type 'continue' to acknowledge unenforced rules, or 'pause' to resume later: ",
    signal,
  );
}

export function rulesetSetupLog(message) {
  if (/^GitHub ruleset configuration/.test(message)) setupWarning(message);
  else console.log(message);
}

import { setupQuestion } from "../scripts/lib/bootstrap.mjs";

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

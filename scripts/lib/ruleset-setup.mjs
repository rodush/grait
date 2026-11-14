import { createInterface } from "node:readline";
import { sameLogin } from "./policy.mjs";

function pending() {
  const error = new Error(
    "Ruleset configuration is pending. Rerun the same command after completing the configuration, or add --acknowledge-unenforced-rules to explicitly continue without verified GitHub enforcement. The overall setup --yes flag does not acknowledge this choice.",
  );
  error.code = "RULESET_SETUP_PENDING";
  return error;
}

async function ask() {
  if (!process.stdin.isTTY) return null;
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise((resolve) => {
      terminal.once("close", () => resolve(null));
      terminal.once("SIGINT", () => terminal.close());
      terminal.question(
        "Complete the configuration, then type completed to verify it; type continue to acknowledge unenforced rules, or pause to resume later: ",
        resolve,
      );
    });
  } finally {
    terminal.close();
  }
}

// GitHub adds response metadata and may return rule arrays in a different order.
function matches(actual, expected) {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value) => actual.some((item) => matches(item, value)))
    );
  if (expected && typeof expected === "object")
    return (
      actual &&
      typeof actual === "object" &&
      Object.entries(expected).every(([key, value]) => matches(actual[key], value))
    );
  return actual === expected;
}

/** Apply rules normally, then offer a deliberate manual/unenforced fallback on ruleset errors. */
export async function configureRepositoryRules({
  api,
  repo,
  rules,
  phase,
  acknowledgeUnenforced = false,
  prompt = ask,
  log = console.log,
}) {
  if (!["stage", "activate"].includes(phase)) throw new Error("Invalid ruleset setup phase");
  let expected = rules.map((rule) => ({
    ...rule,
    enforcement: phase === "stage" && rule.target === "branch" ? "disabled" : "active",
  }));
  let failure;
  try {
    const existingRules = await api.list(`repos/${repo}/rulesets`);
    expected = expected.map((rule) => {
      const existing = existingRules.find(
        (item) => item.name === rule.name && sameLogin(item.source, repo),
      );
      return {
        ...rule,
        enforcement:
          phase === "stage" && rule.target === "branch"
            ? existing?.enforcement || "disabled"
            : "active",
      };
    });
    for (const rule of expected) {
      const existing = existingRules.find(
        (item) => item.name === rule.name && sameLogin(item.source, repo),
      );
      if (!existing && phase === "activate") throw new Error("Missing staged ruleset");
      await api.request(
        existing ? `repos/${repo}/rulesets/${existing.id}` : `repos/${repo}/rulesets`,
        { method: existing ? "PUT" : "POST", body: rule },
      );
    }
    return { enforcement: phase === "stage" ? "staged" : "active" };
  } catch (error) {
    failure = error;
  }

  const explain = (error) => {
    const status = Number.isInteger(error?.status) && error.status >= 100 && error.status <= 599;
    log(
      status
        ? `GitHub ruleset configuration returned HTTP ${error.status}.`
        : "GitHub ruleset configuration could not be completed or verified.",
    );
    log(`Manual configuration: https://github.com/${repo}/settings/rules`);
    log(
      "Create or update each named ruleset using the exact JSON configuration below (import each object separately), including its enforcement setting. Branch rules remain staged until activation.",
    );
    for (const rule of expected) log(JSON.stringify(rule, null, 2));
    log(
      "GitHub Free private repositories do not support rulesets through the API or settings UI. If unavailable, you may explicitly continue without verified GitHub enforcement; rulesets can be configured later on a supported plan. Other errors may require correcting permissions, configuration, or connectivity before retrying.",
    );
    log(
      "Human approval and merge remain mandatory: agents must never merge PRs or release. Continuing does not verify server-side enforcement; some rules may already have been applied.",
    );
  };
  explain(failure);
  if (!acknowledgeUnenforced) {
    for (;;) {
      const answer = (await prompt())?.trim().toLowerCase();
      if (answer === "continue") break;
      if (answer === "completed") {
        try {
          const existingRules = await api.list(`repos/${repo}/rulesets`);
          for (const rule of expected) {
            const existing = existingRules.find(
              (item) => item.name === rule.name && sameLogin(item.source, repo),
            );
            if (!existing) throw new Error("Missing manually configured ruleset");
            const actual = await api.request(`repos/${repo}/rulesets/${existing.id}`);
            if (!matches(actual, rule)) throw new Error("Manual ruleset configuration differs");
          }
          log("Manual ruleset configuration verified.");
          return { enforcement: phase === "stage" ? "staged" : "active" };
        } catch (error) {
          explain(error);
        }
      } else if (!answer || answer === "pause") {
        throw pending();
      } else {
        log("Choose completed, continue, or pause. No acknowledgement has been recorded.");
      }
    }
  }
  log(
    "Explicit acknowledgement received: continuing with unenforced rules (GitHub enforcement is not fully verified). Human approval and human merge are still required; agents never merge or release.",
  );
  return { enforcement: "unenforced" };
}

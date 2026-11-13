import { sameLogin } from "./policy.mjs";

// Admission is separate from an agent's readiness assessment. A label may only
// be applied through repository write/triage permissions, never by issue authors.
export async function admitted(api, repo, item, config, writer) {
  if (item.labels?.some((label) => label.name === config.labels.admitted)) return true;
  const login = item.user?.login;
  if (!login) return false;
  if (sameLogin(login, writer) || config.humanOperators.some((name) => sameLogin(name, login)))
    return true;
  try {
    const access = await api.request(
      `repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
    );
    return ["admin", "maintain", "write"].includes(access.permission);
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

export class DispatchBudget {
  constructor(ledger, number, limits, findRun, now) {
    this.ledger = ledger;
    this.number = number;
    this.limits = limits;
    this.findRun = findRun;
    this.now = now;
  }

  async reserve(pending) {
    if (!Number.isSafeInteger(this.number) || this.number < 1)
      throw new Error("Configure the dedicated automation budget issue before dispatch");
    const { state, comment } = await this.ledger.load(this.number);
    // Never silently recreate a missing ledger and thereby reset the budget.
    if (!comment || !Array.isArray(state.reservations))
      throw new Error("Missing automation budget ledger; human reconciliation required");
    if (
      state.reservations.some(
        (entry) =>
          !entry.operation ||
          !entry.kind ||
          !Number.isFinite(Date.parse(entry.at)) ||
          !Number.isSafeInteger(entry.credits) ||
          entry.credits < 1 ||
          typeof entry.completed !== "boolean",
      ) ||
      new Set(state.reservations.map((entry) => entry.operation)).size !== state.reservations.length
    )
      throw new Error("Invalid budget reservations; human reconciliation required");
    const now = this.now().getTime();
    for (const entry of state.reservations) {
      if (!entry.completed) {
        const run = await this.findRun(entry);
        if (run?.status === "completed") entry.completed = true;
      }
    }
    state.reservations = state.reservations.filter(
      (entry) => !entry.completed || now - Date.parse(entry.at) < 86_400_000,
    );
    const active = state.reservations.filter((entry) => !entry.completed).length;
    const spent = state.reservations
      .filter((entry) => now - Date.parse(entry.at) < 86_400_000)
      .reduce((total, entry) => total + entry.credits, 0);
    const credits =
      pending.kind === "verify" ? 1 : this.limits.agentCredits + this.limits.detectionCredits;
    await this.ledger.save(this.number);
    if (active >= this.limits.maxConcurrent || spent + credits > this.limits.dailyCredits)
      return false;
    state.reservations.push({ ...pending, credits, completed: false });
    await this.ledger.save(this.number); // Reserve before any external dispatch.
    return true;
  }
}

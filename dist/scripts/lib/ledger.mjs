import { parseBlock, sameLogin } from "./policy.mjs";

export const STATE_MARKER = "<!-- workflow-state:v1 -->";

export class Ledger {
  constructor(api, repo, login) {
    this.api = api;
    this.repo = repo;
    this.login = login;
    this.entries = new Map();
  }

  async load(number) {
    if (this.entries.has(number)) return this.entries.get(number);
    const comments = await this.api.list(`repos/${this.repo}/issues/${number}/comments`);
    const matches = comments.filter(
      (comment) =>
        sameLogin(comment.user.login, this.login) && comment.body.startsWith(STATE_MARKER),
    );
    if (matches.length > 1)
      throw new Error(`Multiple controller ledgers on #${number}; human reconciliation required`);
    const comment = matches[0];
    const state = comment ? parseBlock(comment.body, "json") : { version: 1, number };
    if (state.version !== 1 || state.number !== number)
      throw new Error(`Invalid controller ledger on #${number}`);
    const entry = { state, comments, comment, saved: JSON.stringify(state) };
    this.entries.set(number, entry);
    return entry;
  }

  async save(number) {
    const entry = await this.load(number);
    const serialized = JSON.stringify(entry.state);
    if (serialized === entry.saved) return;
    const body = `${STATE_MARKER}\nAutomation state for #${number}. Changes and stop reasons are visible here.\n\n\`\`\`json\n${JSON.stringify(entry.state, null, 2)}\n\`\`\`\n`;
    entry.comment = await this.api.request(
      entry.comment
        ? `repos/${this.repo}/issues/comments/${entry.comment.id}`
        : `repos/${this.repo}/issues/${number}/comments`,
      {
        method: entry.comment ? "PATCH" : "POST",
        body: { body },
      },
    );
    entry.saved = serialized;
  }
}

export class GitHub {
  constructor(
    token,
    { fetcher = fetch, apiUrl = process.env.GITHUB_API_URL || "https://api.github.com" } = {},
  ) {
    if (!token) throw new Error("A GitHub token is required");
    this.token = token;
    this.fetcher = fetcher;
    this.apiUrl = apiUrl.replace(/\/$/, "");
  }

  async request(path, { method = "GET", body, binary = false } = {}) {
    const response = await this.fetcher(`${this.apiUrl}/${path.replace(/^\//, "")}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      // Never log response bodies or request headers: they can contain private data.
      const error = new Error(`GitHub ${method} ${path.split("?")[0]} returned ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return binary
      ? Buffer.from(await response.arrayBuffer())
      : response.status === 204
        ? null
        : response.json();
  }

  async list(path, key) {
    const values = [];
    for (let page = 1; page <= 1000; page++) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.request(`${path}${separator}per_page=100&page=${page}`);
      const batch = key ? response[key] : response;
      if (!Array.isArray(batch)) throw new Error(`Invalid paginated response for ${path}`);
      values.push(...batch);
      if (batch.length < 100) return values;
    }
    throw new Error(`Pagination limit reached for ${path}`);
  }

  async graphql(query, variables = {}) {
    const response = await this.request("graphql", { method: "POST", body: { query, variables } });
    if (response.errors?.length || !response.data)
      throw new Error("GitHub GraphQL returned an incomplete result");
    return response.data;
  }
}

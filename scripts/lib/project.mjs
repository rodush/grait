export class Project {
  constructor(api, id, statuses) {
    this.api = api;
    this.id = id;
    this.statuses = statuses;
    this.items = [];
  }

  async load() {
    const { node } = await this.api.graphql(
      `query($id: ID!) {
      node(id: $id) { ... on ProjectV2 {
        id title shortDescription
        fields(first: 100) { nodes { ... on ProjectV2SingleSelectField { id name options { id name } } } }
      } }
    }`,
      { id: this.id },
    );
    if (!node) throw new Error("Configured project is inaccessible");
    this.controller = node.shortDescription?.match(/\[agent-controller:([^\]]+)\]/)?.[1];
    this.field = node.fields.nodes.find((field) => field.name === "Status");
    if (
      !this.field ||
      Object.values(this.statuses).some(
        (name) => !this.field.options.some((option) => option.name === name),
      )
    )
      throw new Error("Project is missing the configured Status options");
    let cursor = null;
    this.items = [];
    do {
      const { node: project } = await this.api.graphql(
        `query($id: ID!, $cursor: String) {
        node(id: $id) { ... on ProjectV2 {
          items(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes {
            id isArchived
            fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
            content {
              __typename
              ... on Issue { id number title body state stateReason repository { nameWithOwner } }
              ... on DraftIssue { id title }
            }
          } }
        } }
      }`,
        { id: this.id, cursor },
      );
      if (!project) throw new Error("Project became inaccessible while reading items");
      this.items.push(
        ...project.items.nodes.map((item) => ({ ...item, status: item.fieldValueByName?.name })),
      );
      cursor = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
    } while (cursor);
    return this;
  }

  find(repo, number) {
    return this.items.find(
      (item) =>
        !item.isArchived &&
        item.content?.__typename === "Issue" &&
        item.content.repository.nameWithOwner.toLowerCase() === repo.toLowerCase() &&
        item.content.number === number,
    );
  }

  async add(issue, repo) {
    const existing = this.find(repo, issue.number);
    if (existing) return existing;
    const data = await this.api.graphql(
      `mutation($project: ID!, $content: ID!) {
      addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
    }`,
      { project: this.id, content: issue.node_id },
    );
    const item = {
      id: data.addProjectV2ItemById.item.id,
      isArchived: false,
      content: { __typename: "Issue", ...issue, repository: { nameWithOwner: repo } },
    };
    this.items.push(item);
    await this.move(item, this.statuses.backlog);
    return item;
  }

  async move(item, status) {
    if (item.status === status) return;
    const option = this.field.options.find((entry) => entry.name === status);
    if (!option) throw new Error(`Unknown project status ${status}`);
    await this.api.graphql(
      `mutation($project: ID!, $item: ID!, $field: ID!, $option: String!) {
      updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
    }`,
      { project: this.id, item: item.id, field: this.field.id, option: option.id },
    );
    item.status = status;
  }
}

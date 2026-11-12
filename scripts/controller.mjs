import { readFile } from "node:fs/promises";
import { GitHub } from "./lib/github.mjs";
import { Controller } from "./lib/controller.mjs";

try {
  if (process.env.AUTOMATION_ENABLED !== "true") throw new Error("Automation is not enabled");
  const config = JSON.parse(await readFile("workflow.config.json", "utf8"));
  const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
  const controller = await new Controller({
    api: new GitHub(process.env.AUTOMATION_TOKEN),
    projectApi: new GitHub(process.env.PROJECT_TOKEN),
    repo: process.env.GITHUB_REPOSITORY,
    projectId: process.env.PROJECT_ID,
    writer: process.env.AUTOMATION_LOGIN,
    reviewer: process.env.REVIEW_LOGIN,
    config,
  }).initialize();
  await controller.run({
    task: event.inputs?.task || "reconcile",
    number: event.inputs?.number,
    actor: process.env.GITHUB_ACTOR,
    event,
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

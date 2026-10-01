import { expect, test } from "bun:test";
import { parseWorkspaceRoute, workspaceHref } from "./workspace-route";

test("project, change and review surfaces have distinct stable URLs", () => {
  expect(workspaceHref()).toBe("/workspace");
  expect(workspaceHref("alpha")).toBe("/workspace/projects/alpha");
  expect(workspaceHref("alpha", "beta", "code")).toBe(
    "/workspace/projects/alpha/changes/beta/code",
  );
  expect(
    parseWorkspaceRoute(workspaceHref("alpha", "beta", "activity")),
  ).toEqual({ projectId: "alpha", changeId: "beta", view: "activity" });
  expect(parseWorkspaceRoute("/workspace/projects/alpha/")).toEqual({
    projectId: "alpha",
    view: "overview",
  });
});

test("unknown and incomplete URLs cannot silently select another change", () => {
  for (const path of [
    "/workspace/projects",
    "/workspace/alpha",
    "/workspace/projects/alpha/changes/beta",
    "/workspace/projects/alpha/changes/beta/deploy",
    "/workspace/projects/alpha/changes/beta/code/extra",
    "/other",
  ])
    expect(parseWorkspaceRoute(path)).toBeNull();
});

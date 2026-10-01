export const changeViews = ["overview", "code"] as const;
export type ChangeView = (typeof changeViews)[number];
export type WorkspaceRoute = {
  projectId?: string;
  changeId?: string;
  view: ChangeView;
};

export function workspaceHref(
  projectId?: string,
  changeId?: string,
  view: ChangeView = "overview",
) {
  if (!projectId) return "/workspace";
  const project = `/workspace/projects/${encodeURIComponent(projectId)}`;
  return changeId
    ? `${project}/changes/${encodeURIComponent(changeId)}/${view}`
    : project;
}

export function parseWorkspaceRoute(pathname: string): WorkspaceRoute | null {
  const parts = pathname.replace(/\/$/, "").split("/").slice(1);
  if (parts[0] !== "workspace") return null;
  if (parts.length === 1) return { view: "overview" };
  if (parts[1] !== "projects" || !parts[2]) return null;
  if (parts.length === 3) return { projectId: parts[2], view: "overview" };
  if (
    parts.length !== 6 ||
    parts[3] !== "changes" ||
    !parts[4] ||
    !changeViews.includes(parts[5] as ChangeView)
  )
    return null;
  return {
    projectId: parts[2],
    changeId: parts[4],
    view: parts[5] as ChangeView,
  };
}

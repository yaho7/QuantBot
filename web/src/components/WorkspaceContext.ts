import { createContext, useContext } from "react";
import { workspaceApi, type WorkspaceProject } from "@/lib/api";

export function workspaceScope(project: WorkspaceProject, active: boolean) {
  return {
    project, active,
    api: workspaceApi(project.id),
    key: (...parts: unknown[]) => ["workbench", project.id, ...parts],
  };
}

export const WorkspaceContext = createContext<ReturnType<typeof workspaceScope> | null>(null);

export function useWorkspace() {
  const scope = useContext(WorkspaceContext);
  if (!scope) throw new Error("Missing workspace context");
  return scope;
}

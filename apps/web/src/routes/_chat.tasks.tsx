import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { TaskBoard, type TasksSearch } from "../components/tasks/TaskBoard";

export const Route = createFileRoute("/_chat/tasks")({
  validateSearch: (raw: Record<string, unknown>): TasksSearch => ({
    ...(raw.archived === 1 || raw.archived === "1" ? { archived: 1 as const } : {}),
    ...(typeof raw.environment === "string" && raw.environment
      ? { environment: raw.environment as EnvironmentId }
      : {}),
    ...(typeof raw.project === "string" && raw.project
      ? { project: raw.project as ProjectId }
      : {}),
  }),
  component: TasksRouteView,
});

function TasksRouteView() {
  return <TaskBoard search={Route.useSearch()} />;
}

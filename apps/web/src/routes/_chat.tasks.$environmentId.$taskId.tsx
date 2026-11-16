import type { EnvironmentId, TaskId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { TaskDetail } from "../components/tasks/TaskDetail";

export const Route = createFileRoute("/_chat/tasks/$environmentId/$taskId")({
  component: TaskRouteView,
});

function TaskRouteView() {
  const { environmentId, taskId } = Route.useParams();
  return (
    <TaskDetail
      key={`${environmentId}\n${taskId}`}
      environmentId={environmentId as EnvironmentId}
      taskId={taskId as TaskId}
    />
  );
}

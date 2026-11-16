import { createFileRoute } from "@tanstack/react-router";

import { TasksSettingsPanel } from "../components/settings/TasksSettings";

export const Route = createFileRoute("/_chat/settings/tasks")({
  component: TasksSettingsPanel,
});

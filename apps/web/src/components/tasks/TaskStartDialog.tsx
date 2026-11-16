import { useAtomValue } from "@effect/atom-react";
import {
  clampManagedRuntimeMode,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProviderInstanceId,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type Task,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useState } from "react";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { useProjects } from "~/state/entities";
import { useManagedPolicy } from "~/state/managedPolicy";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { tasksEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { scheduledTaskDefaultModel } from "../settings/scheduledTasksSettings.logic";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { toastTaskCommandFailure } from "./taskCommandToast";

/** The agent, model and runtime mode a task chat starts with: the project's defaults until picked. */
export function useTaskAgentChoice(environmentId: EnvironmentId, projectId: ProjectId) {
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const project =
    useProjects().find(
      (entry) => entry.environmentId === environmentId && entry.id === projectId,
    ) ?? null;
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const managedPolicy = useManagedPolicy(environmentId);
  const instanceEntries = providerInstanceEntriesFor(providers, settings, projectId);
  const selection =
    picked !== null && instanceEntries.some((entry) => entry.instanceId === picked.instanceId)
      ? picked
      : scheduledTaskDefaultModel(settings, project, instanceEntries);
  const instanceId =
    selection?.instanceId ?? instanceEntries[0]?.instanceId ?? ProviderInstanceId.make("");
  const model = selection?.model ?? "";
  const defaultRuntimeMode = resolveProjectSettings(settings, projectId, project).settings
    .defaultRuntimeMode;
  return {
    project,
    selection,
    runtimeMode: clampManagedRuntimeMode(managedPolicy, defaultRuntimeMode) ?? defaultRuntimeMode,
    picker: {
      instanceId,
      model,
      instanceEntries,
      modelOptionsByInstance: getCustomModelOptionsByInstance(
        settings,
        providers,
        instanceId,
        model,
      ),
      onPick: setPicked,
    },
  };
}

export function TaskAgentPicker({
  environmentId,
  disabled,
  picker,
}: {
  readonly environmentId: EnvironmentId;
  readonly disabled: boolean;
  readonly picker: ReturnType<typeof useTaskAgentChoice>["picker"];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>Агент и модель</Label>
      <ProviderModelPicker
        environmentId={environmentId}
        disabled={disabled}
        activeInstanceId={picker.instanceId}
        model={picker.model}
        lockedProvider={null}
        instanceEntries={picker.instanceEntries}
        modelOptionsByInstance={picker.modelOptionsByInstance}
        isComposerOwned={false}
        onInstanceModelChange={(nextInstanceId, nextModel) =>
          picker.onPick({ instanceId: nextInstanceId, model: nextModel })
        }
      />
    </div>
  );
}

/** Starts a backlog task: the server opens its worktree and first chat with the chosen agent. */
export function TaskStartDialog({
  environmentId,
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: Task;
  readonly onClose: () => void;
}) {
  const [starting, setStarting] = useState(false);
  const { project, selection, runtimeMode, picker } = useTaskAgentChoice(
    environmentId,
    task.primaryProjectId,
  );
  const canStart = useAtomValue(tasksEnvironment.startTask.permissionAtom(environmentId));
  const startTask = useAtomCommand(tasksEnvironment.startTask, { label: "task start" });

  const start = async () => {
    if (starting || selection === null || !canStart || project === null) return;
    setStarting(true);
    const result = await startTask({
      environmentId,
      input: {
        id: task.id,
        commandId: CommandId.make(randomUUID()),
        modelSelection: selection,
        runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      },
    });
    setStarting(false);
    if (toastTaskCommandFailure("Не удалось взять задачу в работу", result)) return;
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !starting) onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>В работу: {task.title}</DialogTitle>
          <DialogDescription>
            Задача получит свой worktree в {project?.title ?? "основном репозитории"}, первый чат
            начнётся с её описания.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {project === null ? (
            <p role="alert" className="mb-3 text-sm text-destructive-foreground">
              Основной проект задачи недоступен в этом environment.
            </p>
          ) : null}
          <TaskAgentPicker environmentId={environmentId} disabled={starting} picker={picker} />
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" disabled={starting} />}>
            Отмена
          </DialogClose>
          <Button
            size="sm"
            disabled={starting || selection === null || !canStart || project === null}
            onClick={() => void start()}
          >
            В работу
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

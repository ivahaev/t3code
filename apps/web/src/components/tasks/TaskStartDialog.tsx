import { useAtomValue } from "@effect/atom-react";
import {
  clampManagedRuntimeMode,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProviderInstanceId,
  type EnvironmentId,
  type ModelSelection,
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
  const [picked, setPicked] = useState<ModelSelection | null>(null);
  const project =
    useProjects().find(
      (entry) => entry.environmentId === environmentId && entry.id === task.primaryProjectId,
    ) ?? null;
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const managedPolicy = useManagedPolicy(environmentId);
  const canStart = useAtomValue(tasksEnvironment.startTask.permissionAtom(environmentId));
  const startTask = useAtomCommand(tasksEnvironment.startTask, { label: "task start" });
  const instanceEntries = providerInstanceEntriesFor(providers, settings, task.primaryProjectId);
  // The project's default agent and model until the user picks another.
  const selection =
    picked !== null && instanceEntries.some((entry) => entry.instanceId === picked.instanceId)
      ? picked
      : scheduledTaskDefaultModel(settings, project, instanceEntries);
  const instanceId =
    selection?.instanceId ?? instanceEntries[0]?.instanceId ?? ProviderInstanceId.make("");
  const model = selection?.model ?? "";
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    instanceId,
    model,
  );
  const defaultRuntimeMode = resolveProjectSettings(settings, task.primaryProjectId, project)
    .settings.defaultRuntimeMode;

  const start = async () => {
    if (starting || selection === null || !canStart) return;
    setStarting(true);
    const result = await startTask({
      environmentId,
      input: {
        id: task.id,
        commandId: CommandId.make(randomUUID()),
        modelSelection: selection,
        runtimeMode:
          clampManagedRuntimeMode(managedPolicy, defaultRuntimeMode) ?? defaultRuntimeMode,
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
          <div className="flex flex-col gap-1.5">
            <Label>Агент и модель</Label>
            <ProviderModelPicker
              environmentId={environmentId}
              disabled={starting}
              activeInstanceId={instanceId}
              model={model}
              lockedProvider={null}
              instanceEntries={instanceEntries}
              modelOptionsByInstance={modelOptionsByInstance}
              isComposerOwned={false}
              onInstanceModelChange={(nextInstanceId, nextModel) =>
                setPicked({ instanceId: nextInstanceId, model: nextModel })
              }
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" disabled={starting} />}>
            Отмена
          </DialogClose>
          <Button
            size="sm"
            disabled={starting || selection === null || !canStart}
            onClick={() => void start()}
          >
            В работу
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

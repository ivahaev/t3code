import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
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
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { randomUUID } from "~/lib/utils";
import { getCustomModelOptionsByInstance } from "~/modelSelection";
import { providerInstanceEntriesFor } from "~/providerInstances";
import { useProjects } from "~/state/entities";
import { useManagedPolicy } from "~/state/managedPolicy";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "~/state/server";
import { tasksEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
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
import { toastTaskCommandFailure } from "./taskCommandToast";
import { TaskField, TaskSwitchRow } from "./taskDialogParts";

/** The agent, model and runtime mode a task thread starts with: the project's defaults until picked. */
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
  // Like a new thread's composer: the last model the user picked, unless a default is configured.
  const recent = useComposerDraftStore((state) =>
    state.stickyActiveProvider === null
      ? null
      : (state.stickyModelSelectionByProvider[state.stickyActiveProvider] ?? null),
  );
  const selection =
    picked !== null && instanceEntries.some((entry) => entry.instanceId === picked.instanceId)
      ? picked
      : scheduledTaskDefaultModel(settings, project, instanceEntries, recent);
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
    <TaskField label="Agent">
      <div className="flex">
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
    </TaskField>
  );
}

/** Starts a backlog task: the server opens its first thread, then the thread opens here. */
export function TaskStartDialog({
  environmentId,
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: Task;
  readonly onClose: () => void;
}) {
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [worktree, setWorktree] = useState(true);
  const [sendDescription, setSendDescription] = useState(true);
  const { project, selection, runtimeMode, picker } = useTaskAgentChoice(
    environmentId,
    task.primaryProjectId,
  );
  const canStart = useAtomValue(tasksEnvironment.startTask.permissionAtom(environmentId));
  const startTask = useAtomCommand(tasksEnvironment.startTask, { label: "task start" });
  const ready = !starting && selection !== null && canStart && project !== null;

  const start = async () => {
    if (!ready) return;
    setStarting(true);
    const result = await startTask({
      environmentId,
      input: {
        id: task.id,
        commandId: CommandId.make(randomUUID()),
        modelSelection: selection,
        runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        worktree,
        sendDescription,
      },
    });
    setStarting(false);
    if (toastTaskCommandFailure("Couldn't start task", result)) return;
    onClose();
    if (result._tag === "Success") {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, result.value.threadId)),
      });
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !starting) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void start();
          }}
        >
          <DialogHeader>
            <DialogTitle>Start task</DialogTitle>
            <DialogDescription>
              Opens the first thread for “{task.title}” in {project?.title ?? "its main project"}.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-5">
              {project === null ? (
                <p role="alert" className="text-sm text-destructive-foreground">
                  The task's main project isn't available in this environment.
                </p>
              ) : null}
              <TaskAgentPicker environmentId={environmentId} disabled={starting} picker={picker} />
              <TaskSwitchRow
                id="task-start-worktree"
                label="New worktree"
                description="Work on a task branch in its own worktree. Off runs in the project's current checkout."
                checked={worktree}
                disabled={starting}
                onCheckedChange={setWorktree}
              />
              <TaskSwitchRow
                id="task-start-description"
                label="Start with the task description"
                description="Send the task's title and description as the first message. Off opens an empty thread."
                checked={sendDescription}
                disabled={starting}
                onCheckedChange={setSendDescription}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" disabled={starting} />}>
              Cancel
            </DialogClose>
            <Button type="submit" size="sm" disabled={!ready}>
              {starting ? "Starting…" : "Start"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

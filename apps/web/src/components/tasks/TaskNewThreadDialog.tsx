import { useAtomValue } from "@effect/atom-react";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type EnvironmentId,
  type ProjectId,
  type Task,
  type TaskNewThreadInput,
} from "@t3tools/contracts";
import { useState } from "react";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";

import { useScratchProject } from "~/hooks/useScratchProject";

import { randomUUID } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { tasksEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { ProjectFavicon } from "../ProjectFavicon";
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
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastTaskCommandFailure } from "./taskCommandToast";
import { TaskField } from "./taskDialogParts";
import { defaultNewThreadProject } from "./taskDetail.logic";
import { TaskAgentPicker, useTaskAgentChoice } from "./TaskStartDialog";

type Workspace = TaskNewThreadInput["workspace"];

const WORKSPACES: ReadonlyArray<{ value: Workspace; label: string; detail: string }> = [
  {
    value: "shared",
    label: "Task worktree",
    detail: "The task's branch in this project, shared with its other threads.",
  },
  {
    value: "extra",
    label: "Separate worktree",
    detail: "A new branch off the task's branch, so its diff shows only this work.",
  },
  {
    value: "root",
    label: "Current checkout",
    detail: "No worktree, in the project's folder.",
  },
];

const ADD_PROJECT = "\u0000add-project";

/** Opens another thread in the task: in one of its projects, in a worktree of the user's choice. */
export function TaskNewThreadDialog({
  environmentId,
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: Task;
  readonly onClose: () => void;
}) {
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const taskProjects = projects.filter((project) => task.projectIds.includes(project.id));
  const { scratchWorkspaceRootFor } = useScratchProject();
  const otherProjects = projects.filter(
    (project) =>
      !task.projectIds.includes(project.id) &&
      project.archivedAt == null &&
      !isScratchProject(project, scratchWorkspaceRootFor(environmentId)),
  );
  const [projectId, setProjectId] = useState<ProjectId | null>(() =>
    defaultNewThreadProject(task, new Set(taskProjects.map((project) => project.id))),
  );
  const [addingProject, setAddingProject] = useState(false);
  const [workspace, setWorkspace] = useState<Workspace>("shared");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const { selection, runtimeMode, picker } = useTaskAgentChoice(
    environmentId,
    projectId ?? task.primaryProjectId,
  );
  const canCreate = useAtomValue(tasksEnvironment.newTaskThread.permissionAtom(environmentId));
  const newTaskThread = useAtomCommand(tasksEnvironment.newTaskThread, {
    label: "task new thread",
  });
  const addTaskProject = useAtomCommand(tasksEnvironment.addTaskProject, {
    label: "task add project",
  });
  const valid = projectId !== null && text.trim().length > 0 && selection !== null;

  const addProject = async (next: ProjectId) => {
    setBusy(true);
    const result = await addTaskProject({ environmentId, input: { id: task.id, projectId: next } });
    setBusy(false);
    if (toastTaskCommandFailure("Couldn't add the project to the task", result)) return;
    setAddingProject(false);
    setProjectId(next);
  };

  const submit = async () => {
    if (!valid || projectId === null || busy || !canCreate) return;
    setBusy(true);
    const result = await newTaskThread({
      environmentId,
      input: {
        id: task.id,
        commandId: CommandId.make(randomUUID()),
        projectId,
        workspace,
        modelSelection: selection,
        runtimeMode,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        text: text.trim(),
      },
    });
    setBusy(false);
    if (toastTaskCommandFailure("Couldn't start thread", result)) return;
    onClose();
  };

  const selectedProject = projects.find((project) => project.id === projectId) ?? null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>New thread</DialogTitle>
            <DialogDescription>Start another thread in “{task.title}”.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <TaskField label="Message" htmlFor="task-thread-text">
                <Textarea
                  id="task-thread-text"
                  autoFocus
                  className="max-h-64 overflow-y-auto"
                  placeholder="What should the agent do?"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </TaskField>
              <TaskField label="Project" htmlFor="task-thread-project">
                <Select
                  value={projectId}
                  onValueChange={(next) => {
                    if (next === null) return;
                    if (next === ADD_PROJECT) setAddingProject(true);
                    else setProjectId(next as ProjectId);
                  }}
                >
                  <SelectTrigger id="task-thread-project" size="sm" disabled={busy}>
                    <SelectValue>
                      {selectedProject ? (
                        <span className="flex min-w-0 items-center gap-2">
                          <ProjectFavicon project={selectedProject} className="size-4 shrink-0" />
                          <span className="truncate">{selectedProject.title}</span>
                        </span>
                      ) : (
                        "Choose a project"
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {taskProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id} label={project.title}>
                        <span className="flex min-w-0 items-center gap-2">
                          <ProjectFavicon project={project} className="size-4 shrink-0" />
                          <span className="truncate">{project.title}</span>
                        </span>
                      </SelectItem>
                    ))}
                    {otherProjects.length > 0 ? (
                      <SelectItem value={ADD_PROJECT} label="Add a project…">
                        Add a project…
                      </SelectItem>
                    ) : null}
                  </SelectPopup>
                </Select>
                {addingProject ? (
                  <Select
                    value={null}
                    onValueChange={(next) => {
                      if (next !== null) void addProject(next as ProjectId);
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Project to add" disabled={busy}>
                      <SelectValue>Choose a project to add</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {otherProjects.map((project) => (
                        <SelectItem key={project.id} value={project.id} label={project.title}>
                          <span className="flex min-w-0 items-center gap-2">
                            <ProjectFavicon project={project} className="size-4 shrink-0" />
                            <span className="truncate">{project.title}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
              </TaskField>
              <fieldset className="space-y-1.5">
                <legend className="mb-1.5 text-sm font-medium">Workspace</legend>
                <RadioGroup
                  value={workspace}
                  onValueChange={(next) => setWorkspace(next as Workspace)}
                  disabled={busy}
                >
                  {WORKSPACES.map((option) => (
                    <label key={option.value} className="flex cursor-pointer items-start gap-2.5">
                      <Radio value={option.value} className="mt-0.5" />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm">{option.label}</span>
                        <span className="text-xs text-muted-foreground">{option.detail}</span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </fieldset>
              <TaskAgentPicker environmentId={environmentId} disabled={busy} picker={picker} />
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
              Cancel
            </DialogClose>
            <Button type="submit" size="sm" disabled={!valid || busy || !canCreate}>
              Start thread
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

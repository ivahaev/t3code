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

import { randomUUID } from "~/lib/utils";
import { useProjects } from "~/state/entities";
import { tasksEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Radio, RadioGroup } from "../ui/radio-group";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastTaskCommandFailure } from "./taskCommandToast";
import { defaultNewThreadProject } from "./taskDetail.logic";
import { TaskAgentPicker, useTaskAgentChoice } from "./TaskStartDialog";

type Workspace = TaskNewThreadInput["workspace"];

const WORKSPACES: ReadonlyArray<{ value: Workspace; label: string; detail: string }> = [
  {
    value: "shared",
    label: "Общий worktree задачи",
    detail: "Ветка задачи в этом репозитории, вместе с другими её чатами.",
  },
  {
    value: "extra",
    label: "Отдельный worktree",
    detail: "Новая ветка от ветки задачи, её дифф показывает только эту работу.",
  },
  { value: "root", label: "Корень проекта", detail: "Без worktree, в папке проекта." },
];

const ADD_PROJECT = "\u0000add-project";

/** Opens another chat in the task: in one of its repositories, in a worktree of the user's choice. */
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
  const otherProjects = projects.filter(
    (project) => !task.projectIds.includes(project.id) && project.archivedAt == null,
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
    if (toastTaskCommandFailure("Не удалось добавить проект в задачу", result)) return;
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
    if (toastTaskCommandFailure("Не удалось начать чат", result)) return;
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Новый чат в задаче</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="task-thread-project">Репозиторий</Label>
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
                      {projects.find((project) => project.id === projectId)?.title ??
                        "Выберите репозиторий"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {taskProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id} label={project.title}>
                        {project.title}
                      </SelectItem>
                    ))}
                    {otherProjects.length > 0 ? (
                      <SelectItem value={ADD_PROJECT} label="Добавить проект…">
                        Добавить проект…
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
                    <SelectTrigger size="sm" aria-label="Проект для задачи" disabled={busy}>
                      <SelectValue>Выберите проект</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {otherProjects.map((project) => (
                        <SelectItem key={project.id} value={project.id} label={project.title}>
                          {project.title}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
              </div>
              <fieldset className="space-y-1.5">
                <legend className="mb-1.5 text-sm font-medium">Где работать</legend>
                <RadioGroup
                  value={workspace}
                  onValueChange={(next) => setWorkspace(next as Workspace)}
                  disabled={busy}
                >
                  {WORKSPACES.map((option) => (
                    <label key={option.value} className="flex cursor-pointer items-start gap-2">
                      <Radio value={option.value} className="mt-0.5" />
                      <span className="flex flex-col">
                        <span className="text-sm">{option.label}</span>
                        <span className="text-xs text-muted-foreground">{option.detail}</span>
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </fieldset>
              <TaskAgentPicker environmentId={environmentId} disabled={busy} picker={picker} />
              <div className="space-y-1.5">
                <Label htmlFor="task-thread-text">Сообщение агенту</Label>
                <Textarea
                  id="task-thread-text"
                  autoFocus
                  className="max-h-64 overflow-y-auto"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </div>
            </div>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" size="sm" disabled={busy} />}>
              Отмена
            </DialogClose>
            <Button type="submit" size="sm" disabled={!valid || busy || !canCreate}>
              Начать чат
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

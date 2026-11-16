import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, Task } from "@t3tools/contracts";
import { useState } from "react";

import { useProjects } from "~/state/entities";
import { tasksEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastTaskCommandFailure } from "./taskCommandToast";

export interface TaskEditorTarget {
  readonly environmentId: EnvironmentId;
  /** Null creates a task in the backlog. */
  readonly task: Task | null;
}

export function TaskEditorDialog({
  target,
  environments,
  onClose,
}: {
  readonly target: TaskEditorTarget;
  /** Environments a new task can be created in; an existing task stays where it is. */
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly onClose: () => void;
}) {
  const [saving, setSaving] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <TaskEditorForm
          target={target}
          environments={environments}
          saving={saving}
          onSavingChange={setSaving}
          onClose={onClose}
        />
      </DialogPopup>
    </Dialog>
  );
}

function TaskEditorForm({
  target,
  environments,
  saving,
  onSavingChange,
  onClose,
}: {
  readonly target: TaskEditorTarget;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly saving: boolean;
  readonly onSavingChange: (saving: boolean) => void;
  readonly onClose: () => void;
}) {
  const { task } = target;
  const [environmentId, setEnvironmentId] = useState(target.environmentId);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [link, setLink] = useState(task?.link ?? "");
  // Selection order matters: the first repository is where the task's first chat starts.
  const [projectIds, setProjectIds] = useState<ReadonlyArray<ProjectId>>(
    task
      ? [task.primaryProjectId, ...task.projectIds.filter((id) => id !== task.primaryProjectId)]
      : [],
  );
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId &&
      (project.archivedAt == null || projectIds.includes(project.id)),
  );
  const canSave = useAtomValue(tasksEnvironment.upsertTask.permissionAtom(environmentId));
  const upsertTask = useAtomCommand(tasksEnvironment.upsertTask, { label: "task upsert" });
  const primaryProjectId = projectIds[0];
  const valid = title.trim().length > 0 && primaryProjectId !== undefined;

  const submit = async () => {
    if (!valid || saving || !canSave) return;
    onSavingChange(true);
    const result = await upsertTask({
      environmentId,
      input: {
        ...(task ? { id: task.id } : {}),
        title: title.trim(),
        description,
        link: link.trim() === "" ? null : link.trim(),
        primaryProjectId,
        projectIds,
      },
    });
    onSavingChange(false);
    if (toastTaskCommandFailure("Не удалось сохранить задачу", result)) return;
    onClose();
  };

  return (
    <form
      className="flex min-h-0 flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <DialogHeader>
        <DialogTitle>{task ? "Задача" : "Новая задача"}</DialogTitle>
      </DialogHeader>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          {task === null && environments.length > 1 ? (
            <div className="space-y-1.5">
              <Label htmlFor="task-environment">Environment</Label>
              <Select
                value={environmentId}
                onValueChange={(next) => {
                  if (next === null || next === environmentId) return;
                  setEnvironmentId(next);
                  setProjectIds([]);
                }}
              >
                <SelectTrigger id="task-environment" size="sm">
                  <SelectValue>
                    {environments.find((entry) => entry.environmentId === environmentId)?.label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {environments.map((entry) => (
                    <SelectItem
                      key={entry.environmentId}
                      value={entry.environmentId}
                      label={entry.label}
                    >
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="task-title">Заголовок</Label>
            <Input
              id="task-title"
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="task-description">Описание</Label>
            <Textarea
              id="task-description"
              className="max-h-64 overflow-y-auto"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <fieldset className="space-y-1.5">
            <legend className="mb-1.5 text-sm font-medium">Репозитории</legend>
            {projects.length === 0 ? (
              <p className="text-sm text-muted-foreground">В этом environment нет проектов.</p>
            ) : (
              <ul className="max-h-48 space-y-1 overflow-y-auto">
                {projects.map((project) => {
                  const checked = projectIds.includes(project.id);
                  return (
                    <li key={project.id}>
                      <label className="flex cursor-pointer items-center gap-2 text-sm">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(next) =>
                            setProjectIds((current) =>
                              next
                                ? [...current.filter((id) => id !== project.id), project.id]
                                : current.filter((id) => id !== project.id),
                            )
                          }
                        />
                        <span className="min-w-0 truncate">{project.title}</span>
                        {project.id === primaryProjectId ? (
                          <Badge variant="outline" size="sm">
                            основной
                          </Badge>
                        ) : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
          <div className="space-y-1.5">
            <Label htmlFor="task-link">Ссылка</Label>
            <Input
              id="task-link"
              type="url"
              placeholder="https://"
              value={link}
              onChange={(event) => setLink(event.target.value)}
            />
          </div>
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" size="sm" disabled={saving} />}>
          Отмена
        </DialogClose>
        <Button type="submit" size="sm" disabled={!valid || saving || !canSave}>
          {task ? "Сохранить" : "Создать"}
        </Button>
      </DialogFooter>
    </form>
  );
}

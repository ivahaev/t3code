import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, Task, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useProjects, useThreadShells } from "~/state/entities";
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
import { Input } from "../ui/input";
import { toastTaskCommandFailure } from "./taskCommandToast";
import { taskErrorCode } from "./taskDetail.logic";

const RESULT_LIMIT = 50;

/** Finds a chat of the task's environment and attaches it, moving it from another task if asked. */
export function TaskAttachThreadDialog({
  environmentId,
  task,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: Task;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const canAttach = useAtomValue(tasksEnvironment.attachTaskThread.permissionAtom(environmentId));
  const attachTaskThread = useAtomCommand(tasksEnvironment.attachTaskThread, {
    label: "task attach thread",
  });
  const projectTitles = new Map(
    useProjects()
      .filter((project) => project.environmentId === environmentId)
      .map((project) => [project.id, project.title]),
  );
  const needle = query.trim().toLocaleLowerCase();
  const candidates = useThreadShells()
    .filter(
      (shell) =>
        shell.environmentId === environmentId &&
        shell.deletedAt === null &&
        !task.threadIds.includes(shell.id) &&
        (needle === "" ||
          shell.title.toLocaleLowerCase().includes(needle) ||
          (shell.branch ?? "").toLocaleLowerCase().includes(needle) ||
          (projectTitles.get(shell.projectId) ?? "").toLocaleLowerCase().includes(needle)),
    )
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, RESULT_LIMIT);

  const attach = async (threadId: ThreadId) => {
    if (busy || !canAttach) return;
    setBusy(true);
    let result = await attachTaskThread({
      environmentId,
      input: { id: task.id, threadId, moveFromOtherTask: false },
    });
    if (
      result._tag === "Failure" &&
      taskErrorCode(squashAtomCommandFailure(result)) === "already_attached"
    ) {
      const message = "Чат уже привязан к другой задаче. Перенести его в эту?";
      const confirmed = (await requestConfirmDialog(message)) ?? window.confirm(message);
      if (!confirmed) {
        setBusy(false);
        return;
      }
      result = await attachTaskThread({
        environmentId,
        input: { id: task.id, threadId, moveFromOtherTask: true },
      });
    }
    setBusy(false);
    if (toastTaskCommandFailure("Не удалось привязать чат", result)) return;
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
        <DialogHeader>
          <DialogTitle>Привязать чат</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Input
              autoFocus
              type="search"
              aria-label="Поиск чата"
              placeholder="Название, ветка или проект"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">Подходящих чатов нет.</p>
            ) : (
              <ul className="-mx-2 flex max-h-80 flex-col overflow-y-auto">
                {candidates.map((shell) => (
                  <li key={shell.id}>
                    <button
                      type="button"
                      disabled={busy || !canAttach}
                      onClick={() => void attach(shell.id)}
                      className="flex w-full min-w-0 flex-col items-start rounded-md px-2 py-1.5 text-start hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-64"
                    >
                      <span className="w-full truncate text-sm">{shell.title}</span>
                      <span className="w-full truncate text-xs text-muted-foreground">
                        {projectTitles.get(shell.projectId) ?? shell.projectId}
                        {shell.branch ? ` · ${shell.branch}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" size="sm" disabled={busy} />}>
            Закрыть
          </DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, Task, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useProjects, useThreadShells } from "~/state/entities";
import { tasksEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
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
import { Input } from "../ui/input";
import { toastTaskCommandFailure } from "./taskCommandToast";
import { attachCandidates, taskErrorCode } from "./taskDetail.logic";

const RESULT_LIMIT = 50;

/** Finds a thread of the task's environment and attaches it, moving it from another task if asked. */
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
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const projectTitles = new Map(projects.map((project) => [project.id, project.title]));
  const candidates = attachCandidates(
    useThreadShells().filter((shell) => shell.environmentId === environmentId),
    { task, query, projectTitles, limit: RESULT_LIMIT },
  );

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
      const message = "This thread belongs to another task. Move it to this one?";
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
    if (toastTaskCommandFailure("Couldn't attach thread", result)) return;
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Attach thread</DialogTitle>
          <DialogDescription>Add an existing thread to “{task.title}”.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Input
              autoFocus
              type="search"
              aria-label="Search threads"
              placeholder="Search by title, branch or project"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {candidates.length === 0 ? (
              <p className="text-sm text-muted-foreground">No matching threads.</p>
            ) : (
              <ul className="-mx-2 flex max-h-80 flex-col overflow-y-auto">
                {candidates.map((shell) => (
                  <li key={shell.id}>
                    <button
                      type="button"
                      disabled={busy || !canAttach}
                      onClick={() => void attach(shell.id)}
                      className="flex w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-1.5 text-start hover:bg-accent focus-visible:bg-accent focus-visible:outline-none disabled:opacity-64"
                    >
                      <ThreadProjectIcon
                        project={projects.find((project) => project.id === shell.projectId)}
                      />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-sm">{shell.title}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {projectTitles.get(shell.projectId) ?? shell.projectId}
                          {shell.branch ? ` · ${shell.branch}` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={busy} />}>
            Close
          </DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ThreadProjectIcon({ project }: { readonly project: ProjectFaviconProject | undefined }) {
  return (
    <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
      {project ? <ProjectFavicon project={project} className="size-4" /> : null}
    </span>
  );
}

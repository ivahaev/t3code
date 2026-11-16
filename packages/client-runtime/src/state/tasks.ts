import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type * as Persistence from "../platform/persistence.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * @public Consumed by the web state module added with the board UI.
 */
export function createTasksEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  // Task mutations are independent board edits, not shared config writes, so they use
  // the default (unserialized) scheduler. This keeps startTask/newTaskThread/cleanup,
  // which do real work (worktree + agent start), from queueing behind settings writes.
  const command = <Tag extends Parameters<typeof createEnvironmentRpcCommand>[1]["tag"]>(
    label: string,
    tag: Tag,
  ) => createEnvironmentRpcCommand(runtime, { label: `environment-data:tasks:${label}`, tag });
  return {
    tasksLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:tasks:live",
      tag: WS_METHODS.tasksSubscribe,
    }),
    upsertTask: command("upsert", WS_METHODS.tasksUpsert),
    setTaskStatus: command("set-status", WS_METHODS.tasksSetStatus),
    deleteTask: command("delete", WS_METHODS.tasksDelete),
    archiveTask: command("archive", WS_METHODS.tasksArchive),
    unarchiveTask: command("unarchive", WS_METHODS.tasksUnarchive),
    startTask: command("start", WS_METHODS.tasksStart),
    newTaskThread: command("new-thread", WS_METHODS.tasksNewThread),
    attachTaskThread: command("attach-thread", WS_METHODS.tasksAttachThread),
    detachTaskThread: command("detach-thread", WS_METHODS.tasksDetachThread),
    addTaskProject: command("add-project", WS_METHODS.tasksAddProject),
    previewTaskCleanup: command("cleanup-preview", WS_METHODS.tasksCleanupPreview),
    cleanupTask: command("cleanup", WS_METHODS.tasksCleanup),
    setTaskCleanupMode: command("set-cleanup-mode", WS_METHODS.tasksSetCleanupMode),
  };
}

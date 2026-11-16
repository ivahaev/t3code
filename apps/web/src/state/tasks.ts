import { createTasksEnvironmentAtoms } from "@t3tools/client-runtime/state/tasks";
import type { EnvironmentId, Task } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { AtomRegistry } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

export const tasksEnvironment = createTasksEnvironmentAtoms(connectionAtomRuntime);

/**
 * The environment's tasks from the live subscription's first value, or null when it cannot be
 * read in time. Callers that delete data treat null as "might belong to a task".
 */
export async function readEnvironmentTasks(
  environmentId: EnvironmentId,
): Promise<ReadonlyArray<Task> | null> {
  const atom = tasksEnvironment.tasksLive({ environmentId, input: {} });
  // Not `suspendOnWaiting`: a live stream's values stay `waiting` while it runs.
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        yield* AtomRegistry.mount(appAtomRegistry, atom);
        return yield* AtomRegistry.getResult(appAtomRegistry, atom);
      }),
    ).pipe(Effect.timeout("10 seconds")),
  );
  return Exit.isSuccess(exit) ? exit.value.tasks : null;
}

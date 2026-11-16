import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  type Task,
  TaskId,
  type TaskWorktree,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import type { ActiveThreadListEntry } from "../orchestration-v2/ProjectionStore.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { branchMergeState } from "./taskCleanup.ts";
import * as TaskService from "./TaskService.ts";
import * as TaskStore from "./TaskStore.ts";

const p1 = ProjectId.make("p1");

const driverLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-task-cleanup-test-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const git = Effect.fn("taskCleanup.test.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  return (yield* driver.execute({ operation: "taskCleanup.test", cwd, args })).stdout.trim();
});

const tmpDir = Effect.fn("taskCleanup.test.tmpDir")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  // Git lists worktrees by their real path; macOS temp dirs sit behind a symlink.
  return yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-task-cleanup-" }),
  );
});

/** A repository on `main` with one commit. */
const makeRepo = Effect.fn("taskCleanup.test.makeRepo")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* tmpDir();
  yield* git(repo, ["init", "--initial-branch=main"]);
  yield* git(repo, ["config", "user.email", "test@test.com"]);
  yield* git(repo, ["config", "user.name", "Test"]);
  yield* git(repo, ["config", "maintenance.auto", "false"]);
  yield* fileSystem.writeFileString(path.join(repo, "README.md"), "# test\n");
  yield* git(repo, ["add", "."]);
  yield* git(repo, ["commit", "-m", "initial"]);
  return repo;
});

/** A linked worktree on a new branch from `main`. */
const addWorktree = Effect.fn("taskCleanup.test.addWorktree")(function* (
  repo: string,
  branch: string,
) {
  const path = yield* Path.Path;
  const worktreePath = path.join(yield* tmpDir(), "wt");
  yield* git(repo, ["worktree", "add", "-b", branch, worktreePath, "main"]);
  return worktreePath;
});

const commitFile = Effect.fn("taskCleanup.test.commitFile")(function* (cwd: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, "work.txt"), "work\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "work"]);
});

const shell = (id: string, worktreePath: string | null, branch: string | null) =>
  ({
    id: ThreadId.make(id),
    projectId: p1,
    worktreePath,
    branch,
    status: "idle",
    lastError: null,
    deletedAt: null,
    archivedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;

const worktree = (branch: string, worktreePath: string | null): TaskWorktree => ({
  projectId: p1,
  branch,
  baseRef: "origin/main",
  kind: "shared",
  worktreePath,
  removedAt: null,
  branchDeletedAt: null,
});

const seedTask = Effect.fn("taskCleanup.test.seedTask")(function* (
  worktrees: ReadonlyArray<TaskWorktree>,
  threadIds: ReadonlyArray<string> = [],
) {
  const store = yield* TaskStore.TaskStore;
  const task: Task = {
    id: TaskId.make("task:cleanup"),
    title: "Card pay",
    description: "",
    link: null,
    status: "done",
    primaryProjectId: p1,
    projectIds: [p1],
    worktrees,
    threadIds: threadIds.map((id) => ThreadId.make(id)),
    sortKey: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
  };
  yield* store.insert(task);
  return task;
});

/** Task services over a real repository; `shells` are every thread of the project. */
const tasksLayer = (repo: string, shells: ReadonlyArray<OrchestrationV2ThreadShell>) =>
  TaskService.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        TaskStore.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed(shells.find((candidate) => candidate.id === threadId) ?? null),
          listProjectThreads: () =>
            Effect.succeed(
              shells.map(
                (candidate) =>
                  ({ id: candidate.id, projectId: candidate.projectId }) as ActiveThreadListEntry,
              ),
            ),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ProjectService.ProjectService)({
          getById: (projectId) =>
            Effect.succeedSome({ id: projectId, workspaceRoot: repo } as Project),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          resolveDefaultBranchName: () => Effect.succeed("main"),
        }),
      ),
    ),
    Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
  );

const branchExists = (repo: string, branch: string) =>
  git(repo, ["branch", "--list", branch]).pipe(Effect.map((out) => out.length > 0));

it.live("branchMergeState counts commits the base does not have", () =>
  Effect.gen(function* () {
    const repo = yield* makeRepo();
    const worktreePath = yield* addWorktree(repo, "task/a");
    assert.deepStrictEqual(yield* branchMergeState(repo, "task/a", "main"), {
      exists: true,
      merged: true,
      unmergedCommitCount: 0,
    });
    yield* commitFile(worktreePath);
    assert.deepStrictEqual(yield* branchMergeState(repo, "task/a", "main"), {
      exists: true,
      merged: false,
      unmergedCommitCount: 1,
    });
    assert.strictEqual((yield* branchMergeState(repo, "task/none", "main")).exists, false);
  }).pipe(Effect.scoped, Effect.provide(driverLayer)),
);

it.live("cleanupPreview counts dirty files of a worktree whose path came late", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const repo = yield* makeRepo();
    const worktreePath = yield* addWorktree(repo, "task/a");
    yield* fileSystem.writeFileString(path.join(worktreePath, "README.md"), "# changed\n");
    yield* Effect.gen(function* () {
      const tasks = yield* TaskService.TaskService;
      // The path is still unknown in the task; its thread already has it.
      const task = yield* seedTask([worktree("task/a", null)], ["th-own"]);
      const preview = yield* tasks.cleanupPreview({ id: task.id });
      assert.deepStrictEqual(preview, {
        worktrees: [{ projectId: p1, path: worktreePath, branch: "task/a", dirtyFileCount: 1 }],
        branches: [{ projectId: p1, branch: "task/a", merged: true, unmergedCommitCount: 0 }],
      });
    }).pipe(Effect.provide(tasksLayer(repo, [shell("th-own", worktreePath, "task/a")])));
  }).pipe(Effect.scoped, Effect.provide(driverLayer)),
);

it.live("cleanup removes the worktree and its merged branch and marks both", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const repo = yield* makeRepo();
    const worktreePath = yield* addWorktree(repo, "task/a");
    yield* Effect.gen(function* () {
      const tasks = yield* TaskService.TaskService;
      const task = yield* seedTask([worktree("task/a", worktreePath)]);
      // Only the branch is selected: its worktree goes first, since Git needs that.
      const result = yield* tasks.cleanup({
        id: task.id,
        worktreePaths: [],
        branches: [{ projectId: p1, branch: "task/a", force: false }],
      });
      assert.strictEqual(result.removedWorktrees, 1);
      assert.strictEqual(result.deletedBranches, 1);
      const [record] = result.task.worktrees;
      assert.notStrictEqual(record?.removedAt, null);
      assert.notStrictEqual(record?.branchDeletedAt, null);
      assert.isFalse(yield* fileSystem.exists(worktreePath));
      assert.isFalse(yield* branchExists(repo, "task/a"));
      assert.deepStrictEqual(yield* tasks.cleanupPreview({ id: task.id }), {
        worktrees: [],
        branches: [],
      });
    }).pipe(Effect.provide(tasksLayer(repo, [])));
  }).pipe(Effect.scoped, Effect.provide(driverLayer)),
);

it.live("cleanup of a folder and a branch that are already gone succeeds and marks them", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const repo = yield* makeRepo();
    const gonePath = path.join(yield* tmpDir(), "gone");
    yield* Effect.gen(function* () {
      const tasks = yield* TaskService.TaskService;
      const task = yield* seedTask([worktree("task/gone", gonePath)]);
      const result = yield* tasks.cleanup({
        id: task.id,
        worktreePaths: [gonePath],
        branches: [{ projectId: p1, branch: "task/gone", force: false }],
      });
      assert.strictEqual(result.removedWorktrees, 1);
      assert.strictEqual(result.deletedBranches, 1);
      assert.notStrictEqual(result.task.worktrees[0]?.removedAt, null);
      assert.notStrictEqual(result.task.worktrees[0]?.branchDeletedAt, null);
    }).pipe(Effect.provide(tasksLayer(repo, [])));
  }).pipe(Effect.scoped, Effect.provide(driverLayer)),
);

it.live("cleanup leaves out and refuses what a thread outside the task uses", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const repo = yield* makeRepo();
    const ownPath = yield* addWorktree(repo, "task/a");
    const sharedPath = yield* addWorktree(repo, "task/b");
    yield* Effect.gen(function* () {
      const tasks = yield* TaskService.TaskService;
      const task = yield* seedTask(
        [worktree("task/a", ownPath), worktree("task/b", sharedPath)],
        ["th-own"],
      );
      const preview = yield* tasks.cleanupPreview({ id: task.id });
      assert.deepStrictEqual(
        preview.worktrees.map((entry) => entry.path),
        [ownPath],
      );
      assert.deepStrictEqual(
        preview.branches.map((entry) => entry.branch),
        ["task/a"],
      );
      const refusals = yield* Effect.all([
        tasks.cleanup({ id: task.id, worktreePaths: [sharedPath], branches: [] }).pipe(Effect.flip),
        tasks
          .cleanup({
            id: task.id,
            worktreePaths: [],
            branches: [{ projectId: p1, branch: "task/b", force: true }],
          })
          .pipe(Effect.flip),
        tasks.cleanup({ id: task.id, worktreePaths: [repo], branches: [] }).pipe(Effect.flip),
      ]);
      assert.deepStrictEqual(
        refusals.map((error) => error._tag),
        ["TaskError", "TaskError", "TaskError"],
      );
      assert.isTrue(yield* fileSystem.exists(sharedPath));
      assert.isTrue(yield* branchExists(repo, "task/b"));
    }).pipe(
      Effect.provide(
        tasksLayer(repo, [
          shell("th-own", ownPath, "task/a"),
          shell("th-outside", sharedPath, "task/b"),
        ]),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(driverLayer)),
);

it.live("cleanup refuses an unmerged branch without force and deletes it with force", () =>
  Effect.gen(function* () {
    const repo = yield* makeRepo();
    const worktreePath = yield* addWorktree(repo, "task/a");
    yield* commitFile(worktreePath);
    yield* Effect.gen(function* () {
      const tasks = yield* TaskService.TaskService;
      const task = yield* seedTask([worktree("task/a", worktreePath)]);
      const select = (force: boolean) =>
        tasks.cleanup({
          id: task.id,
          worktreePaths: [worktreePath],
          branches: [{ projectId: p1, branch: "task/a", force }],
        });
      const refused = yield* select(false).pipe(Effect.flip);
      assert.strictEqual(refused._tag, "TaskError");
      // A refusal is decided before anything is removed.
      assert.isTrue(yield* branchExists(repo, "task/a"));
      assert.isTrue(
        yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.exists(worktreePath))),
      );
      const result = yield* select(true);
      assert.strictEqual(result.deletedBranches, 1);
      assert.isFalse(yield* branchExists(repo, "task/a"));
    }).pipe(Effect.provide(tasksLayer(repo, [])));
  }).pipe(Effect.scoped, Effect.provide(driverLayer)),
);

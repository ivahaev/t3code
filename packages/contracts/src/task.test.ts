import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { TaskError, TaskStatus, TaskUpsertInput } from "./task.ts";

const decodeStatus = Schema.decodeUnknownSync(TaskStatus);
const decodeUpsert = Schema.decodeUnknownSync(TaskUpsertInput);
const encodeError = Schema.encodeSync(TaskError);
const decodeError = Schema.decodeUnknownSync(TaskError);

describe("task contracts", () => {
  it("accepts the four statuses and rejects others", () => {
    for (const status of ["backlog", "in_progress", "review", "done"]) {
      expect(decodeStatus(status)).toBe(status);
    }
    expect(() => decodeStatus("todo")).toThrow();
  });

  it("rejects an empty title", () => {
    expect(() =>
      decodeUpsert({
        title: "  ",
        description: "",
        link: null,
        primaryProjectId: "p1",
        projectIds: ["p1"],
      }),
    ).toThrow();
  });

  it("round-trips TaskError with a code", () => {
    const error = new TaskError({
      message: "busy",
      taskId: "t1" as never,
      code: "already_attached",
    });
    const encoded = encodeError(error);
    const decoded = decodeError(encoded);
    expect(decoded.code).toBe("already_attached");
    expect(decoded.message).toBe("busy");
  });
});

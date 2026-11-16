import type { Task } from "@t3tools/contracts";

import { resolveSidebarFolderDot } from "../Sidebar.logic";

export type TaskAttention = ReturnType<typeof resolveSidebarFolderDot>;

/** The most urgent state among a task's chats, using the same rule as a closed sidebar folder. */
export function taskAttention(
  threads: Parameters<typeof resolveSidebarFolderDot>[0],
): TaskAttention {
  return resolveSidebarFolderDot(threads);
}

export function taskAttentionLabel(attention: TaskAttention): {
  readonly glyph: "●" | "✕" | "⟳";
  readonly text: "вопрос" | "готово" | "ошибка" | "работает";
} | null {
  switch (attention) {
    case "attention":
      return { glyph: "●", text: "вопрос" };
    case "unread":
      return { glyph: "●", text: "готово" };
    case "failed":
      return { glyph: "✕", text: "ошибка" };
    case "working":
      return { glyph: "⟳", text: "работает" };
    case null:
      return null;
  }
}

/** Tasks that need the user (a question or an unseen result) come first, then board order. */
export function sortColumn(
  tasks: ReadonlyArray<Task>,
  attentionById: Readonly<Record<string, TaskAttention | undefined>>,
): Task[] {
  const flagged = (task: Task) => {
    const attention = attentionById[task.id];
    return attention === "attention" || attention === "unread";
  };
  return tasks.toSorted((a, b) => {
    const byFlag = Number(flagged(b)) - Number(flagged(a));
    return byFlag !== 0 ? byFlag : a.sortKey - b.sortKey;
  });
}

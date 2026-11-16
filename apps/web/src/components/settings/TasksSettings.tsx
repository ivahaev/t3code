import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, TaskCleanupMode } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { tasksEnvironment } from "~/state/tasks";
import { useAtomCommand } from "~/state/use-atom-command";
import { toastTaskCommandFailure } from "../tasks/taskCommandToast";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

const CLEANUP_MODE_LABEL: Record<TaskCleanupMode, string> = {
  ask: "Спрашивать",
  always: "Всегда",
  never: "Никогда",
};
const CLEANUP_MODES = ["ask", "always", "never"] as const satisfies ReadonlyArray<TaskCleanupMode>;

/** Task settings; each environment keeps its own, like its tasks. */
export function TasksSettingsPanel() {
  const { connectedEnvironments } = useSettingsScope();
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("task-cleanup-mode")} title="Задачи">
        {connectedEnvironments.length === 0 ? (
          <p className="px-3 py-2 text-sm text-muted-foreground sm:px-4">
            Нет подключённых environment.
          </p>
        ) : (
          connectedEnvironments.map((environment) => (
            <CleanupModeRow
              key={environment.environmentId}
              environmentId={environment.environmentId}
              environmentLabel={connectedEnvironments.length > 1 ? environment.label : null}
            />
          ))
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function CleanupModeRow({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string | null;
}) {
  const list = useAtomValue(tasksEnvironment.tasksLive({ environmentId, input: {} }));
  const mode = AsyncResult.getOrElse(list, () => null)?.settings.cleanupMode ?? null;
  const canWrite = useAtomValue(tasksEnvironment.setTaskCleanupMode.permissionAtom(environmentId));
  const setTaskCleanupMode = useAtomCommand(tasksEnvironment.setTaskCleanupMode, {
    label: "task set cleanup mode",
  });
  const change = async (next: TaskCleanupMode) => {
    const result = await setTaskCleanupMode({ environmentId, input: { mode: next } });
    toastTaskCommandFailure("Не удалось сохранить настройку уборки", result);
  };
  return (
    <SettingsRow
      title="Уборка при переходе в «Готово»"
      description={
        <>
          Убирать ли worktree и локальные ветки задачи, когда она переходит в «Готово». «Всегда»
          молча убирает только чистые worktree и слитые ветки, об остальном спросит.
          {environmentLabel === null ? null : ` Environment: ${environmentLabel}.`}
        </>
      }
      control={
        <Select
          value={mode}
          onValueChange={(value) => {
            if (value !== null && value !== mode) void change(value);
          }}
        >
          <SelectTrigger
            size="sm"
            className="w-full sm:w-40"
            aria-label="Уборка при переходе в «Готово»"
            disabled={mode === null || !canWrite}
          >
            <SelectValue>{mode === null ? "Загрузка…" : CLEANUP_MODE_LABEL[mode]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {CLEANUP_MODES.map((option) => (
              <SelectItem hideIndicator key={option} value={option}>
                {CLEANUP_MODE_LABEL[option]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

import type { CodeViewDiffItem } from "@pierre/diffs";
import type { ReviewDiffPreviewSource, TaskWorktree } from "@t3tools/contracts";

import { GitBranchIcon, RefreshCwIcon } from "lucide-react";

import { useClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import {
  buildFileDiffEntries,
  getRenderablePatch,
  resolveDiffThemeName,
  type RenderablePatch,
} from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { DiffStatLabel } from "../chat/DiffStatLabel";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { plural } from "./taskCleanup.logic";
import { worktreeDiffStat, type WorktreeDiffState } from "./taskDetail.logic";

/** One task worktree with its two previews: commits since the base, then uncommitted work. */
export interface TaskWorktreeDiff extends WorktreeDiffState {
  readonly key: string;
  readonly projectTitle: string;
  readonly worktree: TaskWorktree;
}

// The task page re-renders on every thread update; a source's patch is parsed once per theme.
const parsedSources = new WeakMap<ReviewDiffPreviewSource, Map<string, RenderablePatch | null>>();

function parseSource(source: ReviewDiffPreviewSource, cacheKey: string): RenderablePatch | null {
  let parses = parsedSources.get(source);
  if (parses === undefined) parsedSources.set(source, (parses = new Map()));
  if (!parses.has(cacheKey)) {
    parses.set(
      cacheKey,
      getRenderablePatch(source.diff, cacheKey, { compactPartialHunkOffsets: true }),
    );
  }
  return parses.get(cacheKey) ?? null;
}

interface FileLabel {
  readonly projectTitle: string;
  readonly branch: string;
  readonly uncommitted: boolean;
}

/** The task's code: every live worktree's changes in one diff view, repository by repository. */
export function TaskCodeTab({
  diffs,
  unavailable,
  onRefresh,
}: {
  readonly diffs: ReadonlyArray<TaskWorktreeDiff>;
  /** Why this connection shows no diffs, such as missing file access. */
  readonly unavailable: string | null;
  readonly onRefresh: () => void;
}) {
  const resolvedTheme = useRenderedAppearance();
  const diffLayout = useClientSettings((settings) => settings.diffLayout);
  const labels = new Map<string, FileLabel>();
  const items: CodeViewDiffItem<undefined>[] = [];
  const truncated: string[] = [];
  const unparsed: string[] = [];
  for (const diff of diffs) {
    const sources = [diff.branch, diff.workingTree].flatMap(
      (preview): ReviewDiffPreviewSource[] => preview?.sources.slice() ?? [],
    );
    for (const source of sources) {
      if (source.truncated) truncated.push(`${diff.projectTitle} · ${diff.worktree.branch}`);
      const patch = parseSource(source, `task-code:${diff.key}:${resolvedTheme}`);
      if (patch?.kind !== "files") {
        // An unreadable patch is named instead of vanishing from the list.
        if (patch !== null) {
          const files = source.files?.length;
          unparsed.push(
            `${diff.projectTitle} · ${diff.worktree.branch}${files ? ` (${files} ${plural(files, "file", "files")})` : ""}`,
          );
        }
        continue;
      }
      for (const { fileDiff, fileKey, fileVersion } of buildFileDiffEntries(patch.files)) {
        const id = `${diff.key}\n${source.kind}\n${fileKey}`;
        labels.set(id, {
          projectTitle: diff.projectTitle,
          branch: diff.worktree.branch,
          uncommitted: source.kind === "working-tree",
        });
        items.push({ id, type: "diff", fileDiff, version: fileVersion });
      }
    }
  }

  const summary = (
    <div className="flex items-start gap-2 border-b px-(--workspace-gutter-start) py-2 text-sm">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {diffs.map((diff) => {
          const stat = worktreeDiffStat([diff.branch, diff.workingTree]);
          return (
            <div key={diff.key} className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 font-medium">{diff.projectTitle}</span>
              <GitBranchIcon className="size-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate text-xs text-muted-foreground">
                {diff.worktree.branch}
              </span>
              {diff.errors.map((error) => (
                <span key={error} className="min-w-0 truncate text-xs text-destructive-foreground">
                  {error}
                </span>
              ))}
              {stat !== null ? (
                <DiffStatLabel
                  additions={stat.additions}
                  deletions={stat.deletions}
                  layout="inline"
                  className="ms-auto text-xs"
                />
              ) : diff.errors.length === 0 ? (
                <span className="text-xs text-muted-foreground">Loading…</span>
              ) : null}
            </div>
          );
        })}
        {truncated.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Diff too large, shown in part: {[...new Set(truncated)].join(", ")}
          </p>
        ) : null}
        {unparsed.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            Couldn't show the diff: {unparsed.join(", ")}
          </p>
        ) : null}
      </div>
      <Button size="icon-xs" variant="ghost" aria-label="Refresh diff" onClick={onRefresh}>
        <RefreshCwIcon />
      </Button>
    </div>
  );

  if (unavailable !== null) {
    return (
      <p className="px-(--workspace-gutter-start) py-6 text-sm text-muted-foreground">
        {unavailable}
      </p>
    );
  }
  if (diffs.length === 0) {
    return (
      <p className="px-(--workspace-gutter-start) py-6 text-sm text-muted-foreground">
        The task has no worktrees with changes.
      </p>
    );
  }
  const loaded = diffs.every((diff) => !diff.pending);
  if (items.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {summary}
        <p className="px-(--workspace-gutter-start) py-6 text-sm text-muted-foreground">
          {loaded ? "No changes." : "Loading changes…"}
        </p>
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <StyledDiffCodeView
        className="h-full min-h-0 overflow-auto"
        items={items}
        renderCodeViewHeader={() => summary}
        renderHeaderPrefix={(item) => {
          const label = labels.get(item.id);
          if (label === undefined) return null;
          return (
            <span className="flex shrink-0 items-center gap-1 pe-1 text-muted-foreground">
              <span>{label.projectTitle}</span>
              <span className="font-mono">{label.branch}</span>
              {label.uncommitted ? (
                <Badge variant="outline" size="sm">
                  Uncommitted
                </Badge>
              ) : null}
            </span>
          );
        }}
        options={{
          diffStyle: diffLayout === "split" ? "split" : "unified",
          lineDiffType: "none",
          overflow: "scroll",
          theme: resolveDiffThemeName(resolvedTheme),
          themeType: resolvedTheme,
          preferredHighlighter: PREFERRED_HIGHLIGHTER,
          stickyHeaders: true,
        }}
      />
    </div>
  );
}

import { describe, expect, it } from "@effect/vitest";

import { formatTaskPrompt, taskBranchName } from "./taskBranch.ts";

describe("taskBranchName", () => {
  it("transliterates Cyrillic by GOST 7.79-2000 scheme B", () => {
    expect(taskBranchName("Оплата картой", new Set())).toBe("task/oplata-kartoj");
  });

  it("lowercases and turns other characters into single dashes", () => {
    expect(taskBranchName("Fix: API v2!!", new Set())).toBe("task/fix-api-v2");
  });

  it("adds a numeric suffix when the name is taken", () => {
    expect(taskBranchName("Оплата картой", new Set(["task/oplata-kartoj"]))).toBe(
      "task/oplata-kartoj-2",
    );
    expect(
      taskBranchName("Оплата картой", new Set(["task/oplata-kartoj", "task/oplata-kartoj-2"])),
    ).toBe("task/oplata-kartoj-3");
  });

  it("falls back to task/untitled", () => {
    expect(taskBranchName("!!!", new Set())).toBe("task/untitled");
  });

  it("keeps the slug within 40 characters, cut at a dash", () => {
    const name = taskBranchName("a ".repeat(100), new Set());
    expect(name.length).toBeLessThanOrEqual("task/".length + 40);
    expect(name).toMatch(/^task\/a(-a)*$/);
  });
});

describe("formatTaskPrompt", () => {
  it("puts the title first, then the description and the link", () => {
    expect(
      formatTaskPrompt({ title: "Оплата", description: "Сделать оплату", link: "https://x/1" }),
    ).toBe("Оплата\n\nСделать оплату\n\nСсылка: https://x/1");
  });

  it("omits an empty description and a missing link", () => {
    expect(formatTaskPrompt({ title: "Оплата", description: "  ", link: null })).toBe("Оплата");
  });
});

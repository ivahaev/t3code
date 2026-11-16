import type { Task } from "@t3tools/contracts";

const BRANCH_PREFIX = "task/";
const MAX_SLUG_LENGTH = 40;

// GOST 7.79-2000, scheme B. The marks it writes for ъ, ь, ы and э (` and ') are left out:
// a slug turns them into dashes, which would split words.
const CYRILLIC: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "zh",
  з: "z",
  и: "i",
  й: "j",
  і: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "x",
  ч: "ch",
  ш: "sh",
  щ: "shh",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

const transliterate = (text: string): string => {
  const chars = Array.from(text.toLowerCase());
  return chars
    .map((char, index) => {
      if (char !== "ц") return CYRILLIC[char] ?? char;
      // Scheme B writes ц as c before i, e, y and j, and as cz elsewhere.
      const next = chars[index + 1];
      const nextLatin = next === undefined ? "" : (CYRILLIC[next] ?? next);
      return /^[eijy]/.test(nextLatin) ? "c" : "cz";
    })
    .join("");
};

const slugify = (title: string): string => {
  const slug = transliterate(title)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length <= MAX_SLUG_LENGTH) return slug;
  const cut = slug.slice(0, MAX_SLUG_LENGTH);
  // Cut at the last dash, so no word is broken, unless the first word alone is too long.
  const lastDash = slug[MAX_SLUG_LENGTH] === "-" ? MAX_SLUG_LENGTH : cut.lastIndexOf("-");
  return (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/, "");
};

/** `task/<slug of the title>`, with `-2`, `-3`, … when the name is taken. */
export const taskBranchName = (title: string, taken: ReadonlySet<string>): string => {
  const slug = slugify(title);
  const base = slug === "" ? `${BRANCH_PREFIX}untitled` : `${BRANCH_PREFIX}${slug}`;
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/** The first message of a task thread: title, description, then the link. */
export const formatTaskPrompt = (task: Pick<Task, "title" | "description" | "link">): string =>
  [
    task.title,
    task.description.trim(),
    task.link === null || task.link.trim() === "" ? "" : `Ссылка: ${task.link.trim()}`,
  ]
    .filter((part) => part !== "")
    .join("\n\n");

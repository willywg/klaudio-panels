export type FileStatusKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

export type FileStatus = {
  path: string;
  kind: FileStatusKind;
  staged: boolean;
  adds: number;
  dels: number;
  is_binary: boolean;
};

export type GitSummary = {
  file_count: number;
  adds: number;
  dels: number;
  branch: string | null;
};

export type DiffPayload = {
  path: string;
  old_contents: string | null;
  new_contents: string | null;
  is_binary: boolean;
  too_large: boolean;
};

export const BADGE_LETTER: Record<FileStatusKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  untracked: "?",
  conflicted: "U",
};

export const BADGE_COLOR: Record<FileStatusKind, string> = {
  added: "text-emerald-400",
  modified: "text-amber-400",
  deleted: "text-rose-400",
  renamed: "text-violet-400",
  untracked: "text-sky-400",
  conflicted: "text-red-500",
};

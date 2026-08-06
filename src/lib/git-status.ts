export type FileStatusKind =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

export type FileStatus = {
  /** Project-relative, submodule prefix included (`backend/app/user.rb`). */
  path: string;
  /** Owning repo as a project-relative path; `""` for the project itself. */
  repo: string;
  kind: FileStatusKind;
  staged: boolean;
  adds: number;
  dels: number;
  is_binary: boolean;
};

/** A repo contributing to the status: the project plus any nested repo
 *  (submodule or checked-in clone) the scan descended into. */
export type RepoInfo = {
  path: string;
  /** Branch name, or `detached @ <short sha>`. */
  branch: string | null;
};

export type StatusPayload = {
  files: FileStatus[];
  repos: RepoInfo[];
  summary: GitSummary;
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

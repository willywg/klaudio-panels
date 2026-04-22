import {
  Binary,
  BookOpen,
  Braces,
  Container,
  Database,
  File,
  FileArchive,
  FileCode2,
  FileCog,
  FileImage,
  FileJson2,
  FileLock2,
  FileText,
  FileType,
  GitBranch,
  Hammer,
  Key,
  Package,
  Scale,
  SlidersHorizontal,
  Terminal,
} from "lucide-solid";

type LucideIcon = typeof File;

export type FileIconEntry = {
  Icon: LucideIcon;
  /** Tailwind text color class; applied on the icon element. */
  color: string;
};

const DEFAULT: FileIconEntry = { Icon: File, color: "text-neutral-500" };

/** Match by full lowercased filename — takes precedence over extension. */
const BY_NAME: Record<string, FileIconEntry> = {
  "dockerfile": { Icon: Container, color: "text-sky-400" },
  ".dockerignore": { Icon: Container, color: "text-sky-500" },
  "makefile": { Icon: Hammer, color: "text-red-400" },
  "gnumakefile": { Icon: Hammer, color: "text-red-400" },
  ".gitignore": { Icon: GitBranch, color: "text-orange-400" },
  ".gitattributes": { Icon: GitBranch, color: "text-orange-400" },
  ".gitmodules": { Icon: GitBranch, color: "text-orange-400" },
  ".editorconfig": { Icon: FileCog, color: "text-neutral-400" },
  ".prettierrc": { Icon: FileCog, color: "text-amber-300" },
  ".eslintrc": { Icon: FileCog, color: "text-indigo-400" },
  "license": { Icon: Scale, color: "text-neutral-400" },
  "license.md": { Icon: Scale, color: "text-neutral-400" },
  "license.txt": { Icon: Scale, color: "text-neutral-400" },
  "package.json": { Icon: Package, color: "text-red-400" },
  "package-lock.json": { Icon: FileLock2, color: "text-neutral-500" },
  "bun.lock": { Icon: FileLock2, color: "text-pink-300" },
  "bun.lockb": { Icon: FileLock2, color: "text-pink-300" },
  "yarn.lock": { Icon: FileLock2, color: "text-cyan-300" },
  "pnpm-lock.yaml": { Icon: FileLock2, color: "text-amber-400" },
  "cargo.lock": { Icon: FileLock2, color: "text-orange-400" },
  "cargo.toml": { Icon: Package, color: "text-orange-400" },
  "pyproject.toml": { Icon: Package, color: "text-yellow-300" },
  "uv.lock": { Icon: FileLock2, color: "text-yellow-300" },
  "poetry.lock": { Icon: FileLock2, color: "text-yellow-300" },
  "requirements.txt": { Icon: Package, color: "text-yellow-300" },
  "tsconfig.json": { Icon: FileCog, color: "text-blue-400" },
  "tsconfig.node.json": { Icon: FileCog, color: "text-blue-400" },
  "vite.config.ts": { Icon: FileCog, color: "text-violet-400" },
  "vite.config.js": { Icon: FileCog, color: "text-violet-400" },
  "tauri.conf.json": { Icon: FileCog, color: "text-amber-400" },
};

/** Match by extension (with leading dot, lowercase). */
const BY_EXT: Record<string, FileIconEntry> = {
  // TypeScript / JavaScript
  ".ts": { Icon: FileCode2, color: "text-blue-400" },
  ".tsx": { Icon: FileCode2, color: "text-blue-400" },
  ".mts": { Icon: FileCode2, color: "text-blue-400" },
  ".cts": { Icon: FileCode2, color: "text-blue-400" },
  ".d.ts": { Icon: FileCode2, color: "text-blue-300" },
  ".js": { Icon: FileCode2, color: "text-yellow-400" },
  ".jsx": { Icon: FileCode2, color: "text-yellow-400" },
  ".mjs": { Icon: FileCode2, color: "text-yellow-400" },
  ".cjs": { Icon: FileCode2, color: "text-yellow-400" },

  // Systems / compiled languages
  ".rs": { Icon: FileCode2, color: "text-orange-400" },
  ".go": { Icon: FileCode2, color: "text-cyan-400" },
  ".c": { Icon: FileCode2, color: "text-blue-300" },
  ".h": { Icon: FileCode2, color: "text-blue-300" },
  ".cpp": { Icon: FileCode2, color: "text-blue-300" },
  ".hpp": { Icon: FileCode2, color: "text-blue-300" },
  ".java": { Icon: FileCode2, color: "text-red-400" },
  ".kt": { Icon: FileCode2, color: "text-purple-400" },
  ".swift": { Icon: FileCode2, color: "text-orange-400" },

  // Scripting
  ".py": { Icon: FileCode2, color: "text-yellow-300" },
  ".rb": { Icon: FileCode2, color: "text-red-400" },
  ".php": { Icon: FileCode2, color: "text-purple-400" },
  ".lua": { Icon: FileCode2, color: "text-indigo-300" },
  ".sh": { Icon: Terminal, color: "text-green-400" },
  ".bash": { Icon: Terminal, color: "text-green-400" },
  ".zsh": { Icon: Terminal, color: "text-green-400" },
  ".fish": { Icon: Terminal, color: "text-green-400" },

  // Web
  ".html": { Icon: FileCode2, color: "text-orange-400" },
  ".css": { Icon: FileCode2, color: "text-sky-400" },
  ".scss": { Icon: FileCode2, color: "text-pink-400" },
  ".sass": { Icon: FileCode2, color: "text-pink-400" },
  ".vue": { Icon: FileCode2, color: "text-green-400" },
  ".svelte": { Icon: FileCode2, color: "text-orange-400" },

  // Data / config
  ".json": { Icon: FileJson2, color: "text-amber-300" },
  ".jsonc": { Icon: FileJson2, color: "text-amber-300" },
  ".yaml": { Icon: Braces, color: "text-red-300" },
  ".yml": { Icon: Braces, color: "text-red-300" },
  ".toml": { Icon: Braces, color: "text-amber-400" },
  ".ini": { Icon: FileCog, color: "text-neutral-400" },
  ".cfg": { Icon: FileCog, color: "text-neutral-400" },
  ".conf": { Icon: FileCog, color: "text-neutral-400" },
  ".xml": { Icon: FileCode2, color: "text-orange-300" },

  // Env / secrets
  ".env": { Icon: SlidersHorizontal, color: "text-amber-400" },
  ".pem": { Icon: Key, color: "text-yellow-400" },
  ".key": { Icon: Key, color: "text-yellow-400" },
  ".crt": { Icon: Key, color: "text-yellow-400" },

  // Lock files
  ".lock": { Icon: FileLock2, color: "text-neutral-500" },
  ".lockb": { Icon: FileLock2, color: "text-pink-300" },

  // Docs / markup
  ".md": { Icon: FileText, color: "text-sky-400" },
  ".mdx": { Icon: FileText, color: "text-sky-400" },
  ".rst": { Icon: FileText, color: "text-sky-300" },
  ".txt": { Icon: FileText, color: "text-neutral-400" },
  ".pdf": { Icon: FileType, color: "text-red-400" },

  // Images
  ".png": { Icon: FileImage, color: "text-violet-400" },
  ".jpg": { Icon: FileImage, color: "text-violet-400" },
  ".jpeg": { Icon: FileImage, color: "text-violet-400" },
  ".gif": { Icon: FileImage, color: "text-violet-400" },
  ".webp": { Icon: FileImage, color: "text-violet-400" },
  ".bmp": { Icon: FileImage, color: "text-violet-400" },
  ".ico": { Icon: FileImage, color: "text-violet-300" },
  ".svg": { Icon: FileImage, color: "text-green-400" },

  // Archives / binaries
  ".zip": { Icon: FileArchive, color: "text-amber-400" },
  ".tar": { Icon: FileArchive, color: "text-amber-400" },
  ".gz": { Icon: FileArchive, color: "text-amber-400" },
  ".tgz": { Icon: FileArchive, color: "text-amber-400" },
  ".bz2": { Icon: FileArchive, color: "text-amber-400" },
  ".7z": { Icon: FileArchive, color: "text-amber-400" },
  ".rar": { Icon: FileArchive, color: "text-amber-400" },
  ".wasm": { Icon: Binary, color: "text-purple-400" },
  ".so": { Icon: Binary, color: "text-purple-400" },
  ".dylib": { Icon: Binary, color: "text-purple-400" },
  ".dll": { Icon: Binary, color: "text-purple-400" },

  // Databases
  ".sqlite": { Icon: Database, color: "text-blue-400" },
  ".db": { Icon: Database, color: "text-blue-400" },
  ".sql": { Icon: Database, color: "text-pink-300" },
};

export function iconForFile(name: string): FileIconEntry {
  const lower = name.toLowerCase();

  if (BY_NAME[lower]) return BY_NAME[lower];

  // `.env`, `.env.local`, `.env.production`, ...
  if (lower === ".env" || lower.startsWith(".env.")) return BY_EXT[".env"];

  // `README`, `README.md`, `README.rst` all get the book icon.
  if (lower === "readme" || lower.startsWith("readme.")) {
    return { Icon: BookOpen, color: "text-sky-400" };
  }

  // `.d.ts` is a compound extension — check before the single-dot path.
  if (lower.endsWith(".d.ts")) return BY_EXT[".d.ts"];

  const dot = name.lastIndexOf(".");
  if (dot <= 0) return DEFAULT;

  const ext = lower.slice(dot);
  return BY_EXT[ext] ?? DEFAULT;
}

import { File, FileCode2, FileCog, FileImage, FileText } from "lucide-solid";

type LucideIcon = typeof File;

export function iconForFile(name: string): LucideIcon {
  const dot = name.lastIndexOf(".");
  if (dot < 0) return File;
  const ext = name.slice(dot).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
    case ".rs":
    case ".go":
    case ".py":
    case ".rb":
    case ".swift":
    case ".sh":
    case ".bash":
    case ".zsh":
      return FileCode2;
    case ".md":
    case ".mdx":
    case ".txt":
    case ".rst":
      return FileText;
    case ".json":
    case ".toml":
    case ".yaml":
    case ".yml":
    case ".ini":
    case ".env":
      return FileCog;
    case ".png":
    case ".jpg":
    case ".jpeg":
    case ".svg":
    case ".gif":
    case ".webp":
    case ".ico":
      return FileImage;
    default:
      return File;
  }
}

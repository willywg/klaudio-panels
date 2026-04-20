import type { HighlighterCore } from "shiki/core";

/** Ultra-lazy Shiki loader. The bundled parsed JS weighs ~1.5MB so we only
 *  trigger the dynamic import the first time a preview tab mounts, and keep a
 *  single HighlighterCore instance alive for the rest of the session. */
let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLangs = new Set<string>();
let allLangs: Record<string, () => Promise<unknown>> = {};

async function createHighlighter(): Promise<HighlighterCore> {
  const [{ createHighlighterCore }, { createOnigurumaEngine }, langs, themes] =
    await Promise.all([
      import("shiki/core"),
      import("shiki/engine/oniguruma"),
      import("shiki/langs"),
      import("shiki/themes"),
    ]);
  allLangs = langs.bundledLanguages as unknown as Record<string, () => Promise<unknown>>;
  const engine = createOnigurumaEngine(import("shiki/wasm"));
  return createHighlighterCore({
    themes: [themes.bundledThemes["github-dark-default"]],
    langs: [],
    engine,
  });
}

export async function ensureHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) highlighterPromise = createHighlighter();
  return highlighterPromise;
}

export async function ensureLangLoaded(
  hl: HighlighterCore,
  lang: string,
): Promise<boolean> {
  if (loadedLangs.has(lang)) return true;
  const loader = allLangs[lang];
  if (!loader) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await hl.loadLanguage((loader as any));
    loadedLangs.add(lang);
    return true;
  } catch (err) {
    console.warn("shiki loadLanguage failed", lang, err);
    return false;
  }
}

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  md: "markdown",
  mdx: "mdx",
  css: "css",
  scss: "scss",
  html: "html",
  svg: "xml",
  xml: "xml",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  rs: "rust",
  go: "go",
  py: "python",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "docker",
  vue: "vue",
  svelte: "svelte",
  astro: "astro",
};

export function detectLangFromPath(rel: string): string {
  const lower = rel.toLowerCase();
  if (lower.endsWith("dockerfile")) return "docker";
  if (lower.endsWith("/makefile") || lower === "makefile") return "makefile";
  const lastDot = lower.lastIndexOf(".");
  if (lastDot === -1) return "text";
  const ext = lower.slice(lastDot + 1);
  return EXT_TO_LANG[ext] ?? "text";
}

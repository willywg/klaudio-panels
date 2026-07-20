import { Marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import { ensureHighlighter, ensureLangLoaded } from "@/lib/shiki-singleton";

/** Markdown → sanitized HTML for the preview's Rendered mode. Code fences
 *  go through the shared Shiki highlighter; `walkTokens` (async) preloads
 *  every fence language first so the renderer can call the sync
 *  `codeToHtml` — marked renderers themselves can't await. DOMPurify keeps
 *  Shiki's inline `style` colors but strips scripts/handlers, so untrusted
 *  README content can't run in the webview. */
export async function renderMarkdown(src: string): Promise<string> {
  const hl = await ensureHighlighter();
  const okLangs = new Set<string>();

  const marked = new Marked({ async: true, gfm: true, breaks: false });
  marked.use({
    walkTokens: async (token) => {
      if (token.type !== "code") return;
      const lang = (token as Tokens.Code).lang?.split(/\s+/)[0] ?? "";
      if (lang && (await ensureLangLoaded(hl, lang))) okLangs.add(lang);
    },
    renderer: {
      code(token: Tokens.Code) {
        const lang = token.lang?.split(/\s+/)[0] ?? "";
        const effective = lang && okLangs.has(lang) ? lang : "text";
        return hl.codeToHtml(token.text, {
          lang: effective,
          theme: "github-dark-default",
        });
      },
    },
  });

  const html = await marked.parse(src);
  return DOMPurify.sanitize(html);
}

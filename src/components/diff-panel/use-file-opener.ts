import { useDiffPanel, tabKey } from "@/context/diff-panel";
import { useEditorPty } from "@/context/editor-pty";
import { useOpenIn } from "@/context/open-in";
import { focusTerminal } from "@/lib/terminal-focus-bus";
import { isAbsoluteish } from "@/lib/resolve-file";
import type { OpenInApp } from "@/lib/open-in";

/** "Open this file in X" for a project-relative path, shared by the tab
 *  strip's context menu and the diff rows' fallback actions.
 *
 *  Terminal editors (nvim, helix…) become an editor tab backed by a PTY and
 *  are deduped against an already-open tab for the same file; everything else
 *  is handed to the OS. Call during component setup — it reads contexts.
 */
export function createFileOpener(projectPath: () => string) {
  const panel = useDiffPanel();
  const openIn = useOpenIn();
  const editorPty = useEditorPty();

  function absFor(rel: string): string {
    // A preview tab can hold a path outside the project (#85); joining it
    // onto the root would hand Finder or nvim a path that doesn't exist.
    if (isAbsoluteish(rel)) return rel;
    const p = projectPath();
    const base = p.endsWith("/") ? p.slice(0, -1) : p;
    return `${base}/${rel}`;
  }

  function openWith(app: OpenInApp, rel: string) {
    if (!app.terminalEditor) {
      void openIn.openPath(absFor(rel), app.id);
      return;
    }
    openIn.setDefaultEditor(app.id);
    const existing = panel.findEditorTabKey(
      projectPath(),
      app.terminalEditor,
      rel,
    );
    if (existing) {
      panel.setActiveTab(projectPath(), existing);
      panel.openPanel(projectPath());
      const existingTab = panel
        .tabsFor(projectPath())
        .find((t) => tabKey(t) === existing);
      if (existingTab && existingTab.kind === "editor") {
        focusTerminal(existingTab.ptyId);
      }
      return;
    }
    try {
      const editorId = app.terminalEditor;
      const ptyId = editorPty.openEditor(
        projectPath(),
        absFor(rel),
        rel,
        editorId,
      );
      panel.addEditorTab(projectPath(), editorId, rel, ptyId);
      // User-action focus: explicit "Open in <editor>" — queue focus so the
      // keystroke they make next lands in the editor PTY, not the file tree
      // or wherever they triggered this from.
      focusTerminal(ptyId);
    } catch (err) {
      console.warn("openEditor failed", err);
    }
  }

  return { absFor, openWith };
}

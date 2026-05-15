import type { Extension } from "@codemirror/state";
import type { HighlightStyle } from "@codemirror/language";

type CMCore = {
  EditorState: typeof import("@codemirror/state").EditorState;
  EditorView: typeof import("@codemirror/view").EditorView;
  keymap: typeof import("@codemirror/view").keymap;
  highlightActiveLine: typeof import("@codemirror/view").highlightActiveLine;
  lineNumbers: typeof import("@codemirror/view").lineNumbers;
  drawSelection: typeof import("@codemirror/view").drawSelection;
  dropCursor: typeof import("@codemirror/view").dropCursor;
  highlightActiveLineGutter: typeof import("@codemirror/view").highlightActiveLineGutter;
  defaultKeymap: typeof import("@codemirror/commands").defaultKeymap;
  history: typeof import("@codemirror/commands").history;
  historyKeymap: typeof import("@codemirror/commands").historyKeymap;
  indentWithTab: typeof import("@codemirror/commands").indentWithTab;
  bracketMatching: typeof import("@codemirror/language").bracketMatching;
  indentOnInput: typeof import("@codemirror/language").indentOnInput;
  syntaxHighlighting: typeof import("@codemirror/language").syntaxHighlighting;
  klaudioHighlightStyle: HighlightStyle;
};

let core: Promise<CMCore> | null = null;

export function loadCMCore(): Promise<CMCore> {
  if (!core) {
    core = (async () => {
      const [state, view, commands, language, lezer] = await Promise.all([
        import("@codemirror/state"),
        import("@codemirror/view"),
        import("@codemirror/commands"),
        import("@codemirror/language"),
        import("@lezer/highlight"),
      ]);
      const t = lezer.tags;
      // Approximate Shiki's `github-dark-default` palette so the inline
      // editor matches `<FilePreview>`. lezer collapses TextMate scope info
      // into a small set of tags, so a few choices diverge from the source
      // theme — propertyName=green keeps YAML keys visually consistent with
      // the preview (the most common file kind we see this in), at the cost
      // of JS object access also being green-tinted.
      const klaudioHighlightStyle = language.HighlightStyle.define([
        { tag: t.comment, color: "#8b949e", fontStyle: "italic" },
        { tag: t.lineComment, color: "#8b949e", fontStyle: "italic" },
        { tag: t.blockComment, color: "#8b949e", fontStyle: "italic" },
        { tag: t.docComment, color: "#8b949e", fontStyle: "italic" },
        { tag: t.string, color: "#a5d6ff" },
        { tag: t.special(t.string), color: "#a5d6ff" },
        { tag: t.regexp, color: "#a5d6ff" },
        { tag: t.escape, color: "#a5d6ff" },
        { tag: t.url, color: "#a5d6ff" },
        { tag: t.link, color: "#a5d6ff", textDecoration: "underline" },
        { tag: t.number, color: "#79c0ff" },
        { tag: t.integer, color: "#79c0ff" },
        { tag: t.float, color: "#79c0ff" },
        { tag: t.bool, color: "#79c0ff" },
        { tag: t.atom, color: "#79c0ff" },
        { tag: t.null, color: "#79c0ff" },
        { tag: t.keyword, color: "#ff7b72" },
        { tag: t.controlKeyword, color: "#ff7b72" },
        { tag: t.operatorKeyword, color: "#ff7b72" },
        { tag: t.modifier, color: "#ff7b72" },
        { tag: t.moduleKeyword, color: "#ff7b72" },
        { tag: t.definitionKeyword, color: "#ff7b72" },
        { tag: t.self, color: "#ff7b72" },
        { tag: t.propertyName, color: "#7ee787" },
        { tag: t.attributeName, color: "#7ee787" },
        { tag: t.attributeValue, color: "#a5d6ff" },
        { tag: t.tagName, color: "#7ee787" },
        { tag: t.function(t.variableName), color: "#d2a8ff" },
        { tag: t.function(t.definition(t.variableName)), color: "#d2a8ff" },
        { tag: t.definition(t.variableName), color: "#d2a8ff" },
        { tag: t.typeName, color: "#ffa657" },
        { tag: t.className, color: "#ffa657" },
        { tag: t.namespace, color: "#ffa657" },
        { tag: t.labelName, color: "#ffa657" },
        { tag: t.heading, color: "#79c0ff", fontWeight: "bold" },
        { tag: t.heading1, color: "#79c0ff", fontWeight: "bold" },
        { tag: t.heading2, color: "#79c0ff", fontWeight: "bold" },
        { tag: t.heading3, color: "#79c0ff", fontWeight: "bold" },
        { tag: t.heading4, color: "#79c0ff", fontWeight: "bold" },
        { tag: t.heading5, color: "#79c0ff", fontWeight: "bold" },
        { tag: t.heading6, color: "#79c0ff", fontWeight: "bold" },
        { tag: t.strong, fontWeight: "bold" },
        { tag: t.emphasis, fontStyle: "italic" },
        { tag: t.invalid, color: "#ffa198" },
        { tag: t.meta, color: "#79c0ff" },
      ]);
      return {
        EditorState: state.EditorState,
        EditorView: view.EditorView,
        keymap: view.keymap,
        highlightActiveLine: view.highlightActiveLine,
        lineNumbers: view.lineNumbers,
        drawSelection: view.drawSelection,
        dropCursor: view.dropCursor,
        highlightActiveLineGutter: view.highlightActiveLineGutter,
        defaultKeymap: commands.defaultKeymap,
        history: commands.history,
        historyKeymap: commands.historyKeymap,
        indentWithTab: commands.indentWithTab,
        bracketMatching: language.bracketMatching,
        indentOnInput: language.indentOnInput,
        syntaxHighlighting: language.syntaxHighlighting,
        klaudioHighlightStyle,
      };
    })();
  }
  return core;
}

/** Build the shared `Extension[]` every editor mounts with — line numbers,
 *  history, indent, bracket-matching, the dark theme, and the `onSave` /
 *  doc-change keymap. Caller layers on the language extension separately. */
export function baseExtensions(
  cm: CMCore,
  opts: {
    onSave: () => void;
    onDocChanged: (doc: string) => void;
  },
): Extension[] {
  return [
    cm.lineNumbers(),
    cm.highlightActiveLineGutter(),
    cm.history(),
    cm.drawSelection(),
    cm.dropCursor(),
    cm.indentOnInput(),
    cm.bracketMatching(),
    cm.syntaxHighlighting(cm.klaudioHighlightStyle, { fallback: true }),
    cm.highlightActiveLine(),
    cm.keymap.of([
      {
        key: "Mod-s",
        preventDefault: true,
        run: () => {
          opts.onSave();
          return true;
        },
      },
      cm.indentWithTab,
      ...cm.historyKeymap,
      ...cm.defaultKeymap,
    ]),
    cm.EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        opts.onDocChanged(update.state.doc.toString());
      }
    }),
    cm.EditorView.theme(
      {
        "&": {
          height: "100%",
          fontSize: "12.5px",
          backgroundColor: "transparent",
          color: "#e4e4e7",
        },
        ".cm-scroller": {
          fontFamily:
            'ui-monospace,SFMono-Regular,Menlo,Monaco,"Cascadia Mono","Roboto Mono",Consolas,"Liberation Mono",monospace',
          lineHeight: "1.55",
        },
        ".cm-gutters": {
          backgroundColor: "transparent",
          color: "#525252",
          border: "none",
          paddingRight: "4px",
        },
        ".cm-activeLineGutter, .cm-activeLine": {
          backgroundColor: "rgba(99, 102, 241, 0.07)",
        },
        ".cm-cursor": { borderLeftColor: "#a5b4fc" },
        "&.cm-focused": { outline: "none" },
        ".cm-selectionBackground, ::selection": {
          backgroundColor: "rgba(99, 102, 241, 0.30) !important",
        },
      },
      { dark: true },
    ),
    cm.EditorView.lineWrapping,
  ];
}

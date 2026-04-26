import type { Extension } from "@codemirror/state";

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
  defaultHighlightStyle: typeof import("@codemirror/language").defaultHighlightStyle;
};

let core: Promise<CMCore> | null = null;

export function loadCMCore(): Promise<CMCore> {
  if (!core) {
    core = (async () => {
      const [state, view, commands, language] = await Promise.all([
        import("@codemirror/state"),
        import("@codemirror/view"),
        import("@codemirror/commands"),
        import("@codemirror/language"),
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
        defaultHighlightStyle: language.defaultHighlightStyle,
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
    cm.syntaxHighlighting(cm.defaultHighlightStyle, { fallback: true }),
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

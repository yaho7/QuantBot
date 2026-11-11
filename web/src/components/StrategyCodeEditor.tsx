import { tr } from "@/lib/i18n";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { bracketMatching, HighlightStyle, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

const snippets = [
  [tr("连接"), 'from quantbot_client import QuantBot\n\nqb = QuantBot("momentum")'],
  [tr("等待"), "if not qb.sleep(60):\n    break"],
  [tr("允许开仓"), "if qb.can_open():\n    open_position()"],
  [tr("状态"), tr("qb.status(f\"净值 {equity:.2f}\")")],
  [tr("推送消息"), tr("qb.info(\"策略已启动\")")],
  [tr("注册按钮"), 'qb.on("positions", my_positions_text)'],
] as const;

const theme = EditorView.theme({
  "&": { color: "var(--foreground)", backgroundColor: "var(--background)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)", fontSize: "0.75rem", lineHeight: "1.65", maxHeight: "52vh",
  },
  ".cm-content": { minHeight: "15rem", padding: "0.75rem 0", caretColor: "var(--foreground)" },
  ".cm-line": { padding: "0 0.75rem" },
  ".cm-gutters": {
    color: "var(--muted-foreground)", backgroundColor: "var(--card)", borderColor: "var(--border)",
  },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
    background: "var(--accent)",
  },
});

const highlighting = syntaxHighlighting(HighlightStyle.define([
  { tag: tags.keyword, color: "var(--loss)" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--gain)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--warning)" },
  { tag: tags.comment, color: "var(--muted-foreground)", fontStyle: "italic" },
  { tag: [tags.className, tags.function(tags.definition(tags.variableName))], fontWeight: "600" },
]));

export function StrategyCodeEditor({ path, initial, onChange, disabled }: {
  path: string;
  initial: string;
  onChange: (code: string) => void;
  disabled: boolean;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const access = useRef(new Compartment());
  const original = useRef(initial);
  const isPython = /\.pyi?$/.test(path);
  useEffect(() => {
    const editor = new EditorView({
      parent: parent.current!,
      doc: original.current,
      extensions: [
        theme, isPython ? python() : [], highlighting, lineNumbers(), history(),
        indentOnInput(), bracketMatching(), keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorState.lineSeparator.of(original.current.includes("\r\n") ? "\r\n" : "\n"),
        EditorView.contentAttributes.of({ "aria-label": tr("代码编辑区 {0}", path) }),
        access.current.of([]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.sliceDoc());
        }),
      ],
    });
    view.current = editor;
    return () => { editor.destroy(); view.current = null; };
  }, [isPython, onChange, path]);
  useEffect(() => {
    view.current?.dispatch({ effects: access.current.reconfigure([
      EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled),
    ]) });
  }, [disabled]);

  function insert(code: string) {
    const editor = view.current;
    if (!editor) return;
    const { state } = editor;
    const selection = state.selection.main;
    const line = state.doc.lineAt(selection.from);
    const indent = line.text.match(/^\s*/)?.[0] ?? "";
    const [first, ...rest] = code.split("\n");
    const inserted = state.toText([first, ...rest.map((text) => text ? indent + text : "")].join(state.lineBreak));
    editor.dispatch({
      changes: { from: selection.from, to: selection.to, insert: inserted },
      selection: { anchor: selection.from + inserted.length },
      scrollIntoView: true,
      userEvent: "input",
    });
    editor.focus();
  }

  return (
    <div className="grid min-w-0 gap-2">
      {isPython && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={tr("插入 QuantBot 代码")}>
          {snippets.map(([label, code]) => (
            <Button key={label} variant="outline" size="sm" disabled={disabled} onClick={() => insert(code)}>
              {label}
            </Button>
          ))}
        </div>
      )}
      <div ref={parent} className="min-w-0 overflow-hidden rounded-lg border border-input focus-within:ring-2 focus-within:ring-ring" />
    </div>
  );
}

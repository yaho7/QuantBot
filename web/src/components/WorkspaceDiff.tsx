import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useEffect, useRef } from "react";

const extensions = [
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  lineNumbers(),
  EditorView.lineWrapping,
  EditorView.theme({
    "&": { backgroundColor: "var(--background)", color: "var(--foreground)" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", fontSize: "0.75rem" },
    ".cm-gutters": { backgroundColor: "var(--card)", color: "var(--muted-foreground)", borderColor: "var(--border)" },
    ".cm-changedLine": { backgroundColor: "color-mix(in srgb, var(--warning) 12%, transparent)" },
  }),
];

export function WorkspaceDiff({ before, after, labels }: {
  before: string; after: string; labels: [string, string];
}) {
  const parent = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!parent.current) return;
    const view = new MergeView({
      parent: parent.current,
      a: { doc: before, extensions },
      b: { doc: after, extensions },
      collapseUnchanged: { margin: 3, minSize: 8 },
    });
    return () => view.destroy();
  }, [before, after]);
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border">
      <div className="grid grid-cols-2 divide-x border-b bg-card text-xs text-muted-foreground">
        {labels.map((label, index) => <span key={index} className="truncate px-3 py-2">{label}</span>)}
      </div>
      <div ref={parent} className="max-h-[48vh] overflow-auto" />
    </div>
  );
}

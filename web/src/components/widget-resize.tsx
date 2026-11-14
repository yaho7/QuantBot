import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { Widget } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import "./widget-resize.css";

const sizes: Widget["size"][] = ["small", "medium", "large", "full"];

/** Only the outline changes during pointer movement; the expensive board commits once. */
export function WidgetResize({ widget, commit }: {
  widget: Widget;
  commit: (value: Partial<Widget>) => void;
}) {
  const { t } = useLanguage();
  const outline = useRef<HTMLDivElement>(null);
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  return <>
    <button className="widget-resize-handle" type="button"
      aria-label={t("resizeWidget")} title={t("resizeWidget")}
      onKeyDown={(event) => {
        const index = sizes.indexOf(widget.size);
        if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
          commit({ size: sizes[Math.max(0, Math.min(3, index + (event.key === "ArrowRight" ? 1 : -1)))]! });
        } else {
          const height = event.currentTarget.closest("article")!.getBoundingClientRect().height;
          commit({ height: Math.max(120, Math.min(1200, Math.round(height / 8) * 8 + (event.key === "ArrowDown" ? 8 : -8))) });
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0 || !event.isPrimary) return;
        event.preventDefault();
        event.stopPropagation();
        cleanup.current();
        const handle = event.currentTarget;
        const card = handle.closest("article")!;
        const grid = card.parentElement!;
        const rect = card.getBoundingClientRect();
        const gridRect = grid.getBoundingClientRect();
        const style = getComputedStyle(grid);
        const columns = style.gridTemplateColumns.split(" ").length;
        const gap = parseFloat(style.columnGap) || 0;
        const unit = (gridRect.width + gap) / columns;
        const spans = columns <= 4 ? [2, 4, 4, 4] : columns <= 8 ? [4, 4, 8, 8] : [3, 6, 8, 12];
        const widths = spans.map(span => span * unit - gap);
        const startX = event.clientX, startY = event.clientY;
        const id = event.pointerId;
        let width = rect.width, height = rect.height, frame = 0;
        const preview = outline.current!;
        const paint = () => {
          frame = 0;
          Object.assign(preview.style, {
            display: "block", left: Math.min(rect.left, gridRect.right - width) + "px", top: rect.top + "px",
            width: width + "px", height: height + "px",
          });
        };
        paint();
        handle.setPointerCapture(id);
        const move = (e: PointerEvent) => {
          if (e.pointerId !== id) return;
          width = Math.max(widths[0]!, Math.min(gridRect.width, rect.width + e.clientX - startX));
          height = Math.max(120, Math.min(1200, rect.height + e.clientY - startY));
          if (!frame) frame = requestAnimationFrame(paint);
        };
        const cancel = () => {
          cancelAnimationFrame(frame);
          preview.style.display = "none";
          handle.removeEventListener("pointermove", move);
          handle.removeEventListener("pointerup", finish);
          handle.removeEventListener("pointercancel", cancel);
          handle.removeEventListener("lostpointercapture", cancel);
          window.removeEventListener("keydown", escape);
          window.removeEventListener("blur", cancel);
          window.removeEventListener("resize", cancel);
          window.removeEventListener("scroll", cancel, true);
          if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
          cleanup.current = () => {};
        };
        const escape = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); cancel(); } };
        const finish = (e: PointerEvent) => {
          if (e.pointerId !== id) return;
          move(e);
          const distances = widths.map(w => Math.abs(w - width));
          const current = sizes.indexOf(widget.size);
          const best = distances[current] === Math.min(...distances) ? current : distances.indexOf(Math.min(...distances));
          const changed = Math.abs(e.clientX - startX) > 3 || Math.abs(e.clientY - startY) > 3;
          cancel();
          if (changed) commit({ size: sizes[best]!, height: Math.round(height / 8) * 8 });
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", finish);
        handle.addEventListener("pointercancel", cancel);
        handle.addEventListener("lostpointercapture", cancel);
        window.addEventListener("keydown", escape);
        window.addEventListener("blur", cancel);
        window.addEventListener("resize", cancel);
        window.addEventListener("scroll", cancel, true);
        cleanup.current = cancel;
      }}>
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M4 12 12 4M9 12l3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    </button>
    {createPortal(<div className="widget-resize-outline" ref={outline} aria-hidden="true" />, document.body)}
  </>;
}

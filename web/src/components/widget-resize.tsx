import { Icon as AstryxIcon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { MoveDiagonal2 } from "lucide-react";
import { useEffect, useRef } from "react";
import type { Widget } from "../shared/api";
import { useLanguage } from "../shared/i18n";

const sizes: Widget["size"][] = ["small", "medium", "large", "full"];

/** Resize the actual grid item once per frame; commit React state once on release. */
export function WidgetResize({
  widget,
  commit,
}: {
  widget: Widget;
  commit: (value: Partial<Widget>) => void;
}) {
  const { t } = useLanguage();
  const cleanup = useRef<() => void>(() => {});
  useEffect(() => () => cleanup.current(), []);
  return (
    <>
      <IconButton
        label={t("resizeWidget")}
        icon={<AstryxIcon icon={MoveDiagonal2} size="sm" />}
        className="widget-resize-handle absolute right-0 bottom-0 z-10 touch-none select-none cursor-nwse-resize"
        type="button"
        aria-label={t("resizeWidget")}
        tooltip={t("resizeWidget")}
        onKeyDown={(event) => {
          const index = sizes.indexOf(widget.size);
          if (
            !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
              event.key,
            )
          )
            return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            commit({
              width: Math.max(
                12,
                Math.min(
                  100,
                  (widget.width ?? [25, 50, 67, 100][index]!) +
                    (event.key === "ArrowRight" ? 1 : -1),
                ),
              ),
            });
          } else {
            const height = event.currentTarget
              .closest("article")!
              .getBoundingClientRect().height;
            commit({
              height: Math.max(
                120,
                Math.min(
                  1200,
                  Math.round(height / 8) * 8 +
                    (event.key === "ArrowDown" ? 8 : -8),
                ),
              ),
            });
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
          const minimum =
            parseInt(style.getPropertyValue("--minimum-width")) || 12;
          const percent = () =>
            Math.max(
              minimum,
              Math.min(100, Math.round(((width + 12) / gridRect.width) * 100)),
            );
          const startX = event.clientX,
            startY = event.clientY;
          const id = event.pointerId;
          let width = rect.width,
            height = rect.height,
            frame = 0;
          const previous = {
            height: card.style.height,
            gridColumn: card.style.gridColumn,
          };
          card.dataset.resizing = "true";
          const paint = () => {
            frame = 0;
            const columns = getComputedStyle(
              card.parentElement!,
            ).gridTemplateColumns.split(" ").length;
            card.style.gridColumn =
              "span " + Math.max(1, Math.round((percent() * columns) / 100));
            card.style.height = Math.round(height / 8) * 8 + "px";
          };
          handle.setPointerCapture(id);
          const move = (e: PointerEvent) => {
            if (e.pointerId !== id) return;
            width = Math.max(
              (gridRect.width * minimum) / 100 - 12,
              Math.min(gridRect.width - 12, rect.width + e.clientX - startX),
            );
            height = Math.max(
              120,
              Math.min(1200, rect.height + e.clientY - startY),
            );
            if (!frame) frame = requestAnimationFrame(paint);
          };
          const cancel = () => {
            cancelAnimationFrame(frame);
            card.style.height = previous.height;
            card.style.gridColumn = previous.gridColumn;
            delete card.dataset.resizing;
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", finish);
            handle.removeEventListener("pointercancel", cancel);
            handle.removeEventListener("lostpointercapture", cancel);
            window.removeEventListener("keydown", escape);
            window.removeEventListener("blur", cancel);
            window.removeEventListener("resize", cancel);
            if (handle.hasPointerCapture(id)) handle.releasePointerCapture(id);
            cleanup.current = () => {};
          };
          const escape = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          };
          const finish = (e: PointerEvent) => {
            if (e.pointerId !== id) return;
            move(e);
            const nextWidth = percent();
            const changed =
              Math.abs(e.clientX - startX) > 3 ||
              Math.abs(e.clientY - startY) > 3;
            cancel();
            if (changed)
              commit({ width: nextWidth, height: Math.round(height / 8) * 8 });
          };
          handle.addEventListener("pointermove", move);
          handle.addEventListener("pointerup", finish);
          handle.addEventListener("pointercancel", cancel);
          handle.addEventListener("lostpointercapture", cancel);
          window.addEventListener("keydown", escape);
          window.addEventListener("blur", cancel);
          window.addEventListener("resize", cancel);
          cleanup.current = cancel;
        }}
      ></IconButton>
    </>
  );
}

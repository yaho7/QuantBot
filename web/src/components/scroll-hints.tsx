import { Icon as AstryxIcon } from "@astryxdesign/core/Icon";
import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/VStack";
import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useLanguage } from "../shared/i18n";

export function ScrollHints({
  target,
}: {
  target: RefObject<HTMLElement | null>;
}) {
  const { t } = useLanguage();
  const [edges, setEdges] = useState({ down: false, right: false });
  const targets = useRef<{ down?: HTMLElement; right?: HTMLElement }>({});
  useEffect(() => {
    const root = target.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const elements = [
        root,
        ...root.querySelectorAll<HTMLElement>(".table-scroll"),
      ];
      const down = elements.find(
        (e) => e.scrollHeight - e.clientHeight - e.scrollTop > 3,
      );
      const right = elements.find(
        (e) => e.scrollWidth - e.clientWidth - e.scrollLeft > 3,
      );
      targets.current = { down, right };
      setEdges((previous) =>
        previous.down === !!down && previous.right === !!right
          ? previous
          : { down: !!down, right: !!right },
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    const observe = () => {
      resize.disconnect();
      resize.observe(root);
      for (const e of root.querySelectorAll<HTMLElement>(
        ":scope > *, .table-scroll, table",
      ))
        resize.observe(e);
      schedule();
    };
    const mutation = new MutationObserver(observe);
    mutation.observe(root, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    root.addEventListener("scroll", schedule, true);
    observe();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      root.removeEventListener("scroll", schedule, true);
    };
  }, [target]);
  const scroll = (direction: "down" | "right") => {
    const element = targets.current[direction];
    element?.scrollBy({
      top: direction === "down" ? element.clientHeight * 0.7 : 0,
      left: direction === "right" ? element.clientWidth * 0.7 : 0,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  };
  return (
    <VStack gap={3} className="pointer-events-none absolute inset-0">
      {edges.down && (
        <Button
          label={t("scrollMoreDown")}
          variant="secondary"
          size="sm"
          isIconOnly
          icon={<AstryxIcon icon={ChevronDown} />}
          className="pointer-events-auto absolute bottom-1 left-1/2 -translate-x-1/2"
          onClick={() => scroll("down")}
          aria-label={t("scrollMoreDown")}
        ></Button>
      )}
      {edges.right && (
        <Button
          label={t("scrollMoreRight")}
          variant="secondary"
          size="sm"
          isIconOnly
          icon={<AstryxIcon icon={ChevronRight} />}
          className="pointer-events-auto absolute right-1 top-1/2 -translate-y-1/2"
          onClick={() => scroll("right")}
          aria-label={t("scrollMoreRight")}
        ></Button>
      )}
    </VStack>
  );
}

import { useEffect, useRef, useState, type RefObject } from "react";
import { RiArrowDownSLine as ChevronDown, RiArrowRightSLine as ChevronRight } from "@remixicon/react";
import { useLanguage } from "../shared/i18n";

export function ScrollHints({ target }: { target: RefObject<HTMLDivElement | null> }) {
  const { t } = useLanguage();
  const [edges, setEdges] = useState({ down: false, right: false });
  const targets = useRef<{ down?: HTMLElement; right?: HTMLElement }>({});
  useEffect(() => {
    const root = target.current;
    if (!root) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const elements = [root, ...root.querySelectorAll<HTMLElement>(".table-scroll")];
      const down = elements.find(e => e.scrollHeight - e.clientHeight - e.scrollTop > 3);
      const right = elements.find(e => e.scrollWidth - e.clientWidth - e.scrollLeft > 3);
      targets.current = { down, right };
      setEdges(previous => previous.down === !!down && previous.right === !!right ? previous : { down: !!down, right: !!right });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    const observe = () => {
      resize.disconnect();
      resize.observe(root);
      for (const e of root.querySelectorAll<HTMLElement>(":scope > *, .table-scroll, table")) resize.observe(e);
      schedule();
    };
    const mutation = new MutationObserver(observe);
    mutation.observe(root, { childList: true, subtree: true, characterData: true });
    root.addEventListener("scroll", schedule, true);
    observe();
    return () => { cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect(); root.removeEventListener("scroll", schedule, true); };
  }, [target]);
  const scroll = (direction: "down" | "right") => {
    const element = targets.current[direction];
    element?.scrollBy({
      top: direction === "down" ? element.clientHeight * .7 : 0,
      left: direction === "right" ? element.clientWidth * .7 : 0,
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  };
  return <div className="scroll-hints">
    {edges.down && <button className="scroll-cue down" onClick={() => scroll("down")} aria-label={t("scrollMoreDown")}><ChevronDown size={15} /></button>}
    {edges.right && <button className="scroll-cue right" onClick={() => scroll("right")} aria-label={t("scrollMoreRight")}><ChevronRight size={15} /></button>}
  </div>;
}

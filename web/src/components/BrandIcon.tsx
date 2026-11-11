import { cn } from "@/lib/utils";

// The AntQuant ant, used as a mask so it takes the text colour in both themes.
const ICON = `url(${import.meta.env.BASE_URL}favicon.svg) center / contain no-repeat`;

export function BrandIcon({ className }: { className: string }) {
  return (
    <span
      aria-hidden
      className={cn("block bg-current", className)}
      style={{ mask: ICON, WebkitMask: ICON }}
    />
  );
}

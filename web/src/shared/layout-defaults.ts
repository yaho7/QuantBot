import type { CapabilityCatalog, Layout, Widget } from "./api";

type Source = {
  strategyId: string;
  catalog?: CapabilityCatalog;
};

export function suggestedWidgets(
  sources: Source[],
  surface: "overview" | "strategy",
): Widget[] {
  return sources
    .flatMap(({ strategyId, catalog }) =>
      (catalog?.capabilities ?? [])
        .filter(
          ({ presentation }) =>
            presentation?.suggested && presentation.surface?.includes(surface),
        )
        .map((capability) => ({
          order: capability.presentation?.order ?? 0,
          widget: {
            id: "cap:" + strategyId + ":" + capability.id,
            type: "capability" as const,
            strategyId,
            controlId: capability.id,
            size: capability.presentation?.default_size ?? "medium",
            description: true,
            detailed: true,
          },
        })),
    )
    .sort((a, b) =>
      a.order - b.order ||
      (a.widget.id < b.widget.id ? -1 : a.widget.id > b.widget.id ? 1 : 0),
    )
    .slice(0, surface === "overview" ? 12 : 24)
    .map(({ widget }) => widget);
}

export function effectiveWidgets(saved: Layout | undefined, suggestions: Widget[]) {
  if (!saved) return [];
  return saved.revision === 0 ? suggestions : saved.widgets;
}

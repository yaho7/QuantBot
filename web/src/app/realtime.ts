import { useEffect } from "react";
import { client } from "../shared/api";

export function useRealtime(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource("/api/events");
    source.addEventListener("change", (event) => {
      const batch = JSON.parse((event as MessageEvent).data) as {
        reset?: boolean;
        changes?: { strategyId: string; topic: string }[];
      };
      if (batch.reset) {
        void client.invalidateQueries();
        return;
      }
      const changes = batch.changes ?? [];
      void client.invalidateQueries({
        predicate: (query) => {
          const path = String(query.queryKey[0]);
          return changes.some(({ strategyId, topic }) => {
            if (
              path === "/strategies" ||
              path.startsWith("/admin/strategies") ||
              path === "/admin/diagnostics"
            )
              return true;
            if (topic === "alerts" && path.startsWith("/alerts")) return true;
            if (
              topic === "commands" &&
              (path.startsWith("/commands") || path === "/admin/audit")
            )
              return true;
            const base = "/strategies/" + strategyId;
            if (path !== base && !path.startsWith(base + "/")) return false;
            if (topic === "controls")
              return (
                path === base + "/controls" ||
                path === base + "/capabilities" ||
                path === base + "/capability-data" ||
                path.startsWith(base + "/capabilities/") ||
                path.startsWith(base + "/resources/")
              );
            if (topic === "commands") return path === base + "/controls";
            if (topic === "telemetry") return path !== base + "/controls";
            return true;
          });
        },
      });
    });
    return () => source.close();
  }, [enabled]);
}

import { useEffect, useState } from "react";
import { client } from "../shared/api";

export function useRealtime(enabled: boolean) {
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const source = new EventSource("/api/v1/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
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
            if (!path.startsWith("/strategies/" + strategyId)) return false;
            if (topic === "controls" || topic === "commands")
              return path.endsWith("/controls");
            if (topic === "telemetry") return !path.endsWith("/controls");
            return true;
          });
        },
      });
    });
    return () => {
      source.close();
      setConnected(false);
    };
  }, [enabled]);
  return connected;
}

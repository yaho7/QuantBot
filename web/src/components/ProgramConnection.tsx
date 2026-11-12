import { Alert, Badge } from "@/components/ui/primitives";
import { type WorkspaceProgramStatus } from "@/lib/api";
import { ago, dateTime } from "@/lib/format";
import { tr } from "@/lib/i18n";

export function ProgramConnection({ data }: { data: WorkspaceProgramStatus }) {
  const { connection } = data;
  const labels = {
    unbound: "未绑定策略", invalid: "绑定已失效", stopped: "程序已停止",
    waiting: "等待首次连接", handshake: "等待命令轮询", stale: "策略连接已中断",
    ready: "已连接，可接收命令", legacy: "客户端协议过旧",
  } as const;
  const hints: Partial<Record<typeof connection, string>> = {
    unbound: "在运行面板绑定策略，或使用「配置项目」注册并绑定。",
    invalid: "请选择有效的策略重新绑定，再启动程序。",
    waiting: "请查看程序日志，确认策略初始化了 QuantBot SDK 并调用 qb.start()。",
    handshake: "已完成握手。请确认策略持续调用 qb.sleep() 或 qb.process() 处理命令。",
    stale: "程序仍在运行。请检查日志里的连接错误，并确认策略没有卡住。",
    legacy: "请更新项目中的 QuantBot SDK，再重新启动程序以启用交易控制。",
  };
  return (
    <div className="grid gap-2 rounded-lg border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>{tr("QuantBot 连接")}</span>
        <Badge tone={connection === "ready" ? "gain" : connection === "stopped" ? "neutral" : "warning"}>
          {tr(labels[connection])}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        {data.pid ? `PID ${data.pid} · ` : ""}
        {data.started_at ? `${tr("启动时间")} ${dateTime(new Date(data.started_at * 1000).toISOString())} · ` : ""}
        {tr("最近状态更新")} {ago(data.status_age)}
      </p>
      {data.running && hints[connection] && <p className="text-xs text-muted-foreground">{tr(hints[connection])}</p>}
      {!data.running && data.exit_code !== null && data.exit_code !== 0 &&
        <Alert tone="warning">{tr("程序已退出（退出码 {0}）。请查看程序日志。", data.exit_code)}</Alert>}
    </div>
  );
}

/** Formatting helpers. Missing values render as "—", never as 0. */

export const NA = "—";

/** Seconds ago -> "12 秒前" / "3 分钟前" / "2 小时前". */
export function ago(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return NA;
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))} 秒前`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return NA;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const ACTIONS: Record<string, string> = {
  pause: "暂停开仓",
  resume: "恢复开仓",
  pause_all: "全部暂停开仓",
  flatten: "平仓",
  stop: "停止",
  cancel: "撤单",
  set_param: "改参数",
  manual_order: "手动下单",
  settings: "改设置",
  update: "安装更新",
  editor_save: "保存策略文件",
  github: "同步 GitHub",
};

export function actionLabel(action: string): string {
  return ACTIONS[action] ?? action;
}

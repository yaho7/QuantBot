import { locale, tr } from "@/lib/i18n";
/** Formatting helpers. Missing values render as "—", never as 0. */

export const NA = "—";

/** Seconds ago -> "12 秒前" / "3 分钟前" / "2 小时前". */
export function ago(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return NA;
  if (seconds < 60) return tr("{0} 秒前", Math.max(0, Math.floor(seconds)));
  if (seconds < 3600) return tr("{0} 分钟前", Math.floor(seconds / 60));
  if (seconds < 86400) return tr("{0} 小时前", Math.floor(seconds / 3600));
  return tr("{0} 天前", Math.floor(seconds / 86400));
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return NA;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

const ACTIONS: Record<string, string> = {
  pause: tr("暂停开仓"),
  resume: tr("恢复开仓"),
  pause_all: tr("全部暂停开仓"),
  flatten: tr("平仓"),
  stop: tr("停止"),
  cancel: tr("撤单"),
  set_param: tr("改参数"),
  manual_order: tr("手动下单"),
  settings: tr("改设置"),
  update: tr("安装更新"),
  editor_save: tr("保存策略文件"),
  github: tr("同步 GitHub"),
  password: tr("改管理员账号"),
  web_link: tr("生成登录链接"),
  strategy_add: tr("添加策略"),
  strategy_rename: tr("修改策略名称"),
  strategy_remove: tr("移除策略"),
  strategy_credentials: tr("查看连接信息"),
  strategy_rotate: tr("换发策略令牌"),
  service_restart: tr("重启后台服务"),
};

export function actionLabel(action: string): string {
  return ACTIONS[action] ?? action;
}

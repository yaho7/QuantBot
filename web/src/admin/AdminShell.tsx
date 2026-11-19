import { useEffect, useId, useState, type ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetClose, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  RiArrowLeftLine as ArrowLeft,
  RiNotification3Line as Bell,
  RiLineChartLine as ChartNoAxesCombined,
  RiFileList3Line as ClipboardList,
  RiHistoryLine as History,
  RiDatabase2Line as Database,
  RiDashboardLine as LayoutDashboard,
  RiMenuLine as Menu,
  RiPaletteLine as Palette,
  RiServerLine as Server,
  RiSendPlaneLine as SendPlane,
  RiSettings3Line as Settings,
  RiShieldLine as Shield,
} from "@remixicon/react";
import { useLocation } from "react-router-dom";
import { version } from "../../package.json";
import { RecentAlertBadge } from "../components/attention-summary";
import { useLanguage } from "../shared/i18n";
import { Link, NavLink } from "../shared/page-links";
import "../styles/admin-shell.css";

const management = [
  ["", [["dashboard", "dashboard", LayoutDashboard]]],
  [
    "监控",
    [
      ["hosts", "hosts", Server],
      ["activity", "activity", History],
      ["alerts", "alerts", Bell],
    ],
  ],
  [
    "管理",
    [
      ["strategies", "strategies", ChartNoAxesCombined],
      ["notifications", "notifications", SendPlane],
    ],
  ],
  ["外观", [["themes", "themes", Palette]]],
  [
    "系统",
    [
      ["storage", "storage", Database],
      ["audit", "audit", ClipboardList],
      ["security", "security", Shield],
      ["settings", "settings", Settings],
    ],
  ],
] as const;

const localizedGroup = { 监控: "Monitoring", 管理: "Management", 外观: "Appearance", 系统: "System" };
type AdminChrome = { brand: ReactNode; tools: ReactNode; logout: ReactNode; recentAlerts: number };

function AdminNavigation({ recentAlerts, onNavigate }: { recentAlerts: number; onNavigate?: () => void }) {
  const { lang, t } = useLanguage();
  const alertDescription = useId();
  return (
    <nav className="admin-nav" aria-label={t("admin")}>
      {management.map(([heading, links]) => (
        <section className="admin-nav-group" key={heading}>
          {heading && <h2>{lang === "zh" ? heading : localizedGroup[heading]}</h2>}
          <ul>
            {links.map(([path, label, Icon]) => (
              <li key={path}>
                <NavLink to={"/admin/" + path} end={path !== "hosts"} onClick={onNavigate}
                  aria-describedby={path === "alerts" && recentAlerts > 0 ? alertDescription : undefined}>
                  <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
                  <span>{t(label)}</span>
                  {path === "alerts" && <RecentAlertBadge count={recentAlerts} descriptionId={alertDescription} />}
                </NavLink>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

function AdminNavFooter({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useLanguage();
  return (
    <footer className="admin-nav-footer">
      <Link to="/" className="admin-nav-return" onClick={onNavigate}>
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
        {t("return")}
      </Link>
      <small className="text-muted-foreground tabular-nums">QuantBot {version}</small>
    </footer>
  );
}

export default function AdminShell({ children, brand, tools, logout, recentAlerts }: AdminChrome & { children: ReactNode }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const close = () => setOpen(false);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const desktop = matchMedia("(width > 800px)");
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, [open]);

  return (
    <div className="admin-shell">
      <header className="admin-toolbar">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger render={<Button variant="ghost" size="icon-lg" className="admin-menu-trigger size-11" aria-label={t("menu")} />}>
              <Menu aria-hidden="true" />
            </SheetTrigger>
            <SheetContent side="left" className="admin-drawer" showCloseButton={false} aria-describedby={undefined}>
              <SheetHeader className="admin-drawer-header">
                <SheetTitle>{t("admin")}</SheetTitle>
                <SheetClose render={<Button variant="ghost" className="min-h-11" />}>{t("close")}</SheetClose>
              </SheetHeader>
              <div className="admin-drawer-body">
                <AdminNavigation recentAlerts={recentAlerts} onNavigate={close} />
              </div>
              <SheetFooter className="admin-drawer-footer">
                <AdminNavFooter onNavigate={close} />
              </SheetFooter>
            </SheetContent>
          </Sheet>
          {brand}
          <Separator orientation="vertical" className="admin-toolbar-separator" aria-hidden="true" />
          <span className="truncate text-sm text-muted-foreground">{t("admin")}</span>
        </div>
        <div className="admin-utility-actions flex shrink-0 items-center gap-1">
          <NavLink to="/admin/alerts" aria-label={t("alerts")}
            aria-describedby={recentAlerts > 0 ? "admin-toolbar-alert-count" : undefined}
            className={buttonVariants({ variant: "ghost", size: "icon-lg", className: "admin-alert-shortcut size-11" })}>
            <span className="admin-alert-anchor">
              <Bell aria-hidden="true" />
              <RecentAlertBadge count={recentAlerts} descriptionId="admin-toolbar-alert-count" />
            </span>
          </NavLink>
          {tools}{logout}
        </div>
      </header>
      <aside className="admin-sidebar">
        <AdminNavigation recentAlerts={recentAlerts} />
        <AdminNavFooter />
      </aside>
      <main className="admin-main">{children}</main>
    </div>
  );
}

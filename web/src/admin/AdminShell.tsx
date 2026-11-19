import { useEffect, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  RiArrowLeftLine as ArrowLeft,
  RiNotification3Line as Bell,
  RiLineChartLine as ChartNoAxesCombined,
  RiFileList3Line as ClipboardList,
  RiDatabase2Line as Database,
  RiDashboardLine as LayoutDashboard,
  RiMenuLine as Menu,
  RiPaletteLine as Palette,
  RiSettings3Line as Settings,
  RiShieldLine as Shield,
} from "@remixicon/react";
import { useLocation } from "react-router-dom";
import { version } from "../../package.json";
import { useLanguage } from "../shared/i18n";
import { Link, NavLink } from "../shared/page-links";
import "../styles/admin-shell.css";

const management = [
  ["", [["dashboard", "dashboard", LayoutDashboard]]],
  [
    "管理",
    [
      ["strategies", "strategies", ChartNoAxesCombined],
      ["notifications", "notifications", Bell],
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

const localizedGroup = { 管理: "Management", 外观: "Appearance", 系统: "System" };
type AdminChrome = { brand: ReactNode; tools: ReactNode; logout: ReactNode };

function AdminNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const { lang, t } = useLanguage();
  return (
    <nav className="admin-nav" aria-label={t("admin")}>
      {management.map(([heading, links]) => (
        <section className="admin-nav-group" key={heading}>
          {heading && <h2>{lang === "zh" ? heading : localizedGroup[heading]}</h2>}
          <ul>
            {links.map(([path, label, Icon]) => (
              <li key={path}>
                <NavLink to={"/admin/" + path} end onClick={onNavigate}>
                  <Icon size={16} strokeWidth={1.5} aria-hidden="true" />
                  {t(label)}
                </NavLink>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

function AdminNavFooter({ actions, onNavigate }: { actions?: ReactNode; onNavigate?: () => void }) {
  const { t } = useLanguage();
  return (
    <footer className="admin-nav-footer">
      <Link to="/" className="admin-nav-return" onClick={onNavigate}>
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
        {t("return")}
      </Link>
      <div className="flex items-center justify-between gap-2">
        <small className="text-muted-foreground tabular-nums">QuantBot {version}</small>
        {actions}
      </div>
    </footer>
  );
}

export default function AdminShell({ children, brand, tools, logout }: AdminChrome & { children: ReactNode }) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();
  const close = () => setOpen(false);
  const utilities = <div className="admin-utility-actions flex items-center gap-1">{tools}{logout}</div>;

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
      <header className="mobile-admin-header">
        <div className="flex items-center gap-2">
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetTrigger render={<Button variant="ghost" size="icon-lg" className="size-11" aria-label={t("menu")} />}>
              <Menu size={18} strokeWidth={1.5} aria-hidden="true" />
            </SheetTrigger>
            <SheetContent side="left" className="admin-drawer" showCloseButton={false} aria-describedby={undefined}>
              <SheetHeader className="admin-drawer-header">
                <SheetTitle>{t("admin")}</SheetTitle>
                <SheetClose render={<Button variant="ghost" className="min-h-11" />}>{t("close")}</SheetClose>
              </SheetHeader>
              <div className="admin-drawer-body">
                <AdminNavigation onNavigate={close} />
              </div>
              <SheetFooter className="admin-drawer-footer">
                <AdminNavFooter onNavigate={close} />
              </SheetFooter>
            </SheetContent>
          </Sheet>
          {brand}
        </div>
        {utilities}
      </header>
      <aside className="sidebar admin-sidebar">
        <div className="admin-nav-brand">{brand}</div>
        <AdminNavigation />
        <AdminNavFooter actions={utilities} />
      </aside>
      <main className="admin-main">{children}</main>
    </div>
  );
}

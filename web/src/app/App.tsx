import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Link,
  NavLink,
  Navigate,
  Outlet,
  RouterProvider,
  createBrowserRouter,
  useLocation,
} from "react-router-dom";
import {
  Activity,
  ArrowLeft,
  Bell,
  ChartNoAxesCombined,
  ClipboardList,
  Database,
  LayoutDashboard,
  Menu,
  Moon,
  Paintbrush,
  Plug,
  Settings,
  Shield,
  SlidersHorizontal,
  Sun,
  LogOut,
  X,
} from "lucide-react";
import { Toaster } from "sonner";
import {
  api,
  ApiError,
  client,
  resource,
  setCSRF,
  type Session,
} from "../shared/api";
import { ErrorView, Loading } from "../shared/ui";
import { setLanguage, useLanguage, type Message } from "../shared/i18n";
const Login = lazy(() =>
  import("./auth").then((module) => ({ default: module.Login })),
);
import { useRealtime } from "./realtime";
import { Home } from "./home";
import { StrategyDetail, AllControls } from "./strategy";
import { ActivityPage, AlertsPage } from "./activity";
const Notifications = lazy(() => import("../admin/notifications"));
const AdminDashboard = lazy(() =>
  import("../admin/pages").then((module) => ({
    default: module.AdminDashboard,
  })),
);
const AdminStrategies = lazy(() =>
  import("../admin/pages").then((module) => ({
    default: module.AdminStrategies,
  })),
);
const Integration = lazy(() =>
  import("../admin/pages").then((module) => ({ default: module.Integration })),
);
const Audit = lazy(() =>
  import("../admin/pages").then((module) => ({ default: module.Audit })),
);
const Security = lazy(() =>
  import("../admin/pages").then((module) => ({ default: module.Security })),
);

const monitor = [
  ["/", "workbench", LayoutDashboard],
  ["/strategies", "strategies", ChartNoAxesCombined],
  ["/controls", "controls", SlidersHorizontal],
  ["/activity", "activity", ClipboardList],
  ["/alerts", "alerts", Bell],
] as const;
const management = [
  ["", [["dashboard", "dashboard", LayoutDashboard]]],
  [
    "管理",
    [
      ["strategies", "strategies", ChartNoAxesCombined],
      ["integration", "integration", Plug],
      ["notifications", "notifications", Bell],
    ],
  ],
  ["外观", [["themes", "themes", Paintbrush]]],
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

function Root() {
  const session = useQuery({
    ...resource<Session>("/auth/session"),
    retry: false,
  });
  const connected = useRealtime(!!session.data);
  const { lang, t } = useLanguage();
  const [mode, setMode] = useState(
    localStorage.getItem("qb.appearance") ?? "system",
  );
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      document.documentElement.dataset.appearance =
        mode === "system" ? (media.matches ? "dark" : "light") : mode;
    };
    sync();
    media.addEventListener("change", sync);
    localStorage.setItem("qb.appearance", mode);
    return () => media.removeEventListener("change", sync);
  }, [mode]);
  useEffect(() => {
    if (session.data) setCSRF(session.data.csrf);
  }, [session.data]);
  if (session.isPending) return <Loading />;
  if (
    session.error &&
    !(session.error instanceof ApiError && session.error.status === 401)
  )
    return (
      <ErrorView error={session.error} retry={() => void session.refetch()} />
    );
  if (!session.data)
    return (
      <Suspense fallback={<Loading />}>
        <Login />
      </Suspense>
    );
  setCSRF(session.data.csrf);
  return (
    <>
      <Suspense fallback={<Loading />}>
        <Outlet />
      </Suspense>
      <aside className="floating-tools" aria-label={t("appearance")}>
        <span
          className={"connection-dot " + (connected ? "online" : "")}
          title={connected ? "SSE connected" : "Reconnecting"}
        />
        <button
          className="icon-button"
          aria-label={mode === "dark" ? t("light") : t("dark")}
          onClick={() => setMode(mode === "dark" ? "light" : "dark")}
        >
          {mode === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <button className="text-button" onClick={() => setMode("system")}>
          {t("system")}
        </button>
        <button
          className="text-button"
          onClick={() => setLanguage(lang === "zh" ? "en" : "zh")}
        >
          {lang === "zh" ? "EN" : "中文"}
        </button>
      </aside>
      <Toaster position="top-center" richColors />
    </>
  );
}
function Brand() {
  return (
    <Link className="brand" to="/">
      <span className="brand-icon">
        <Activity size={22} />
      </span>
      <strong>QuantBot</strong>
    </Link>
  );
}
function Logout() {
  const { t } = useLanguage();
  return (
    <button
      className="icon-button"
      aria-label={t("logout")}
      onClick={() =>
        void api("/auth/logout", "POST")
          .then(() => client.clear())
          .then(() => location.reload())
      }
    >
      <LogOut size={18} />
    </button>
  );
}
function Workbench() {
  const { t } = useLanguage();
  return (
    <div className="workbench-shell">
      <header className="topbar">
        <div className="container topbar-inner">
          <Brand />
          <nav aria-label={t("workbench")}>
            {monitor.map(([path, label, Icon]) => (
              <NavLink end={path === "/"} key={path} to={path}>
                <Icon size={17} />
                <span>{t(label)}</span>
              </NavLink>
            ))}
          </nav>
          <div className="actions">
            <Link className="admin-link" to="/admin">
              <Settings size={17} />
              <span>{t("admin")}</span>
            </Link>
            <Logout />
          </div>
        </div>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </div>
  );
}
function AdminShell() {
  const { lang, t } = useLanguage();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  return (
    <div className="admin-shell">
      <header className="mobile-admin-header">
        <button
          aria-label="Menu"
          className="icon-button"
          onClick={() => setOpen(true)}
        >
          <Menu />
        </button>
        <Brand />
        <Logout />
      </header>
      {open && (
        <button
          className="drawer-backdrop"
          aria-label={t("close")}
          onClick={() => setOpen(false)}
        />
      )}
      <aside className={"sidebar " + (open ? "open" : "")}>
        <div className="sidebar-brand">
          <Brand />
          <button
            className="mobile-close icon-button"
            aria-label={t("close")}
            onClick={() => setOpen(false)}
          >
            <X />
          </button>
        </div>
        <nav>
          {management.map(([heading, links]) => (
            <div className="nav-group" key={heading}>
              {heading && (
                <small>
                  {lang === "zh"
                    ? heading
                    : {
                        管理: "Management",
                        外观: "Appearance",
                        系统: "System",
                      }[heading]}
                </small>
              )}
              {links.map(([path, label, Icon]) => (
                <NavLink key={path} to={"/admin/" + path}>
                  <Icon size={18} />
                  {t(label as Message)}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <footer>
          <Link to="/">
            <ArrowLeft size={16} />
            {t("return")}
          </Link>
          <span className="muted">QuantBot 3.0.0</span>
        </footer>
      </aside>
      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
function NotFound() {
  return (
    <div className="empty-state">
      <h1>404</h1>
      <Link to="/">QuantBot</Link>
    </div>
  );
}
export function Page({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <header className="page-header">
        <h1>{title}</h1>
        {actions && <div className="actions">{actions}</div>}
      </header>
      {children}
    </>
  );
}
const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      {
        element: <Workbench />,
        children: [
          { index: true, element: <Home /> },
          { path: "strategies", element: <Home /> },
          { path: "strategies/:id", element: <StrategyDetail /> },
          { path: "controls", element: <AllControls /> },
          { path: "activity", element: <ActivityPage /> },
          { path: "alerts", element: <AlertsPage /> },
        ],
      },
      {
        path: "admin",
        element: <AdminShell />,
        children: [
          { index: true, element: <Navigate to="dashboard" replace /> },
          { path: "dashboard", element: <AdminDashboard /> },
          { path: "notifications", element: <Notifications /> },
          { path: "strategies", element: <AdminStrategies /> },
          { path: "integration", element: <Integration /> },
          { path: "audit", element: <Audit /> },
          { path: "security", element: <Security /> },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
export function App() {
  return <RouterProvider router={router} />;
}

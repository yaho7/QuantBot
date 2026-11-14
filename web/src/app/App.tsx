import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
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
  ArrowLeft,
  Bell,
  ChartNoAxesCombined,
  ClipboardList,
  Database,
  LayoutDashboard,
  Menu,
  Monitor,
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
import { BrandIcon } from "../components/brand-icon";
import "../styles/antquant.css";
import "../styles/wealthfolio.css";
import { usePalette } from "../shared/preferences";
import { useLanguage, type Message } from "../shared/i18n";
const Login = lazy(() =>
  import("./auth").then((module) => ({ default: module.Login })),
);
import { useRealtime } from "./realtime";
import { Home } from "./home";
import { activeTheme, ThemeContext } from "../themes/catalog";
import { ThemeFrame, themeStyle } from "../themes/host";
import { StrategyDetail, AllControls } from "./strategy";
import { ActivityPage, AlertsPage } from "./activity";
const ThemeAdmin = lazy(() => import("../admin/themes"));
const Notifications = lazy(() => import("../admin/notifications"));
const Storage = lazy(() =>
  import("../admin/system").then((module) => ({ default: module.Storage })),
);
const SettingsPage = lazy(() =>
  import("../admin/system").then((module) => ({ default: module.Settings })),
);
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

const AppearanceTools = createContext<ReactNode>(null);

function Root() {
  usePalette();
  const session = useQuery({
    ...resource<Session>("/auth/session"),
    retry: false,
  });
  const connected = useRealtime(!!session.data);
  const { t } = useLanguage();
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
  const themeIcons = { system: Monitor, light: Sun, dark: Moon } as const;
  const appearance = mode === "light" || mode === "dark" ? mode : "system";
  const ThemeIcon = themeIcons[appearance];
  const tools = (
    <div className="floating-tools" aria-label={t("appearance")}>
      <span
        className={"connection-dot " + (connected ? "online" : "")}
        title={t(connected ? "connected" : "reconnecting")}
      />
      <button
        className="icon-button"
        aria-label={t("appearance") + ": " + t(appearance)}
        title={t("appearance") + ": " + t(appearance)}
        onClick={() =>
          setMode(appearance === "system" ? "light" : appearance === "light" ? "dark" : "system")
        }
      >
        <ThemeIcon size={17} />
      </button>
    </div>
  );
  return (
    <AppearanceTools.Provider value={tools}>
      <Suspense fallback={<Loading />}>
        <Outlet />
      </Suspense>
      <Toaster position="top-center" richColors />
    </AppearanceTools.Provider>
  );
}
function Brand() {
  return (
    <Link className="brand" to="/">
      <BrandIcon />
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
  const tools = useContext(AppearanceTools);
  const query = useQuery(activeTheme);
  const location = useLocation();
  const [failed, setFailed] = useState("");
  const theme = query.data;
  const identity = (theme?.id ?? "") + ":" + (theme?.revision ?? "");
  const fallback = !!query.error || (failed !== "" && failed === identity);
  const selected = fallback ? undefined : theme;
  const antquant = fallback || !selected || selected.id === "classical";
  const onFailure = useCallback(() => setFailed(identity), [identity]);
  const full =
    location.pathname === "/" &&
    selected?.entryUrl &&
    !new URLSearchParams(location.search).has("classic");
  return (
    <ThemeContext.Provider
      value={fallback ? { cardView: "list" } : { ...selected?.presentation, portfolio: antquant }}
    >
      <div
        className={"workbench-shell" + (antquant ? " antquant-workbench" : "")}
        data-theme={selected?.id ?? "classical"}
        data-theme-palette={selected && !selected.builtin ? "" : undefined}
        data-theme-surface={selected?.presentation.surface}
        style={themeStyle(selected)}
      >
        <header className="topbar">
          <div className="container topbar-inner">
            <Brand />
            <nav aria-label={t("workbench")}>
              {monitor.map(([path, label, Icon]) => (
                <NavLink end={path === "/"} key={path} to={path} title={t(label)} aria-label={t(label)}>
                  <Icon size={18} />
                  <span>{t(label)}</span>
                </NavLink>
              ))}
            </nav>
            <div className="actions">
              {antquant && tools}
              <Link
                className="admin-link"
                to="/admin/settings"
                aria-label={t("settings")}
                title={t("settings")}
              >
                <Settings size={17} />
                <span>{t("admin")}</span>
              </Link>
              <Logout />
            </div>
          </div>
        </header>
        <main className="container">
          {fallback && (
            <p role="status" className="warning">
              {t("themeFallback")}
            </p>
          )}
          {full && selected ? (
            <>
              <Link className="button" to="/?classic=1">
                {t("themeHostView")}
              </Link>
              <ThemeFrame
                key={identity}
                theme={selected}
                onFailure={onFailure}
              />
            </>
          ) : (
            <Outlet />
          )}
        </main>
        {!antquant && tools}
      </div>
    </ThemeContext.Provider>
  );
}
function AdminShell() {
  const { lang, t } = useLanguage();
  const tools = useContext(AppearanceTools);
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  return (
    <div className="admin-shell">
      <header className="mobile-admin-header">
        <button
          aria-label={t("menu")}
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
      {tools}
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
          { path: "themes", element: <ThemeAdmin /> },
          { path: "strategies", element: <AdminStrategies /> },
          { path: "integration", element: <Integration /> },
          { path: "audit", element: <Audit /> },
          { path: "security", element: <Security /> },
          { path: "storage", element: <Storage /> },
          { path: "settings", element: <SettingsPage /> },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
export function App() {
  return <RouterProvider router={router} />;
}

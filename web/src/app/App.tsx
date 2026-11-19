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
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Navigate,
  Outlet,
  RouterProvider,
  ScrollRestoration,
  createBrowserRouter,
  useLocation,
} from "react-router-dom";
import { Link, NavLink } from "../shared/page-links";
import {
  RiNotification3Line as Bell,
  RiLineChartLine as ChartNoAxesCombined,
  RiFileList3Line as ClipboardList,
  RiDashboardLine as LayoutDashboard,
  RiComputerLine as Monitor,
  RiMoonLine as Moon,
  RiSettings3Line as Settings,
  RiServerLine as Server,
  RiEqualizer2Line as SlidersHorizontal,
  RiSunLine as Sun,
  RiLogoutBoxRLine as LogOut,
} from "@remixicon/react";
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
import { useAttention } from "../components/attention-summary";
import { BrandIcon } from "../components/brand-icon";
import "../styles/workbench.css";
import "../styles/alignment.css";
import "../styles/route-layout.css";
import { setAppearance, useAppearance } from "../shared/preferences";
import { useLanguage } from "../shared/i18n";
const AdminShell = lazy(() => import("../admin/AdminShell"));
const Login = lazy(() =>
  import("./auth").then((module) => ({ default: module.Login })),
);
import { useRealtime } from "./realtime";
import { activeTheme, ThemeContext } from "../themes/catalog";
import { ThemeFrame, themeStyle } from "../themes/host";

const monitor = [
  ["/", "workbench", LayoutDashboard],
  ["/strategies", "strategies", ChartNoAxesCombined],
  ["/controls", "controls", SlidersHorizontal],
  ["/hosts", "hosts", Server],
  ["/activity", "activity", ClipboardList],
  ["/alerts", "alerts", Bell],
] as const;
const AppearanceTools = createContext<ReactNode>(null);

function Root() {
  const session = useQuery({
    ...resource<Session>("/auth/session"),
    retry: false,
  });
  const connected = useRealtime(!!session.data);
  const { t } = useLanguage();
  const mode = useAppearance();
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const appearance = mode === "light" || mode === "dark" ? mode : media.matches ? "dark" : "light";
      document.documentElement.dataset.appearance = appearance;
      document.documentElement.classList.toggle("dark", appearance === "dark");
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [mode]);
  useEffect(() => {
    if (session.data) setCSRF(session.data.csrf);
  }, [session.data]);
  const appearance = mode === "light" || mode === "dark" ? mode : "system";
  if (session.isPending) return <Loading />;
  if (
    session.error &&
    !(session.error instanceof ApiError && session.error.status === 401)
  )
    return <ErrorView error={session.error} retry={() => void session.refetch()} />;
  if (!session.data)
    return (
      <Suspense fallback={<Loading />}>
        <Login />
      </Suspense>
    );
  setCSRF(session.data.csrf);
  const themeIcons = { system: Monitor, light: Sun, dark: Moon } as const;
  const ThemeIcon = themeIcons[appearance];
  const appearanceLabel = t("appearance") + ": " + t(appearance);
  const tools = (
    <div className="floating-tools" aria-label={t("appearance")}>
      <span
        className={"connection-dot " + (connected ? "online" : "")}
        title={t(connected ? "connected" : "reconnecting")}
      />
      <Tooltip>
        <TooltipTrigger render={
          <Button aria-label={appearanceLabel} size="icon" variant="ghost" onClick={() =>
            setAppearance(appearance === "system" ? "light" : appearance === "light" ? "dark" : "system")
          } />
        }><ThemeIcon aria-hidden="true" /></TooltipTrigger>
        <TooltipContent>{appearanceLabel}</TooltipContent>
      </Tooltip>
    </div>
  );
  return (
    <TooltipProvider delay={350}>
      <AppearanceTools.Provider value={tools}>
        <Suspense fallback={<Loading />}>
          <Outlet />
        </Suspense>
        <ScrollRestoration />
        <Toaster position="top-center" theme={appearance} />
      </AppearanceTools.Provider>
    </TooltipProvider>
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
    <Tooltip>
      <TooltipTrigger render={
        <Button aria-label={t("logout")} size="icon" variant="ghost" onClick={() =>
          void api("/auth/logout", "POST").then(() => client.clear()).then(() => location.reload())
        } />
      }><LogOut aria-hidden="true" /></TooltipTrigger>
      <TooltipContent>{t("logout")}</TooltipContent>
    </Tooltip>
  );
}
function Workbench() {
  const { t } = useLanguage();
  const attention = useAttention();
  const tools = useContext(AppearanceTools);
  const query = useQuery(activeTheme);
  const location = useLocation();
  const [failed, setFailed] = useState("");
  const theme = query.data;
  const identity = (theme?.id ?? "") + ":" + (theme?.revision ?? "");
  const fallback = !!query.error || (failed !== "" && failed === identity);
  const selected = fallback ? undefined : theme;
  // Frontend packages own the iframe, while host navigation and native pages
  // retain the original Classical shell and trusted controls.
  const hostTheme = selected?.manifest.type === "frontend" || new URLSearchParams(location.search).has("classic") ? undefined : selected;
  const builtIn = fallback || !hostTheme || hostTheme.id === "classical";
  const onFailure = useCallback(() => setFailed(identity), [identity]);
  const full =
    location.pathname === "/" &&
    selected?.entryUrl &&
    !new URLSearchParams(location.search).has("classic");
  return (
    <ThemeContext.Provider
      value={fallback ? { cardView: "list" } : { ...(hostTheme?.presentation ?? { cardView: "list" }), portfolio: builtIn }}
    >
      <div
        className={"workbench-shell" + (builtIn ? " native-workbench" : "")}
        data-theme={hostTheme?.id ?? "classical"}
        data-theme-palette={hostTheme && !hostTheme.builtin ? "" : undefined}
        data-theme-surface={hostTheme?.presentation.surface}
        style={themeStyle(hostTheme)}
      >
        <header className="topbar">
          <div className="container topbar-inner">
            <Brand />
            <nav aria-label={t("workbench")}>
              {monitor.map(([path, label, Icon]) => {
                const hasAlert = label === "alerts" && attention.count > 0;
                return (
                  <NavLink end={path === "/"} key={path} to={path}
                    className={label === "alerts" ? "nav-alert-link" : undefined}
                    title={t(label)} aria-label={t(label)}
                    aria-describedby={hasAlert ? "nav-alert-count" : undefined}>
                    <Icon size={18} strokeWidth={1.5} aria-hidden="true" />
                    <span className="nav-label">{t(label)}</span>
                    {hasAlert && <>
                      <i className="nav-alert-badge" aria-hidden="true">{attention.count > 99 ? "99+" : attention.count}</i>
                      <span className="sr-only" id="nav-alert-count">{t("attentionCount")}: {attention.count}</span>
                    </>}
                  </NavLink>
                );
              })}
            </nav>
            <div className="actions workbench-actions">
              {builtIn && tools}
              <Link
                className="admin-link"
                to="/admin/settings"
                aria-label={t("settings")}
                title={t("settings")}
              >
                <Settings size={18} strokeWidth={1.5} aria-hidden="true" />
                <span className="nav-label">{t("admin")}</span>
              </Link>
              <Logout />
            </div>
          </div>
        </header>
        <main className="container">
          <RouteSurface>
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
            ) : <Outlet context={attention} />}
          </RouteSurface>
        </main>
        {!builtIn && tools}
      </div>
    </ThemeContext.Provider>
  );
}
function AdminRoute() {
  const tools = useContext(AppearanceTools);
  return (
    <AdminShell brand={<Brand />} tools={tools} logout={<Logout />}>
      <RouteSurface><Outlet /></RouteSurface>
    </AdminShell>
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
function RouteSurface({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <div className="route-surface">
    <div className={"route-frame" + (typeof document.startViewTransition === "function" ? "" : " route-fade-fallback")} key={pathname}>
      <Suspense fallback={<Loading />}>{children}</Suspense>
    </div>
  </div>;
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
    <div className="page-layout">
      <header className="page-header">
        <h1>{title}</h1>
        {actions && <div className="actions">{actions}</div>}
      </header>
      <div className="page-body">{children}</div>
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      {
        element: <Workbench />,
        children: [
          { index: true, lazy: async () => ({ Component: (await import("./home")).Home }) },
          { path: "strategies", lazy: async () => ({ Component: (await import("./home")).Home }) },
          { path: "strategies/:id", lazy: async () => ({ Component: (await import("./strategy")).StrategyDetail }) },
          { path: "controls", lazy: async () => ({ Component: (await import("./strategy")).AllControls }) },
          { path: "hosts", lazy: async () => ({ Component: (await import("./hosts")).HostsPage }) },
          { path: "hosts/:id", lazy: async () => ({ Component: (await import("./hosts")).HostDetailPage }) },
          { path: "activity", lazy: async () => ({ Component: (await import("./activity")).ActivityPage }) },
          { path: "alerts", lazy: async () => ({ Component: (await import("./activity")).AlertsPage }) },
        ],
      },
      {
        path: "admin",
        element: <AdminRoute />,
        children: [
          { index: true, element: <Navigate to="dashboard" replace /> },
          { path: "dashboard", lazy: async () => ({ Component: (await import("../admin/pages")).AdminDashboard }) },
          { path: "notifications", lazy: async () => ({ Component: (await import("../admin/notifications")).default }) },
          { path: "themes", lazy: async () => ({ Component: (await import("../admin/themes")).default }) },
          { path: "strategies", lazy: async () => ({ Component: (await import("../admin/pages")).AdminStrategies }) },
          { path: "audit", lazy: async () => ({ Component: (await import("../admin/pages")).Audit }) },
          { path: "security", lazy: async () => ({ Component: (await import("../admin/pages")).Security }) },
          { path: "storage", lazy: async () => ({ Component: (await import("../admin/system")).Storage }) },
          { path: "settings", lazy: async () => ({ Component: (await import("../admin/system")).Settings }) },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
export function App() {
  return <RouterProvider router={router} />;
}

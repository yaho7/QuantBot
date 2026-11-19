import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
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
  useOutletContext,
} from "react-router-dom";
import { Link, NavLink } from "../shared/page-links";
import {
  RiLineChartLine as ChartNoAxesCombined,
  RiDashboardLine as LayoutDashboard,
  RiComputerLine as Monitor,
  RiMoonLine as Moon,
  RiSettings3Line as Settings,
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
import { RecentAlertBadge, useAttention, useRecentAlertCount } from "../components/attention-summary";
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
] as const;
const appearanceIcons = { system: Monitor, light: Sun, dark: Moon } as const;

function Root() {
  const session = useQuery({
    ...resource<Session>("/auth/session"),
    retry: false,
  });
  useRealtime(!!session.data);
  const recentAlerts = useRecentAlertCount(!!session.data);
  const appearance = useAppearance();
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      const theme = appearance === "system" ? (media.matches ? "dark" : "light") : appearance;
      document.documentElement.dataset.appearance = theme;
      document.documentElement.classList.toggle("dark", theme === "dark");
    };
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [appearance]);
  useEffect(() => {
    if (session.data) setCSRF(session.data.csrf);
  }, [session.data]);
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
  return (
    <TooltipProvider delay={350}>
      <Suspense fallback={<Loading />}>
        <Outlet context={recentAlerts} />
      </Suspense>
      <ScrollRestoration />
      <Toaster position="top-center" theme={appearance} />
    </TooltipProvider>
  );
}
function AppearanceToggle() {
  const { t } = useLanguage();
  const appearance = useAppearance();
  const ThemeIcon = appearanceIcons[appearance];
  const appearanceLabel = t("appearance") + ": " + t(appearance);
  return (
    <Tooltip>
      <TooltipTrigger render={
        <Button aria-label={appearanceLabel} size="icon" variant="ghost" onClick={() =>
          setAppearance(appearance === "system" ? "light" : appearance === "light" ? "dark" : "system")
        } />
      }><ThemeIcon aria-hidden="true" /></TooltipTrigger>
      <TooltipContent>{appearanceLabel}</TooltipContent>
    </Tooltip>
  );
}
function Brand() {
  return (
    <Link className="brand" to="/" aria-label="QuantBot">
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
  const recentCount = useOutletContext<number | undefined>();
  const recentAlerts = recentCount ?? 0;
  const query = useQuery(activeTheme);
  const location = useLocation();
  const navigation = useRef<HTMLElement>(null);
  const [failed, setFailed] = useState("");
  const theme = query.data;
  const identity = (theme?.id ?? "") + ":" + (theme?.revision ?? "");
  const fallback = !!query.error || (failed !== "" && failed === identity);
  const selected = fallback ? undefined : theme;
  // Frontend packages own the iframe, while host navigation and native pages
  // retain the original Classical shell and trusted controls.
  const hostTheme = selected?.manifest.type === "frontend" ? undefined : selected;
  const builtIn = fallback || !hostTheme || hostTheme.id === "classical";
  const onFailure = useCallback(() => setFailed(identity), [identity]);
  const full = location.pathname === "/" && selected?.entryUrl;
  useEffect(() => {
    const nav = navigation.current;
    const active = nav?.querySelector('[aria-current="page"]');
    if (!nav || !active) return;
    const reveal = () => {
      if (nav.scrollWidth <= nav.clientWidth) return;
      const viewport = nav.getBoundingClientRect();
      const link = active.getBoundingClientRect();
      const offset = Math.min(0, link.left - viewport.left) + Math.max(0, link.right - viewport.right);
      if (offset) nav.scrollBy({ left: offset });
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(nav);
    observer.observe(active);
    return () => observer.disconnect();
  }, [location.pathname]);
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
            <nav ref={navigation} aria-label={t("workbench")}>
              {monitor.map(([path, label, Icon]) => (
                <NavLink end={path === "/"} key={path} to={path} title={t(label)} aria-label={t(label)}>
                  <Icon size={18} strokeWidth={1.5} aria-hidden="true" />
                  <span className="nav-label">{t(label)}</span>
                </NavLink>
              ))}
            </nav>
            <div className="actions workbench-actions">
              <Link
                className="admin-link"
                to="/admin/dashboard"
                aria-label={t("admin")}
                aria-describedby={recentAlerts > 0 ? "admin-alert-count" : undefined}
                title={t("admin")}
              >
                <span className="admin-alert-anchor">
                  <Settings size={18} strokeWidth={1.5} aria-hidden="true" />
                  <RecentAlertBadge count={recentAlerts} descriptionId="admin-alert-count" />
                </span>
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
              <ThemeFrame key={identity} theme={selected} onFailure={onFailure} />
            ) : <Outlet context={{ ...attention, recentCount }} />}
          </RouteSurface>
        </main>
      </div>
    </ThemeContext.Provider>
  );
}
function AdminRoute() {
  const recentAlerts = useOutletContext<number | undefined>() ?? 0;
  return (
    <AdminShell brand={<Brand />} tools={<AppearanceToggle />} logout={<Logout />} recentAlerts={recentAlerts}>
      <RouteSurface><Outlet /></RouteSurface>
    </AdminShell>
  );
}
function AdminRedirect() {
  const { pathname, search, hash } = useLocation();
  return <Navigate to={{ pathname: "/admin" + pathname, search, hash }} replace />;
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
        ],
      },
      ...["hosts", "hosts/:id", "activity", "alerts"].map(path => ({ path, element: <AdminRedirect /> })),
      {
        path: "admin",
        element: <AdminRoute />,
        children: [
          { index: true, element: <Navigate to="dashboard" replace /> },
          { path: "dashboard", lazy: async () => ({ Component: (await import("../admin/pages")).AdminDashboard }) },
          { path: "hosts", lazy: async () => ({ Component: (await import("./hosts")).HostsPage }) },
          { path: "hosts/:id", lazy: async () => ({ Component: (await import("./hosts")).HostDetailPage }) },
          { path: "activity", lazy: async () => ({ Component: (await import("./activity")).ActivityPage }) },
          { path: "alerts", lazy: async () => ({ Component: (await import("./activity")).AlertsPage }) },
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

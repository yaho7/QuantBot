import { Icon as AstryxIcon } from "@astryxdesign/core/Icon";
import { LayoutEditingProvider } from "../shared/layout-editing";
import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { version } from "../../package.json";
import { Theme as AstryxTheme } from "@astryxdesign/core/theme";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import { AppShell } from "@astryxdesign/core/AppShell";
import { TopNav, TopNavItem } from "@astryxdesign/core/TopNav";
import {
  SideNav,
  SideNavHeading,
  SideNavItem,
  SideNavSection,
} from "@astryxdesign/core/SideNav";
import { LinkProvider } from "@astryxdesign/core/Link";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { Badge } from "@astryxdesign/core/Badge";
import { IconButton } from "@astryxdesign/core/IconButton";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import { Text } from "@astryxdesign/core/Text";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import {
  Navigate,
  Outlet,
  RouterProvider,
  ScrollRestoration,
  createBrowserRouter,
  useLocation,
} from "react-router-dom";
import { Link } from "../shared/page-links";
import {
  ArrowLeft,
  Bell,
  ChartNoAxesCombined,
  ClipboardList,
  Database,
  LayoutDashboard,
  Monitor,
  Moon,
  Settings,
  Server,
  Shield,
  SlidersHorizontal,
  Sun,
  LogOut,
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
import { useAttention } from "../components/attention-summary";
import { BrandIcon } from "../components/brand-icon";
import { usePalette } from "../shared/preferences";
import { useLanguage } from "../shared/i18n";
import { useRealtime } from "./realtime";
import { activeTheme, ThemeContext } from "../themes/catalog";
import { ThemeFrame, themeStyle, presentationTheme } from "../themes/host";
import { appTheme } from "../themes/quantbot-ui";
const Login = lazy(() =>
  import("./auth").then((module) => ({ default: module.Login })),
);

const monitor = [
  ["/", "workbench", LayoutDashboard],
  ["/strategies", "strategies", ChartNoAxesCombined],
  ["/controls", "controls", SlidersHorizontal],
  ["/hosts", "hosts", Server],
  ["/activity", "activity", ClipboardList],
  ["/alerts", "alerts", Bell],
] as const;
const management = [
  ["总览", [["dashboard", "dashboard", LayoutDashboard]]],
  [
    "管理",
    [
      ["strategies", "strategies", ChartNoAxesCombined],
      ["notifications", "notifications", Bell],
    ],
  ],
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
const AppearanceMode = createContext<"system" | "light" | "dark">("system");

function AstryxLink({ href, ...props }: React.ComponentProps<"a">) {
  return <Link to={href ?? "/"} {...props} />;
}
function Root() {
  const palette = usePalette();
  const session = useQuery({
    ...resource<Session>("/auth/session"),
    retry: false,
  });
  const connected = useRealtime(!!session.data);
  const { t, lang } = useLanguage();
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
  const appearance = mode === "light" || mode === "dark" ? mode : "system";
  const themed = (content: ReactNode) => (
    <InternationalizationProvider locale={lang === "zh" ? "zh-Hans" : "en"}>
      <AstryxTheme theme={appTheme(palette)} mode={appearance}>
        <LinkProvider component={AstryxLink}>{content}</LinkProvider>
      </AstryxTheme>
    </InternationalizationProvider>
  );
  if (session.isPending) return themed(<Loading />);
  if (
    session.error &&
    !(session.error instanceof ApiError && session.error.status === 401)
  )
    return themed(
      <ErrorView error={session.error} retry={() => void session.refetch()} />,
    );
  if (!session.data)
    return themed(
      <Suspense fallback={<Loading />}>
        <Login />
      </Suspense>,
    );
  setCSRF(session.data.csrf);
  const ThemeIcon = { system: Monitor, light: Sun, dark: Moon }[appearance];
  const tools = (
    <HStack gap={2} vAlign="center">
      <StatusDot
        variant={connected ? "success" : "warning"}
        label={t(connected ? "connected" : "reconnecting")}
        tooltip={t(connected ? "connected" : "reconnecting")}
      />
      <IconButton
        label={t("appearance") + ": " + t(appearance)}
        tooltip={t("appearance") + ": " + t(appearance)}
        variant="ghost"
        icon={<AstryxIcon icon={ThemeIcon} size="md" />}
        onClick={() =>
          setMode(
            appearance === "system"
              ? "light"
              : appearance === "light"
                ? "dark"
                : "system",
          )
        }
      />
    </HStack>
  );
  return themed(
    <AppearanceMode.Provider value={appearance}>
      <LayoutEditingProvider>
        <AppearanceTools.Provider value={tools}>
          <Suspense fallback={<Loading />}>
            <Outlet />
          </Suspense>
          <ScrollRestoration />
          <Toaster position="top-center" richColors />
        </AppearanceTools.Provider>
      </LayoutEditingProvider>
    </AppearanceMode.Provider>,
  );
}
function Brand() {
  return (
    <HStack gap={2} vAlign="center">
      <BrandIcon />
      <Text weight="semibold">QuantBot</Text>
    </HStack>
  );
}
function Logout() {
  const { t } = useLanguage();
  return (
    <IconButton
      variant="ghost"
      label={t("logout")}
      tooltip={t("logout")}
      icon={<AstryxIcon icon={LogOut} size="md" />}
      onClick={() =>
        void api("/auth/logout", "POST")
          .then(() => client.clear())
          .then(() => location.reload())
      }
    />
  );
}
function Workbench() {
  const { t } = useLanguage();
  const palette = usePalette();
  const mode = useContext(AppearanceMode);
  const attention = useAttention();
  const tools = useContext(AppearanceTools);
  const query = useQuery(activeTheme);
  const location = useLocation();
  const [failed, setFailed] = useState("");
  const theme = query.data;
  const identity = (theme?.id ?? "") + ":" + (theme?.revision ?? "");
  const fallback = !!query.error || (failed !== "" && failed === identity);
  const selected = fallback ? undefined : theme;
  const adaptedTheme = useMemo(
    () => presentationTheme(appTheme(palette), selected),
    [palette, selected],
  );
  const onFailure = useCallback(() => setFailed(identity), [identity]);
  const full =
    location.pathname === "/" &&
    selected?.entryUrl &&
    !new URLSearchParams(location.search).has("classic");
  return (
    <AstryxTheme theme={adaptedTheme} mode={mode}>
      <ThemeContext.Provider
        value={
          fallback
            ? { cardView: "compact" }
            : { ...selected?.presentation, portfolio: true }
        }
      >
        <VStack
          className="workbench-shell bg-cover bg-center min-h-screen"
          data-theme={selected?.id ?? "classical"}
          data-theme-palette={selected && !selected.builtin ? "" : undefined}
          data-theme-surface={selected?.presentation.surface}
          style={themeStyle(selected)}
        >
          <AppShell
            height="auto"
            variant="section"
            mobileNav={{ breakpoint: "xl" }}
            topNav={
              <TopNav
                label={t("workbench")}
                heading={<Brand />}
                startContent={monitor.map(([path, label, Icon]) => (
                  <TopNavItem
                    key={path}
                    href={path}
                    label={t(label)}
                    icon={<AstryxIcon icon={Icon} size="md" />}
                    isSelected={
                      path === "/"
                        ? location.pathname === "/"
                        : location.pathname.startsWith(path)
                    }
                  >
                    <HStack gap={2} vAlign="center">
                      <Text type="label">{t(label)}</Text>
                      {label === "alerts" && attention.count > 0 && (
                        <Badge label={attention.count} variant="red" />
                      )}
                    </HStack>
                  </TopNavItem>
                ))}
                endContent={
                  <HStack gap={1} vAlign="center">
                    {tools}
                    <IconButton
                      href="/admin/dashboard"
                      label={t("admin")}
                      tooltip={t("admin")}
                      variant="ghost"
                      icon={<AstryxIcon icon={Settings} size="md" />}
                    />
                    <Logout />
                  </HStack>
                }
              />
            }
          >
            <RouteSurface>
              {fallback && (
                <Banner status="warning" title={t("themeFallback")} />
              )}
              {full && selected ? (
                <VStack gap={4}>
                  <Button href="/?classic=1" label={t("themeHostView")} />
                  <ThemeFrame
                    key={identity}
                    theme={selected}
                    onFailure={onFailure}
                  />
                </VStack>
              ) : (
                <Outlet context={attention} />
              )}
            </RouteSurface>
          </AppShell>
        </VStack>
      </ThemeContext.Provider>
    </AstryxTheme>
  );
}
function AdminShell() {
  const { lang, t } = useLanguage();
  const tools = useContext(AppearanceTools);
  const location = useLocation();
  return (
    <AppShell
      height="auto"
      variant="wash"
      mobileNav={{ breakpoint: "md" }}
      sideNav={
        <SideNav
          aria-label={t("admin")}
          header={
            <SideNavHeading
              heading="QuantBot"
              subheading={t("admin")}
              icon={<BrandIcon />}
            />
          }
          footer={
            <VStack gap={3} padding={3}>
              <Button
                href="/"
                label={t("return")}
                icon={<AstryxIcon icon={ArrowLeft} size="sm" />}
                variant="ghost"
              />
              <HStack hAlign="between" vAlign="center">
                <Text type="supporting">v{version}</Text>
                {tools}
                <Logout />
              </HStack>
            </VStack>
          }
        >
          {management.map(([heading, links]) => (
            <SideNavSection
              key={heading}
              title={
                lang === "zh"
                  ? heading
                  : { 总览: "Overview", 管理: "Management", 系统: "System" }[
                      heading
                    ]
              }
            >
              {links.map(([path, label, Icon]) => (
                <SideNavItem
                  key={path}
                  href={"/admin/" + path}
                  label={t(label)}
                  icon={<AstryxIcon icon={Icon} size="md" />}
                  isSelected={location.pathname === "/admin/" + path}
                />
              ))}
            </SideNavSection>
          ))}
        </SideNav>
      }
    >
      <RouteSurface>
        <Outlet />
      </RouteSurface>
    </AppShell>
  );
}
function NotFound() {
  return (
    <EmptyState title="404" actions={<Button href="/" label="QuantBot" />} />
  );
}
function RouteSurface({ children }: { children: ReactNode }) {
  return (
    <VStack className="route-surface   min-w-0">
      <Suspense fallback={<Loading />}>{children}</Suspense>
    </VStack>
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
    <VStack
      gap={6}
      width="100%"
      maxWidth={1560}
      className="page-layout   mx-auto   min-w-0   px-4   py-6   md:px-8   md:py-8"
    >
      <HStack
        as="header"
        className="page-header"
        hAlign="between"
        vAlign="center"
        wrap="wrap"
        gap={4}
      >
        <Heading level={1} weight="semibold">
          {title}
        </Heading>
        {actions && (
          <HStack gap={2} wrap="wrap" vAlign="center">
            {actions}
          </HStack>
        )}
      </HStack>
      <VStack gap={6} className="page-body   min-w-0">
        {children}
      </VStack>
    </VStack>
  );
}

const router = createBrowserRouter([
  {
    element: <Root />,
    children: [
      {
        element: <Workbench />,
        children: [
          {
            index: true,
            lazy: async () => ({ Component: (await import("./home")).Home }),
          },
          {
            path: "strategies",
            lazy: async () => ({ Component: (await import("./home")).Home }),
          },
          {
            path: "strategies/:id",
            lazy: async () => ({
              Component: (await import("./strategy")).StrategyDetail,
            }),
          },
          {
            path: "controls",
            lazy: async () => ({
              Component: (await import("./strategy")).AllControls,
            }),
          },
          {
            path: "hosts",
            lazy: async () => ({
              Component: (await import("./hosts")).HostsPage,
            }),
          },
          {
            path: "hosts/:id",
            lazy: async () => ({
              Component: (await import("./hosts")).HostDetailPage,
            }),
          },
          {
            path: "activity",
            lazy: async () => ({
              Component: (await import("./activity")).ActivityPage,
            }),
          },
          {
            path: "alerts",
            lazy: async () => ({
              Component: (await import("./activity")).AlertsPage,
            }),
          },
        ],
      },
      {
        path: "admin",
        element: <AdminShell />,
        children: [
          { index: true, element: <Navigate to="dashboard" replace /> },
          {
            path: "dashboard",
            lazy: async () => ({
              Component: (await import("../admin/pages")).AdminDashboard,
            }),
          },
          {
            path: "notifications",
            lazy: async () => ({
              Component: (await import("../admin/notifications")).default,
            }),
          },
          {
            path: "themes",
            element: <Navigate to="/admin/settings" replace />,
          },
          {
            path: "strategies",
            lazy: async () => ({
              Component: (await import("../admin/pages")).AdminStrategies,
            }),
          },
          {
            path: "audit",
            lazy: async () => ({
              Component: (await import("../admin/pages")).Audit,
            }),
          },
          {
            path: "security",
            lazy: async () => ({
              Component: (await import("../admin/pages")).Security,
            }),
          },
          {
            path: "storage",
            lazy: async () => ({
              Component: (await import("../admin/system")).Storage,
            }),
          },
          {
            path: "settings",
            lazy: async () => ({
              Component: (await import("../admin/system")).Settings,
            }),
          },
        ],
      },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
export function App() {
  return <RouterProvider router={router} />;
}

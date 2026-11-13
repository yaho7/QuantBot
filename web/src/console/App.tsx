import { useTranslation } from "react-i18next";
import { LanguagePicker } from "./language-picker";
import { t } from "../i18n";
import { Toaster } from "sonner";
import { CommandFeedback } from "./command-feedback";
import { QuickSearch } from "./quick-search";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, CircleHelp, ClipboardList, LayoutDashboard, LayoutGrid, LogOut, Settings } from "lucide-react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api, ApiError, MIN_PASSWORD_LENGTH, readSession, sessionKey } from "./api";
import { ApiPage, CreateStrategy } from "./onboarding";
import { OperationsPage } from "./operations";
import { OverviewPage, StrategiesPage } from "./overview";
import { SystemPage, TelegramPage } from "./settings";
import { StrategyPage } from "./strategy";
import { DarkMode, useTheme } from "./theme";
import { Brand, ErrorNotice, Field, Loading } from "./ui";

const Workbench = lazy(() => import("./workbench"));

const nav = [
  { key: "workbench", title: "app.workbench", icon: LayoutDashboard },
  { key: "strategies", title: "app.strategies", icon: LayoutGrid },
  { key: "operations", title: "app.operations", icon: ClipboardList },
  { key: "telegram", title: "app.notifications", icon: Bell },
  { key: "system", title: "app.settings", icon: Settings },
] as const;

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const handler = () => setHash(location.hash);
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);
  return hash;
}

function useLive(enabled: boolean) {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const stream = new EventSource("/api/stream");
    let timer: number | undefined;
    const topics = new Set<string>();
    const update = (event: MessageEvent<string>) => {
      for (const topic of JSON.parse(event.data) as string[]) topics.add(topic);
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        const pending = new Set(topics);
        topics.clear();
        void client.invalidateQueries({ queryKey: ["live"], predicate: (query) => {
          const path = String(query.queryKey[1]);
          if (/^strategies\/[^/]+\/components$/.test(path)) return pending.has("metrics") || pending.has("telemetry");
          const overview = path === "overview" || path === "strategies" || /^strategies\/[^/?]+(?:\?.*)?$/.test(path);
          const activity = /^(commands|audit|alerts)(?:[/?]|$)|^strategies\/[^/]+\/(?:controls|events|dashboard)(?:[/?]|$)/.test(path);
          return (pending.has("operations") || pending.has("telemetry")) && (overview || activity);
        } });
      }, 2000);
    };
    stream.addEventListener("update", update);
    return () => { stream.close(); window.clearTimeout(timer); };
  }, [client, enabled]);
}

function Login({ hash }: { hash: string }) {
  const client = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const setup = useQuery({
    queryKey: ["setup"], queryFn: () => api<{ required: boolean; available: boolean }>("setup"),
    staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
  });
  const [confirmation, setConfirmation] = useState("");
  const creating = setup.data?.required === true && setup.data.available;
  const setupElsewhere = setup.data?.required === true && !setup.data.available;
  const [ticket] = useState(() => hash.startsWith("#login?") ? new URLSearchParams(hash.slice(7)).get("ticket") : null);
  const [linkError, setLinkError] = useState<unknown>();
  const usedLink = useRef(false);
  useEffect(() => {
    if (!ticket || usedLink.current || setup.data?.required !== false) return;
    usedLink.current = true;
    history.replaceState(null, "", "#workbench");
    void api("login/link", "POST", { ticket })
      .then(() => client.invalidateQueries({ queryKey: sessionKey }))
      .catch(setLinkError);
  }, [client, setup.data?.required, ticket]);
  const login = useMutation({
    mutationFn: () => {
      if (creating && [...password].length < MIN_PASSWORD_LENGTH) throw new Error(t("app.passwordMustBeAtLeastCharacters", { minimum: MIN_PASSWORD_LENGTH }));
      if (creating && password !== confirmation) throw new Error(t("app.passwordsDoNotMatch"));
      return api(creating ? "setup" : "login", "POST", { username, password });
    },
    onSuccess: async () => {
      if (creating) client.setQueryData(["setup"], { required: false, available: false });
      await client.invalidateQueries({ queryKey: sessionKey });
    },
    onError: (error) => {
      if (creating && error instanceof ApiError && error.status === 409) void setup.refetch();
    },
  });
  return <>
    <header className="topbar"><a href={import.meta.env.BASE_URL} aria-label={t("app.quantbotHome")}><Brand /></a><div className="top-actions"><LanguagePicker /></div></header>
    <main className="login">
      {setup.isPending ? <Loading /> : !setup.data ? <ConnectionError error={setup.error} retry={() => void setup.refetch()} /> : setupElsewhere ? <>
        <h1>{t("app.setUpQuantbot")}</h1>
        <p>{t("app.openTheConsoleOverHttps")}</p>
      </> : <>
        <h1>{creating ? t("app.setUpQuantbot") : t("app.signInToQuantbot")}</h1>
        <p>{creating ? t("app.createAnAdministratorAccountToOpenThe") : t("app.signInWithYourAdministratorAccount")}</p>
        <form className="panel stack" onSubmit={(e) => { e.preventDefault(); login.mutate(); }}>
          <Field label={t("app.username")}><input required name="username" spellCheck={false} maxLength={100} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
          <Field label={t("app.password")} hint={creating ? t("app.atLeastCharacters", { minimum: MIN_PASSWORD_LENGTH }) : undefined}><input required type="password"
            minLength={creating ? MIN_PASSWORD_LENGTH : undefined} maxLength={1024}
            autoComplete={creating ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {creating && <Field label={t("app.confirmPassword")}><input required type="password" autoComplete="new-password"
            maxLength={1024} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></Field>}
          <ErrorNotice error={login.error ?? linkError ?? setup.error} />
          <button className="button primary" disabled={login.isPending}>{creating ? t("app.createAdministrator") : t("app.signIn")}</button>
        </form>
      </>}
    </main>
  </>;
}

function ConnectionError({ error, retry }: { error: unknown; retry: () => void }) {
  return <div className="stack">
    <h1>{error instanceof ApiError ? t("app.quantbotIsTemporarilyUnavailable") : t("app.cannotConnectToQuantbot")}</h1>
    <ErrorNotice error={error} />
    <div><button type="button" className="button secondary" onClick={retry}>{t("app.retry")}</button></div>
  </div>;
}

export function App() {
  useTranslation();
  const hash = useHash();
  const client = useQueryClient();
  const session = useQuery({
    queryKey: sessionKey, queryFn: readSession,
    refetchInterval: (query) => query.state.data ? 12_000 : false,
    refetchOnWindowFocus: (query) => !!query.state.data,
    refetchOnReconnect: (query) => !!query.state.data,
  });
  const [adding, setAdding] = useState(false);
  const { theme, setTheme, dark } = useTheme();
  const actor = session.data?.actor;
  useLive(!!actor);
  const logout = useMutation({
    mutationFn: () => api("logout", "POST"),
    onSuccess: () => {
      client.clear();
      location.reload();
    },
  });
  if (session.isPending) return <main className="loading-screen"><Brand /><Loading /></main>;
  if (session.data === null) return <Login hash={hash} />;
  if (!actor) return <main className="login"><ConnectionError error={session.error} retry={() => void session.refetch()} /></main>;
  const [section, id, tab] = hash.slice(1).split("/");
  const page = section === "strategy" ? "strategies" : ["overview", "api"].includes(section ?? "") || nav.some((item) => item.key === section) ? section : "workbench";
  const add = () => setAdding(true);
  return <DarkMode value={dark}>
    <a className="skip-link" href="#main" onClick={(event) => {
      event.preventDefault();
      document.getElementById("main")?.focus();
    }}>{t("app.skipToContent")}</a>
    <header className="topbar console-topbar">
      <a href="#workbench" aria-label={t("app.quantbotWorkbench")}><Brand /></a>
      <nav className="top-nav" aria-label={t("app.mainNavigation")}>
        {nav.map(({ key, title: label, icon: Icon }) => <a href={`#${key}`}
          key={key} aria-current={page === key ? "page" : undefined}>
          <Icon size={16} /><span>{t(label)}</span></a>)}
      </nav>
      <div className="top-actions">
        <LanguagePicker />
        <QuickSearch strategyId={id && (section === "strategy" || section === "workbench") ? decodeURIComponent(id) : undefined} />
        <a className="icon-button" href="https://github.com/yaho7/QuantBot/blob/main/PROTOCOL.md" target="_blank" rel="noreferrer" aria-label={t("app.apiDocumentation")} title={t("app.apiDocumentation")}><CircleHelp size={18} /></a>
        <button className="icon-button" onClick={() => logout.mutate()} aria-label={t("app.signOut")} title={t("app.signOut")}><LogOut size={18} /></button>
      </div>
    </header>
    <nav className="bottom-nav" aria-label={t("app.mobileNavigation")}>
      {nav.map(({ key, title, icon: Icon }) => <a key={key} href={`#${key}`}
        aria-current={page === key ? "page" : undefined}><Icon size={19} /><span>{t(title)}</span></a>)}
    </nav>
    <main id="main" className="page" tabIndex={-1}>
      <ErrorNotice error={logout.error} />
      {page === "workbench" && <Suspense fallback={<Loading />}><Workbench add={add} focus={tab ? decodeURIComponent(tab) : undefined} strategyId={id ? decodeURIComponent(id) : undefined} /></Suspense>}
      {page === "overview" && <OverviewPage add={add} />}
      {page === "strategies" && (section === "strategy" && id ?
        <StrategyPage key={id} strategyId={decodeURIComponent(id)} tab={tab} /> : <StrategiesPage add={add} />)}
      {page === "api" && <ApiPage strategyId={id ? decodeURIComponent(id) : undefined} />}
      {page === "operations" && <OperationsPage commandId={id} />}
      {page === "telegram" && <TelegramPage />}
      {page === "system" && <SystemPage theme={theme} onTheme={setTheme} />}
    </main>
    <CommandFeedback />
    <Toaster theme={dark ? "dark" : "light"} position="top-right" />
    {adding && <CreateStrategy close={() => setAdding(false)} />}
  </DarkMode>;
}

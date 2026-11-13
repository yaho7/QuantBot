import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bell, Braces, CircleHelp, ClipboardList, LayoutDashboard, LayoutGrid, LogOut, Menu, Settings } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, MIN_PASSWORD_LENGTH, readSession, sessionKey } from "./api";
import { ApiPage, CreateStrategy } from "./onboarding";
import { OperationsPage } from "./operations";
import { OverviewPage, StrategiesPage } from "./overview";
import { SystemPage, TelegramPage } from "./settings";
import { StrategyPage } from "./strategy";
import { DarkMode, useTheme } from "./theme";
import { Brand, ErrorNotice, Field, Loading } from "./ui";

const nav = [
  { key: "overview", title: "运行总览", icon: LayoutDashboard },
  { key: "strategies", title: "策略", icon: LayoutGrid },
  { key: "api", title: "API 接入", icon: Braces },
  { key: "operations", title: "操作记录", icon: ClipboardList },
  { key: "telegram", title: "通知与 Telegram", icon: Bell },
  { key: "system", title: "系统设置", icon: Settings },
];

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
    history.replaceState(null, "", "#overview");
    void api("login/link", "POST", { ticket })
      .then(() => client.invalidateQueries({ queryKey: sessionKey }))
      .catch(setLinkError);
  }, [client, setup.data?.required, ticket]);
  const login = useMutation({
    mutationFn: () => {
      if (creating && [...password].length < MIN_PASSWORD_LENGTH) throw new Error(`密码至少 ${MIN_PASSWORD_LENGTH} 个字符`);
      if (creating && password !== confirmation) throw new Error("两次输入的密码不一致");
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
    <header className="topbar"><a href={import.meta.env.BASE_URL} aria-label="QuantBot 首页"><Brand /></a></header>
    <main className="login">
      {setup.isPending ? <Loading /> : !setup.data ? <ConnectionError error={setup.error} retry={() => void setup.refetch()} /> : setupElsewhere ? <>
        <h1>初始化 QuantBot</h1>
        <p>请使用 HTTPS 地址打开控制台。</p>
      </> : <>
        <h1>{creating ? "初始化 QuantBot" : "登录 QuantBot"}</h1>
        <p>{creating ? "创建管理员账号，完成后进入控制台。" : "使用管理员账号进入控制台。"}</p>
        <form className="panel stack" onSubmit={(e) => { e.preventDefault(); login.mutate(); }}>
          <Field label="用户名"><input required maxLength={100} autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
          <Field label="密码" hint={creating ? `至少 ${MIN_PASSWORD_LENGTH} 个字符` : undefined}><input required type="password"
            minLength={creating ? MIN_PASSWORD_LENGTH : undefined} maxLength={1024}
            autoComplete={creating ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          {creating && <Field label="确认密码"><input required type="password" autoComplete="new-password"
            maxLength={1024} value={confirmation} onChange={(e) => setConfirmation(e.target.value)} /></Field>}
          <ErrorNotice error={login.error ?? linkError ?? setup.error} />
          <button className="button primary" disabled={login.isPending}>{creating ? "创建管理员" : "登录"}</button>
        </form>
      </>}
    </main>
  </>;
}

function ConnectionError({ error, retry }: { error: unknown; retry: () => void }) {
  return <div className="stack">
    <h1>{error instanceof ApiError ? "QuantBot 服务暂不可用" : "无法连接 QuantBot"}</h1>
    <ErrorNotice error={error} />
    <div><button type="button" className="button secondary" onClick={retry}>重试</button></div>
  </div>;
}

export function App() {
  const hash = useHash();
  const client = useQueryClient();
  const session = useQuery({
    queryKey: sessionKey, queryFn: readSession,
    refetchInterval: (query) => query.state.data ? 12_000 : false,
    refetchOnWindowFocus: (query) => !!query.state.data,
    refetchOnReconnect: (query) => !!query.state.data,
  });
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
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
  const page = section === "strategy" ? "strategies" : nav.some((item) => item.key === section) ? section : "overview";
  const add = () => setAdding(true);
  return <DarkMode value={dark}>
    <header className="topbar" onKeyDown={(event) => {
      if (event.key === "Escape" && menu) {
        setMenu(false);
        menuButton.current?.focus();
      }
    }}>
      <a href="#overview" onClick={() => setMenu(false)} aria-label="QuantBot 总览"><Brand /></a>
      <button className="icon-button hamburger" ref={menuButton} aria-label={menu ? "关闭导航" : "打开导航"}
        aria-controls="main-navigation" aria-expanded={menu} onClick={() => setMenu(!menu)}><Menu size={20} /></button>
      <nav id="main-navigation" className={`top-nav${menu ? " open" : ""}`} aria-label="主导航">
        {nav.map(({ key, title: label, icon: Icon }) => <a href={`#${key}`}
          onClick={() => setMenu(false)} key={key} aria-current={page === key ? "page" : undefined}>
          <Icon size={16} /><span>{label}</span></a>)}
      </nav>
      <div className="top-actions">
        <a className="icon-button" href="https://github.com/yaho7/QuantBot/blob/main/PROTOCOL.md" target="_blank" rel="noreferrer" aria-label="API 文档" title="API 文档"><CircleHelp size={18} /></a>
        <button className="icon-button" onClick={() => logout.mutate()} aria-label="退出登录" title="退出登录"><LogOut size={18} /></button>
      </div>
    </header>
    <main id="main" className="page">
      <ErrorNotice error={logout.error} />
      {page === "overview" && <OverviewPage add={add} />}
      {page === "strategies" && (section === "strategy" && id ?
        <StrategyPage key={id} strategyId={decodeURIComponent(id)} tab={tab} /> : <StrategiesPage add={add} />)}
      {page === "api" && <ApiPage strategyId={id ? decodeURIComponent(id) : undefined} />}
      {page === "operations" && <OperationsPage commandId={id} />}
      {page === "telegram" && <TelegramPage />}
      {page === "system" && <SystemPage theme={theme} onTheme={setTheme} />}
    </main>
    {adding && <CreateStrategy close={() => setAdding(false)} />}
  </DarkMode>;
}

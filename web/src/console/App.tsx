import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Activity, Bell, ChevronRight, CircleHelp, ClipboardList, LayoutDashboard, LogOut, Menu, Plus, Radio, Settings, Braces, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import { ApiPage, CreateStrategy } from "./onboarding";
import { OperationsPage } from "./operations";
import { OverviewPage, StrategiesPage } from "./overview";
import { SystemPage, TelegramPage } from "./settings";
import { StrategyPage } from "./strategy";
import { Brand, ErrorNotice, Field, Loading, useData } from "./ui";

const nav = [
  { key: "overview", title: "运行总览", icon: LayoutDashboard },
  { key: "strategies", title: "策略", icon: Activity },
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
    const stream = new EventSource("/api/v2/stream");
    let timer: number | undefined;
    const update = () => {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void client.invalidateQueries({ queryKey: ["live"] });
      }, 1200);
    };
    stream.addEventListener("update", update);
    return () => { stream.close(); window.clearTimeout(timer); };
  }, [client, enabled]);
}

function Login({ hash }: { hash: string }) {
  const client = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [ticket] = useState(() => hash.startsWith("#login?") ? new URLSearchParams(hash.slice(7)).get("ticket") : null);
  const [linkError, setLinkError] = useState<unknown>();
  const usedLink = useRef(false);
  useEffect(() => {
    if (!ticket || usedLink.current) return;
    usedLink.current = true;
    history.replaceState(null, "", "#overview");
    void api("login/link", "POST", { ticket })
      .then(() => client.invalidateQueries({ queryKey: ["live", "session"] }))
      .catch(setLinkError);
  }, [client, ticket]);
  const login = useMutation({
    mutationFn: () => api("login", "POST", { username, password }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["live", "session"] }),
  });
  return <main className="login">
    <section className="login-story">
      <Brand /><div className="login-copy"><span className="login-eyebrow"><Radio size={17} /> 策略监控与远程控制</span>
        <h1>交易程序独立运行，<br />状态集中查看。</h1></div>
      <div className="login-decoration" aria-hidden="true"><Activity /></div>
    </section>
    <section className="login-form"><div className="login-content">
      <h2>登录 QuantBot</h2><p>使用管理员账号进入控制台。</p>
      <form className="stack" onSubmit={(e) => { e.preventDefault(); login.mutate(); }}>
        <Field label="用户名"><input required autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
        <Field label="密码"><input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <ErrorNotice error={login.error ?? linkError} />
        <button className="button primary" disabled={login.isPending}>登录 <ChevronRight size={17} /></button>
      </form>
    </div></section>
  </main>;
}

export function App() {
  const hash = useHash();
  const client = useQueryClient();
  const session = useData<{ actor: string }>("session");
  const [adding, setAdding] = useState(false);
  const [menu, setMenu] = useState(false);
  const actor = session.data?.actor;
  const expired = session.error instanceof ApiError && session.error.status === 401;
  useLive(!!actor && !expired);
  const logout = useMutation({
    mutationFn: () => api("logout", "POST"),
    onSuccess: () => {
      client.clear();
      location.reload();
    },
  });
  if (session.isPending) return <main className="loading-screen"><Brand /><Loading /></main>;
  if (expired || !actor) return <Login hash={hash} />;
  const [section, id, tab] = hash.slice(1).split("/");
  const page = section === "strategy" ? "strategies" : nav.some((item) => item.key === section) ? section : "overview";
  const title = nav.find((item) => item.key === page)?.title;
  const add = () => setAdding(true);
  return <div className="shell">
    {menu && <button className="nav-scrim" aria-label="关闭导航" onClick={() => setMenu(false)} />}
    <aside className={`sidebar ${menu ? "open" : ""}`}>
      <a href="#overview" onClick={() => setMenu(false)} aria-label="QuantBot 总览"><Brand /></a>
      <button className="icon-button sidebar-close" aria-label="关闭导航" onClick={() => setMenu(false)}><X size={20} /></button>
      <nav aria-label="主导航">{nav.map(({ key, title: label, icon: Icon }) => <a href={`#${key}`}
        onClick={() => setMenu(false)} key={key} aria-current={page === key ? "page" : undefined}><Icon size={19} />
        <span>{label}</span>{page === key && <ChevronRight className="nav-caret" size={14} />}</a>)}</nav>
      <div className="sidebar-footer"><a href="/docs"><CircleHelp size={18} /> API 文档</a>
        <button onClick={() => logout.mutate()}><LogOut size={18} /> 退出登录</button></div>
    </aside>
    <div className="main-frame">
      <header className="topbar">
        <div><button className="icon-button hamburger" aria-label="打开导航" onClick={() => setMenu(!menu)}><Menu size={22} /></button>
          <span className="top-label">控制台</span><ChevronRight size={15} /><strong>{title}</strong></div>
        <div><button className="icon-button mobile-add" aria-label="添加策略" onClick={add}><Plus size={20} /></button>
          <span className="avatar" aria-label={actor}>{(actor.split(":").at(-1)?.[0] ?? "A").toUpperCase()}</span>
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
        {page === "system" && <SystemPage />}
      </main>
    </div>
    {adding && <CreateStrategy close={() => setAdding(false)} />}
  </div>;
}

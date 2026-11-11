import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { RefreshCw, SquareTerminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert, Badge, Card } from "@/components/ui/primitives";
import { tr } from "@/lib/i18n";

type Connection = "connecting" | "connected" | "closed";

export default function WorkspaceTerminal({ path }: { path: string }) {
  const [attempt, setAttempt] = useState(0);
  return <TerminalSession key={attempt} path={path} onReconnect={() => setAttempt((count) => count + 1)} />;
}

function TerminalSession({ path, onReconnect }: { path: string; onReconnect: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [latency, setLatency] = useState<number>();
  const [error, setError] = useState("");

  useEffect(() => {
    const target = host.current;
    if (!target) return;
    const theme = () => {
      const style = getComputedStyle(document.documentElement);
      const foreground = style.getPropertyValue("--foreground").trim();
      return { background: style.getPropertyValue("--card").trim(), foreground, cursor: foreground };
    };
    const terminal = new Terminal({ fontSize: 13, fontFamily: "ui-monospace, monospace", scrollback: 3000, theme: theme() });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(target);
    const observer = new MutationObserver(() => { terminal.options.theme = theme(); });
    observer.observe(document.documentElement, { attributeFilter: ["class"] });

    const url = new URL("/ui/api/workspace/terminal", location.href);
    if (path) url.searchParams.set("path", path);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    const encoder = new TextEncoder();
    let connected = false;
    let lastPong = 0;
    const send = (data: object) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
    };
    const size = () => {
      if (!target.clientWidth || !target.clientHeight) return;
      fit.fit();
      if (connected) send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
    };
    const resize = new ResizeObserver(size);
    resize.observe(target);
    const input = terminal.onData((data) => {
      if (connected && socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 131_072) {
        socket.send(encoder.encode(data));
      }
    });
    function ping() {
      if (!connected) return;
      const sent = performance.now();
      if (sent - lastPong > 15_000) setLatency(undefined);
      send({ type: "ping", sent });
    }
    const timer = window.setInterval(ping, 5_000);

    socket.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(event.data));
        return;
      }
      const data = JSON.parse(event.data);
      if (data.type === "ready") {
        connected = true;
        setConnection("connected");
        size();
        ping();
        terminal.focus();
      } else if (data.type === "pong") {
        lastPong = performance.now();
        setLatency(Math.max(1, Math.round(lastPong - data.sent)));
      } else if (data.type === "error") {
        setError(data.message);
      }
    };
    socket.onerror = () => setError(tr("连不上工作区终端，请检查服务器配置后重试。"));
    socket.onclose = () => {
      connected = false;
      setConnection("closed");
      setLatency(undefined);
    };
    return () => {
      socket.onclose = socket.onerror = socket.onmessage = null;
      socket.close();
      window.clearInterval(timer);
      resize.disconnect();
      observer.disconnect();
      input.dispose();
      terminal.dispose();
    };
  }, [path]);

  const status = {
    connecting: tr("正在连接…"),
    connected: tr("已连接"),
    closed: tr("已断开"),
  }[connection];

  return (
    <Card className="min-w-0 overflow-hidden">
      <header className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b px-3 py-1.5">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <SquareTerminal className="size-4 shrink-0" /> {tr("终端")}
          {path && <code className="truncate text-xs text-muted-foreground" title={path}>{path}</code>}
        </h2>
        <div className="flex items-center gap-2">
          <Badge tone={connection === "connected" ? "gain" : "neutral"}>{status}</Badge>
          {connection === "connected" && (
            <span className="font-mono text-xs tabular-nums text-muted-foreground" title={tr("浏览器到终端的往返时间")}>
              {tr("延迟")} {latency === undefined ? "—" : `${latency} ms`}
            </span>
          )}
          {connection === "closed" && (
            <Button variant="ghost" size="sm" onClick={onReconnect}><RefreshCw /> {tr("重新连接")}</Button>
          )}
        </div>
      </header>
      {error && <div className="p-3"><Alert tone="loss">{error}</Alert></div>}
      <div className="p-2"><div ref={host} className="h-[min(42vh,26rem)] min-h-48 w-full" /></div>
    </Card>
  );
}

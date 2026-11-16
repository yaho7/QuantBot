import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Link } from "../shared/page-links";
import { ControlCard } from "../app/control";
import { client, resource, type Registry, type Strategy } from "../shared/api";
import { readThemeStrategy } from "./bridge-data";
import { useLanguage } from "../shared/i18n";
import { ErrorView, Loading, Modal } from "../shared/ui";
import type { Palette, Theme } from "./catalog";

const paletteTokens: Record<keyof Palette, string> = {
  background: "--canvas",
  surface: "--surface",
  foreground: "--text",
  muted: "--muted",
  border: "--line",
  accent: "--accent",
  positive: "--success",
  negative: "--danger",
  chart: "--theme-chart",
};
const fonts: Record<string, string> = {
  inter: "Inter, system-ui, sans-serif",
  geist: "Geist, system-ui, sans-serif",
  "ibm-plex-mono": '"IBM Plex Mono", monospace',
  system: "system-ui, sans-serif",
};

export function themeStyle(theme?: Theme): CSSProperties {
  if (!theme) return {};
  const p = theme.presentation;
  const style: Record<string, string> = {};
  for (const [appearance, palette] of [
    ["light", p.light],
    ["dark", p.dark],
  ] as const) {
    for (const [name, color] of Object.entries(palette ?? {})) {
      if (/^#[a-f\d]{6}$/i.test(color) && name in paletteTokens)
        style[paletteTokens[name as keyof Palette] + "-" + appearance] = color;
    }
  }
  if (p.radius !== undefined) style["--radius"] = p.radius + "px";
  if (p.gap !== undefined) style["--gap"] = p.gap + "px";
  const font = p.font && fonts[p.font];
  if (font) style.fontFamily = font;
  if (p.background && theme.assetBase && theme.assets?.includes(p.background))
    style.backgroundImage =
      'url("' +
      theme.assetBase +
      p.background.split("/").map(encodeURIComponent).join("/") +
      '")';
  return style;
}

type ControlRequest = { strategyId: string; controlId: string };

export function ThemeFrame({
  theme,
  onFailure,
}: {
  theme: Theme;
  onFailure: () => void;
}) {
  const navigate = useNavigate();
  const { lang } = useLanguage();
  const language = useRef(lang);
  language.current = lang;
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState<number>();
  const [control, setControl] = useState<ControlRequest>();
  const strategies = useQuery(resource<Strategy[]>("/strategies"));
  const strategyData = useRef(strategies.data);
  strategyData.current = strategies.data;
  const settings = useRef(theme.settings);
  settings.current = theme.settings;
  const controlOpen = useRef(false);
  useEffect(() => {
    const timeout = window.setTimeout(onFailure, 5000);
    let navigationCount = 0;
    const element = frame.current;
    const navigation = () => {
      if (++navigationCount > 1) onFailure();
    };
    element?.addEventListener("load", navigation);
    let acknowledged = false;
    let lastControl = 0;
    let windowStarted = Date.now();
    let count = 0;
    let reads = 0;
    const send = (message: object) =>
      frame.current?.contentWindow?.postMessage(
        { version: 1, ...message },
        "*",
      );
    const context = () => ({
      language: language.current,
      appearance: document.documentElement.dataset.appearance === "dark" ? "dark" : "light",
      palette: document.documentElement.dataset.palette ?? "forest",
    });
    const observer = new MutationObserver(() => {
      if (acknowledged) send({ type: "quantbot:context", ...context() });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-appearance", "data-palette", "lang"] });
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== "null"
      )
        return;
      const message = event.data;
      if (!message || message.version !== 1 || typeof message.type !== "string")
        return;
      const now = Date.now();
      if (now - windowStarted >= 1000) {
        windowStarted = now;
        count = 0;
      }
      if (++count > 12) return;
      if (message.type === "quantbot:ready") {
        if (acknowledged) return;
        acknowledged = true;
        clearTimeout(timeout);
        setReady(true);
        send({ type: "quantbot:ready", settings: settings.current, ...context() });
        return;
      }
      if (!acknowledged) return;
      if (message.type === "quantbot:error") {
        onFailure();
        return;
      }
      if (message.type === "quantbot:resize" && Number.isInteger(message.height) && message.height >= 320 && message.height <= 8000) {
        setHeight(message.height);
        return;
      }
      if (
        typeof message.requestId !== "string" ||
        !/^[\w.-]{1,64}$/.test(message.requestId)
      )
        return;
      if (message.type === "quantbot:strategies") {
        void client.fetchQuery(resource<Strategy[]>("/strategies")).then(rows => {
        const items = rows.map(
          ({ id, name, group, online, mode, lastSeen }) => ({
            id,
            name,
            group,
            online,
            mode,
            lastSeen,
          }),
        );
        send({
          type: "quantbot:strategies",
          requestId: message.requestId,
          items,
        });
        }).catch(() => send({ type: "quantbot:strategies", requestId: message.requestId, error: "unavailable" }));
        return;
      }
      const allowedStrategy = (strategyData.current ?? client.getQueryData<Strategy[]>(["/strategies"]))?.some(row => row.id === message.strategyId);
      if (message.type === "quantbot:strategy" && allowedStrategy && [1, 24, 168, 720].includes(message.hours) && reads < 2) {
        reads++;
        void readThemeStrategy(message.strategyId, message.hours).then(data => {
          send({ type: "quantbot:strategy", requestId: message.requestId, data });
        }).catch(() => send({ type: "quantbot:strategy", requestId: message.requestId, error: "unavailable" })).finally(() => { reads--; });
        return;
      }
      if (message.type === "quantbot:open-strategy" && allowedStrategy) {
        navigate("/strategies/" + encodeURIComponent(message.strategyId));
        return;
      }
      if (
        message.type === "quantbot:control" &&
        !controlOpen.current &&
        now - lastControl >= 1000 &&
        typeof message.controlId === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(message.controlId) &&
        strategyData.current?.some(
          (strategy) => strategy.id === message.strategyId,
        )
      ) {
        lastControl = now;
        controlOpen.current = true;
        setControl({
          strategyId: message.strategyId,
          controlId: message.controlId,
        });
        send({
          type: "quantbot:control",
          requestId: message.requestId,
          opened: true,
        });
      }
    };
    window.addEventListener("message", receive);
    return () => {
      clearTimeout(timeout);
      observer.disconnect();
      window.removeEventListener("message", receive);
      element?.removeEventListener("load", navigation);
    };
  }, [onFailure, navigate]);
  return (
    <>
      {!ready && <Loading />}
      <iframe
        ref={frame}
        src={theme.entryUrl}
        title={theme.manifest.name}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className="theme-frame"
        style={{ visibility: ready ? "visible" : "hidden", height }}
      />
      {control && (
        <TrustedControl
          selection={control}
          close={() => {
            controlOpen.current = false;
            setControl(undefined);
          }}
        />
      )}
    </>
  );
}

function TrustedControl({
  selection,
  close,
}: {
  selection: ControlRequest;
  close: () => void;
}) {
  const { t } = useLanguage();
  const registry = useQuery(
    resource<Registry>("/strategies/" + selection.strategyId + "/controls"),
  );
  const selected = registry.data?.controls.find(
    (entry) => entry.id === selection.controlId,
  );
  return (
    <Modal
      title={t("controls")}
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      {registry.isPending ? (
        <Loading />
      ) : registry.error ? (
        <ErrorView error={registry.error} />
      ) : selected && registry.data ? (
        <ControlCard
          control={selected}
          strategyId={selection.strategyId}
          registry={registry.data}
        />
      ) : (
        <Link to={"/strategies/" + selection.strategyId}>
          {t("unavailable")}
        </Link>
      )}
    </Modal>
  );
}

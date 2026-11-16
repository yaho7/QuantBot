import { defineTheme, type DefinedTheme } from "@astryxdesign/core/theme";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "../shared/page-links";
import { ControlCard } from "../app/control";
import { resource, type Registry, type Strategy } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { ErrorView, Loading, Modal } from "../shared/ui";
import type { Palette, Theme } from "./catalog";

const paletteTokens: Record<keyof Palette, string> = {
  background: "--color-background-body",
  surface: "--color-background-surface",
  foreground: "--color-text-primary",
  muted: "--color-text-secondary",
  border: "--color-border",
  accent: "--color-accent",
  positive: "--color-text-green",
  negative: "--color-text-red",
  chart: "--theme-chart",
};
const fonts: Record<string, string> = {
  inter: "Inter, system-ui, sans-serif",
  geist: "Geist, system-ui, sans-serif",
  "ibm-plex-mono": '"IBM Plex Mono", monospace',
  system: "system-ui, sans-serif",
};

// Runtime themes are used only for administrator-installed, declarative branding.
// The same Astryx token API applies; these tokens never enter the admin shell.
export function presentationTheme(base: DefinedTheme, theme?: Theme) {
  if (!theme || theme.builtin) return base;
  const p = theme.presentation;
  const tokens: Record<string, string | [string, string]> = {};
  for (const [key, token] of Object.entries(paletteTokens)) {
    const light = p.light?.[key as keyof Palette],
      dark = p.dark?.[key as keyof Palette];
    const valid = (value?: string): value is string =>
      !!value && /^#[a-f\d]{6}$/i.test(value);
    if (valid(light) || valid(dark))
      tokens[token] = [
        valid(light) ? light : dark!,
        valid(dark) ? dark : light!,
      ];
  }
  if (tokens["--color-background-surface"]) {
    tokens["--color-background-card"] = tokens["--color-background-surface"];
    tokens["--color-background-popover"] = tokens["--color-background-surface"];
  }
  if (tokens["--color-accent"]) {
    tokens["--color-text-accent"] = tokens["--color-accent"];
    tokens["--color-icon-accent"] = tokens["--color-accent"];
  }
  if (p.radius !== undefined) tokens["--radius-container"] = p.radius + "px";
  if (p.gap !== undefined) tokens["--spacing-4"] = p.gap + "px";
  const font = p.font && fonts[p.font];
  if (font) {
    tokens["--font-family-body"] = font;
    tokens["--font-family-heading"] = font;
  }
  return defineTheme({
    name: "installed-" + theme.id + "-" + theme.revision,
    extends: base,
    tokens,
    components:
      p.surface === "glass"
        ? {
            card: {
              base: {
                background:
                  "color-mix(in srgb, var(--color-background-card) 84%, transparent)",
                backdropFilter: "blur(var(--spacing-3))",
              },
            },
          }
        : undefined,
  });
}
export function themeStyle(theme?: Theme): CSSProperties {
  const p = theme?.presentation;
  if (p?.background && theme?.assetBase && theme.assets?.includes(p.background))
    return {
      backgroundImage:
        'url("' +
        theme.assetBase +
        p.background.split("/").map(encodeURIComponent).join("/") +
        '")',
    };
  return {};
}

type ControlRequest = { strategyId: string; controlId: string };

export function ThemeFrame({
  theme,
  onFailure,
}: {
  theme: Theme;
  onFailure: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
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
    const send = (message: object) =>
      frame.current?.contentWindow?.postMessage(
        { version: 1, ...message },
        "*",
      );
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
        send({ type: "quantbot:ready", settings: settings.current });
        return;
      }
      if (!acknowledged) return;
      if (message.type === "quantbot:error") {
        onFailure();
        return;
      }
      if (
        typeof message.requestId !== "string" ||
        !/^[\w.-]{1,64}$/.test(message.requestId)
      )
        return;
      if (message.type === "quantbot:strategies") {
        const items = (strategyData.current ?? []).map(
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
      window.removeEventListener("message", receive);
      element?.removeEventListener("load", navigation);
    };
  }, [onFailure]);
  return (
    <>
      {!ready && <Loading />}
      <iframe
        ref={frame}
        src={theme.entryUrl}
        title={theme.manifest.name}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        className={"theme-frame " + (ready ? "visible" : "invisible")}
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

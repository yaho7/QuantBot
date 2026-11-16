import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Page } from "../app/App";
import { api, client, resource } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { Badge, ErrorView, Loading, Modal } from "../shared/ui";
import { activeTheme, type Theme } from "../themes/catalog";

const catalog = resource<{ active: string; themes: Theme[] }>("/admin/themes");

export default function ThemeAdmin() {
  const { t } = useLanguage();
  const list = useQuery(catalog);
  const [file, setFile] = useState<File>();
  const [settings, setSettings] = useState<Theme>();
  const [preview, setPreview] = useState<Theme>();
  const mutation = useMutation({
    mutationFn: async ({
      method,
      path,
      body,
    }: {
      method: string;
      path: string;
      body?: unknown;
    }) => {
      if (body === "bundled-astryx") {
        const response = await fetch("/astryx-theme.zip");
        if (!response.ok) throw new Error(t("unavailable"));
        body = new File([await response.blob()], "astryx-theme.zip", { type: "application/zip" });
      }
      if (body instanceof File) {
        const session = await api<{ csrf: string }>("/auth/session");
        const result = await fetch("/api" + path, {
          method,
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/zip",
            "X-CSRF-Token": session.csrf,
          },
          body,
        });
        if (!result.ok) {
          const problem = await result.json().catch(() => null);
          throw new Error(problem?.message ?? result.statusText);
        }
        return;
      }
      await api(path, method, body);
    },
    onSuccess: () => {
      setFile(undefined);
      setSettings(undefined);
      void client.invalidateQueries({ queryKey: catalog.queryKey });
      void client.invalidateQueries({ queryKey: activeTheme.queryKey });
    },
  });
  const activate = (id: string) =>
    mutation.mutate({
      method: "PUT",
      path: "/admin/themes/active",
      body: { id },
    });

  return (
    <Page title={t("themes")}>
      <form
        className="inline-form section"
        onSubmit={(event) => {
          event.preventDefault();
          if (file)
            mutation.mutate({
              method: "POST",
              path: "/admin/themes",
              body: file,
            });
        }}
      >
        <button type="button" disabled={mutation.isPending || !!list.data?.themes.some(theme => theme.id === "astryx")}
          onClick={() => mutation.mutate({ method: "POST", path: "/admin/themes", body: "bundled-astryx" })}>
          {t("installAstryx")}
        </button>
        <a href="/astryx-theme.zip" download>{t("themeDownload")}</a>
        <label>
          {t("themeZip")}{" "}
          <input
            type="file"
            accept=".zip,application/zip"
            onChange={(event) => setFile(event.target.files?.[0])}
          />
        </label>
        <button className="primary" disabled={!file || mutation.isPending}>
          {t("themeUpload")}
        </button>
        <button
          type="button"
          onClick={() => activate("classical")}
          disabled={mutation.isPending}
        >
          {t("themeRestore")}
        </button>
      </form>
      {mutation.error && (
        <p className="error-text" role="alert">
          {mutation.error.message}
        </p>
      )}
      {list.isPending ? (
        <Loading />
      ) : list.error ? (
        <ErrorView error={list.error} />
      ) : (
        <div className="two-columns">
          {list.data?.themes.map((theme) => (
            <article className="surface padded" key={theme.id}>
              <header className="section-heading">
                <h2>{theme.manifest.name}</h2>
                {theme.id === list.data.active && (
                  <Badge tone="success">{t("themeActive")}</Badge>
                )}
              </header>
              {theme.manifest.description && (
                <p>{theme.manifest.description}</p>
              )}
              {theme.manifest.version && (
                <p className="muted">
                  {[theme.manifest.author, theme.manifest.version]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              {!theme.available && (
                <p className="warning">{t("unavailable")}</p>
              )}
              <div className="actions">
                <button
                  disabled={
                    !theme.available ||
                    theme.id === list.data.active ||
                    mutation.isPending
                  }
                  onClick={() => activate(theme.id)}
                >
                  {t("themeActivate")}
                </button>
                {theme.previewUrl && (
                  <button onClick={() => setPreview(theme)}>
                    {t("themePreview")}
                  </button>
                )}
                {!!theme.fields?.length && (
                  <button onClick={() => setSettings(theme)}>
                    {t("themeSettings")}
                  </button>
                )}
                {theme.previousRevision && (
                  <button
                    disabled={mutation.isPending}
                    onClick={() =>
                      mutation.mutate({
                        method: "POST",
                        path: "/admin/themes/" + theme.id + "/rollback",
                      })
                    }
                  >
                    {t("themeRollback")}
                  </button>
                )}
                {!theme.builtin && (
                  <button
                    className="danger"
                    disabled={mutation.isPending}
                    onClick={() => {
                      if (window.confirm(t("themeDeleteConfirm")))
                        mutation.mutate({
                          method: "DELETE",
                          path: "/admin/themes/" + theme.id,
                        });
                    }}
                  >
                    {t("themeDelete")}
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      {settings && (
        <ThemeSettings
          theme={settings}
          pending={mutation.isPending}
          close={() => setSettings(undefined)}
          save={(body) =>
            mutation.mutate({
              method: "PUT",
              path: "/admin/themes/" + settings.id + "/settings",
              body,
            })
          }
        />
      )}
      {preview && (
        <Modal
          title={preview.manifest.name}
          open
          onOpenChange={(open) => {
            if (!open) setPreview(undefined);
          }}
        >
          <img
            className="theme-preview"
            src={preview.previewUrl}
            alt={preview.manifest.name}
          />
        </Modal>
      )}
    </Page>
  );
}

function ThemeSettings({
  theme,
  pending,
  close,
  save,
}: {
  theme: Theme;
  pending: boolean;
  close: () => void;
  save: (body: Theme["settings"]) => void;
}) {
  const { t } = useLanguage();
  const [values, setValues] = useState(theme.settings);
  return (
    <Modal
      title={theme.manifest.name + " · " + t("themeSettings")}
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          save(values);
        }}
      >
        {theme.fields?.map((field) => {
          const value = values[field.key] ?? field.default;
          const set = (next: string | boolean | number) =>
            setValues({ ...values, [field.key]: next });
          const asset = field.type === "image" || field.type === "background";
          const numeric = field.type === "number" || field.type === "slider";
          return (
            <label key={field.key}>
              {field.label}
              {field.type === "switch" ? (
                <input
                  type="checkbox"
                  checked={value === true}
                  onChange={(e) => set(e.target.checked)}
                />
              ) : asset || field.type === "select" ? (
                <select
                  value={String(value)}
                  onChange={(e) => set(e.target.value)}
                >
                  {asset && <option value="">{t("empty")}</option>}
                  {(asset ? theme.assets : field.options)?.map((option) => (
                    <option key={option}>{option}</option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.type === "slider" ? "range" : field.type}
                  value={String(value)}
                  min={field.min}
                  max={field.max}
                  step={numeric ? "any" : undefined}
                  onChange={(e) =>
                    set(numeric ? e.target.valueAsNumber : e.target.value)
                  }
                />
              )}
            </label>
          );
        })}
        <button className="primary" disabled={pending}>
          {t("save")}
        </button>
      </form>
    </Modal>
  );
}

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
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
      if (body === "bundled-lyra") {
        const response = await fetch("/lyra-theme.zip");
        if (!response.ok) throw new Error(t("unavailable"));
        body = new File([await response.blob()], "lyra-theme.zip", { type: "application/zip" });
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
        <Button type="button" variant="outline" disabled={mutation.isPending || !!list.data?.themes.some(theme => theme.id === "lyra")}
          onClick={() => mutation.mutate({ method: "POST", path: "/admin/themes", body: "bundled-lyra" })}>
          {t("installLyra")}
        </Button>
        <a className={buttonVariants({ variant: "outline" })} href="/lyra-theme.zip" download>{t("themeDownload")}</a>
        <Field className="min-w-0 flex-1">
          <FieldLabel htmlFor="theme-zip">{t("themeZip")}</FieldLabel>
          <Input id="theme-zip" type="file" accept=".zip,application/zip"
            onChange={event => setFile(event.target.files?.[0])} />
        </Field>
        <Button type="submit" disabled={!file || mutation.isPending}>
          {t("themeUpload")}
        </Button>
        <Button
          type="button" variant="outline"
          onClick={() => activate("classical")}
          disabled={mutation.isPending}
        >
          {t("themeRestore")}
        </Button>
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
            <article key={theme.id}>
              <Card>
                <CardHeader>
                  <h2 className="text-base font-medium">{theme.manifest.name}</h2>
                  {theme.id === list.data.active && (
                    <CardAction><Badge tone="success">{t("themeActive")}</Badge></CardAction>
                  )}
                </CardHeader>
                <CardContent className="grid gap-2">
                  {theme.manifest.description && (
                    <p>{theme.manifest.description}</p>
                  )}
                  {theme.manifest.version && (
                    <p className="text-muted-foreground">
                      {[theme.manifest.author, theme.manifest.version]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                  {!theme.available && (
                    <p className="warning">{t("unavailable")}</p>
                  )}
                </CardContent>
                <CardFooter className="flex-wrap gap-2">
                  <Button variant="outline"
                    disabled={
                      !theme.available ||
                      theme.id === list.data.active ||
                      mutation.isPending
                    }
                    onClick={() => activate(theme.id)}
                  >
                    {t("themeActivate")}
                  </Button>
                  {theme.previewUrl && (
                    <Button variant="outline" onClick={() => setPreview(theme)}>
                      {t("themePreview")}
                    </Button>
                  )}
                  {!!theme.fields?.length && (
                    <Button variant="outline" onClick={() => setSettings(theme)}>
                      {t("themeSettings")}
                    </Button>
                  )}
                  {theme.previousRevision && (
                    <Button variant="outline"
                      disabled={mutation.isPending}
                      onClick={() =>
                        mutation.mutate({
                          method: "POST",
                          path: "/admin/themes/" + theme.id + "/rollback",
                        })
                      }
                    >
                      {t("themeRollback")}
                    </Button>
                  )}
                  {!theme.builtin && (
                    <Button variant="destructive"
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
                    </Button>
                  )}
                </CardFooter>
              </Card>
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
          const id = "theme-setting-" + field.key;
          return (
            <Field key={field.key} orientation={field.type === "switch" ? "horizontal" : "vertical"}>
              <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
              {field.type === "switch" ? (
                <Switch id={id} checked={value === true} onCheckedChange={set} />
              ) : asset || field.type === "select" ? (
                <NativeSelect id={id} value={String(value)} onChange={event => set(event.target.value)}>
                  {asset && <NativeSelectOption value="">{t("empty")}</NativeSelectOption>}
                  {(asset ? theme.assets : field.options)?.map(option => (
                    <NativeSelectOption key={option}>{option}</NativeSelectOption>
                  ))}
                </NativeSelect>
              ) : (
                <Input
                  id={id}
                  type={field.type === "slider" ? "range" : field.type}
                  className={field.type === "slider" ? "accent-primary" : undefined}
                  value={String(value)}
                  min={field.min}
                  max={field.max}
                  step={numeric ? "any" : undefined}
                  onChange={event => set(numeric ? event.target.valueAsNumber : event.target.value)}
                />
              )}
            </Field>
          );
        })}
        <Button type="submit" disabled={pending}>
          {t("save")}
        </Button>
      </form>
    </Modal>
  );
}

import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Heading } from "@astryxdesign/core/Heading";
import { Table } from "@astryxdesign/core/Table";
import { VStack } from "@astryxdesign/core/VStack";
import { DisplayPreferences } from "../components/display-preferences";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Page } from "../app/App";
import { resource, type Diagnostics } from "../shared/api";
import { useLanguage } from "../shared/i18n";
import { ErrorView, Loading } from "../shared/ui";

function useDiagnostics() {
  return useQuery({
    ...resource<Diagnostics>("/admin/diagnostics"),
    refetchInterval: 10_000,
  });
}

const commands = {
  "Docker Compose": [
    "docker compose stop quantbot",
    "docker compose run --rm --no-deps quantbot backup /data/backup.zip",
    "docker compose run --rm --no-deps -e QB_DATA_DIR=/data/restored quantbot restore /data/backup.zip",
  ].join("\n"),
  "Linux": [
    "systemctl --user stop quantbot",
    "QB_DATA_DIR=/path/to/data quantbot backup /path/to/backup.zip",
    "QB_DATA_DIR=/path/to/restored quantbot restore /path/to/backup.zip",
    "QB_DATA_DIR=/path/to/restored quantbot doctor",
  ].join("\n"),
};

export function Storage() {
  const { t, lang } = useLanguage();
  const query = useDiagnostics();
  const format = new Intl.NumberFormat(lang, {
    maximumFractionDigits: 2,
    style: "unit",
    unit: "megabyte",
    unitDisplay: "short",
  });
  const size = (bytes?: number) =>
    bytes === undefined ? "—" : format.format(bytes / 1_000_000);
  return (
    <Page title={t("storage")}>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} retry={() => void query.refetch()} />
      ) : (
        <Card padding={0}><Table
          data={["control", "metrics"].map(name => ({
            name: name + ".db", size: size(query.data.databaseBytes[name]), wal: size(query.data.walBytes[name]),
          }))}
          columns={[{ key: "name", header: "SQLite" }, { key: "size", header: t("databaseSize"), align: "end" },
            { key: "wal", header: "WAL", align: "end" }]}
          idKey="name" /></Card>
      )}
      <Card padding={4}><VStack as="section" gap={4}>
        <Heading level={2}>{t("backupRestore")}</Heading>
        <p className="muted">{t("backupHint")}</p>
        <p className="muted">{t("restoreHint")}</p>
        {Object.entries(commands).map(([name, snippet]) => (
          <VStack key={name} gap={2} hAlign="start">
            <Heading level={3}>{name}</Heading>
            <pre>{snippet}</pre>
            <Button label={t("copy") + " " + name} onClick={async () => {
              try { await navigator.clipboard.writeText(snippet); toast.success(t("copied")); }
              catch { toast.error(t("copyFailed")); }
            }} />
          </VStack>
        ))}
      </VStack></Card>
    </Page>
  );
}

export function Settings() {
  const { t, lang } = useLanguage();
  const query = useDiagnostics();
  const unit = (value: number, unit: "second" | "millisecond") =>
    new Intl.NumberFormat(lang, { style: "unit", unit }).format(value);
  const settings = query.data?.settings;
  return (
    <Page title={t("settings")}>
      <DisplayPreferences />
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorView error={query.error} retry={() => void query.refetch()} />
      ) : settings ? (
        <Card padding={4}><VStack as="section" gap={3}>
          <Heading level={2}>{t("runtimeSettings")}</Heading>
          <p className="muted">{t("runtimeHint")}</p>
          <dl className="system-dl">
            {[
              [t("hostVersion"), query.data.version],
              [t("sessionLifetime"), unit(settings.sessionSeconds, "second")],
              [t("renewBefore"), unit(settings.renewBeforeSeconds, "second")],
              [t("heartbeatInterval"), unit(settings.heartbeatSeconds, "second")],
              [t("offlineAfter"), unit(settings.offlineSeconds, "second")],
              [t("maxPoll"), unit(settings.commandPollSeconds, "second")],
              [t("metricsQueue"), settings.metricsQueue],
              [t("metricsBatch"), settings.metricsBatch],
              [t("metricsFlush"), unit(settings.metricsFlushMilliseconds, "millisecond")],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </VStack></Card>
      ) : null}
    </Page>
  );
}

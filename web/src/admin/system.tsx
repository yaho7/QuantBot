import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
        <Card className="py-0">
          <Table className="admin-data-table" aria-label={t("storage")}>
            <TableHeader>
              <TableRow>
                <TableHead>SQLite</TableHead>
                <TableHead className="text-end">{t("databaseSize")}</TableHead>
                <TableHead className="text-end">WAL</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {["control", "metrics"].map(name => (
                <TableRow key={name}>
                  <TableCell>{name}.db</TableCell>
                  <TableCell className="text-end">{size(query.data.databaseBytes[name])}</TableCell>
                  <TableCell className="text-end">{size(query.data.walBytes[name])}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <Card>
        <CardHeader>
          <h2 className="text-base font-medium">{t("backupRestore")}</h2>
          <CardDescription>{t("backupHint")}</CardDescription>
          <CardDescription>{t("restoreHint")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          {Object.entries(commands).map(([name, snippet]) => (
            <div key={name} className="grid min-w-0 justify-items-start gap-2">
              <h3>{name}</h3>
              <pre className="max-w-full">{snippet}</pre>
              <Button variant="outline" onClick={async () => {
                try { await navigator.clipboard.writeText(snippet); toast.success(t("copied")); }
                catch { toast.error(t("copyFailed")); }
              }}>{t("copy") + " " + name}</Button>
            </div>
          ))}
        </CardContent>
      </Card>
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
        <Card>
          <CardHeader>
            <h2 className="text-base font-medium">{t("runtimeSettings")}</h2>
            <CardDescription>{t("runtimeHint")}</CardDescription>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
      ) : null}
    </Page>
  );
}

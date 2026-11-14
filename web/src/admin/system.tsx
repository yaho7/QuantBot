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
        <div className="surface table-scroll">
          <table>
            <thead>
              <tr>
                <th>SQLite</th>
                <th>{t("databaseSize")}</th>
                <th>WAL</th>
              </tr>
            </thead>
            <tbody>
              {["control", "metrics"].map((name) => (
                <tr key={name}>
                  <th scope="row">{name}.db</th>
                  <td>{size(query.data.databaseBytes[name])}</td>
                  <td>{size(query.data.walBytes[name])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="section surface padded">
        <h2>{t("backupRestore")}</h2>
        <p className="muted">{t("backupHint")}</p>
        <p className="muted">{t("restoreHint")}</p>
        {Object.entries(commands).map(([name, snippet]) => (
          <div key={name}>
            <h3>{name}</h3>
            <pre>{snippet}</pre>
            <button
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(snippet)
                  .catch(() => toast.error(t("copyFailed")))
              }
            >
              {t("copy")} {name}
            </button>
          </div>
        ))}
      </section>
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
        <section className="surface padded">
          <h2>{t("runtimeSettings")}</h2>
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
        </section>
      ) : null}
    </Page>
  );
}

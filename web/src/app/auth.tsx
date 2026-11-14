import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { BrandIcon } from "../components/brand-icon";
import { z } from "zod";
import { api, client, resource, setCSRF, type Session } from "../shared/api";
import { ErrorView, Loading } from "../shared/ui";
import { useLanguage, setLanguage } from "../shared/i18n";

export function Login() {
  const { lang, t } = useLanguage();
  const setup = useQuery(resource<{ required: boolean }>("/auth/setup"));
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const mutation = useMutation({
    mutationFn: async () => {
      z.string().min(3).max(48).parse(username);
      z.string()
        .min(setup.data?.required ? 12 : 1)
        .max(256)
        .parse(password);
      return api<Session>(
        setup.data?.required ? "/auth/setup" : "/auth/login",
        "POST",
        { username, password },
      );
    },
    onSuccess: (session) => {
      setCSRF(session.csrf);
      client.setQueryData(["/auth/session"], session);
    },
  });
  return (
    <main className="login-page">
      <section className="login-card">
        <div className="brand">
          <BrandIcon />
          <strong>QuantBot</strong>
          <small>3.0</small>
        </div>
        {setup.isPending ? (
          <Loading />
        ) : setup.error ? (
          <ErrorView error={setup.error} retry={() => void setup.refetch()} />
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              mutation.mutate();
            }}
          >
            <h1>{setup.data.required ? t("setup") : t("login")}</h1>
            <p className="muted">
              {setup.data.required ? t("setupHint") : t("loginHint")}
            </p>
            <label>
              {t("username")}
              <input
                autoComplete="username"
                required
                autoFocus
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </label>
            <label>
              {t("password")}
              <input
                type="password"
                autoComplete={
                  setup.data.required ? "new-password" : "current-password"
                }
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
            {mutation.error && (
              <p role="alert" className="error-text">
                {mutation.error.message}
              </p>
            )}
            <button className="primary" disabled={mutation.isPending}>
              {setup.data.required ? t("setup") : t("login")}
            </button>
          </form>
        )}
        <button
          className="text-button"
          onClick={() => setLanguage(lang === "zh" ? "en" : "zh")}
        >
          {lang === "zh" ? "English" : "简体中文"}
        </button>
      </section>
    </main>
  );
}

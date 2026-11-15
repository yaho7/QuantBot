import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { version } from "../../package.json";
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
          <small>{version}</small>
        </div>
        {setup.isPending ? (
          <Loading />
        ) : setup.error ? (
          <ErrorView error={setup.error} retry={() => void setup.refetch()} />
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (username && password && !mutation.isPending) mutation.mutate();
            }}
          >
            <Heading level={1}>{setup.data.required ? t("setup") : t("login")}</Heading>
            <Text as="p" type="supporting">{setup.data.required ? t("setupHint") : t("loginHint")}</Text>
            <TextInput label={t("username")} autoComplete="username" htmlName="username" isRequired
              hasAutoFocus value={username} onChange={setUsername} />
            <TextInput label={t("password")} type="password" htmlName="password"
              autoComplete={setup.data.required ? "new-password" : "current-password"} isRequired
              value={password} onChange={setPassword} />
            {mutation.error && (
              <p role="alert" className="error-text">
                {mutation.error.message}
              </p>
            )}
            <Button variant="primary" type="submit" label={setup.data.required ? t("setup") : t("login")}
              isLoading={mutation.isPending} isDisabled={!username || !password} />
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

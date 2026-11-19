import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { RiLoader4Line as LoaderCircle } from "@remixicon/react";
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
        .min(setup.data?.required ? 8 : 1)
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
  const title = setup.data?.required ? t("setup") : t("login");
  return (
    <main className="flex min-h-svh w-full items-center justify-center bg-background p-6 md:p-10">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="brand mb-3">
            <BrandIcon />
            <strong>QuantBot</strong>
            <small className="text-muted-foreground tabular-nums">{version}</small>
          </div>
          {setup.data && (
            <>
              <h1 className="text-xl font-semibold">{title}</h1>
              <CardDescription>{setup.data.required ? t("setupHint") : t("loginHint")}</CardDescription>
            </>
          )}
        </CardHeader>
        <CardContent>
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
              <FieldGroup className="gap-4">
                <Field>
                  <FieldLabel htmlFor="login-username">{t("username")}</FieldLabel>
                  <Input id="login-username" name="username" autoComplete="username"
                    autoFocus required value={username} onChange={(event) => setUsername(event.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="login-password">{t("password")}</FieldLabel>
                  <Input id="login-password" name="password" type="password" required
                    autoComplete={setup.data.required ? "new-password" : "current-password"}
                    value={password} onChange={(event) => setPassword(event.target.value)} />
                </Field>
                {mutation.error && (
                  <Alert variant="destructive">
                    <AlertDescription>{mutation.error.message}</AlertDescription>
                  </Alert>
                )}
                <Button type="submit" disabled={mutation.isPending || !username || !password}
                  aria-busy={mutation.isPending} className="w-full">
                  {mutation.isPending && <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}
                  {title}
                </Button>
              </FieldGroup>
            </form>
          )}
        </CardContent>
        <CardFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => setLanguage(lang === "zh" ? "en" : "zh")}>
            {lang === "zh" ? "English" : "简体中文"}
          </Button>
        </CardFooter>
      </Card>
    </main>
  );
}

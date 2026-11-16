import { VStack } from "@astryxdesign/core/VStack";
import { Banner } from "@astryxdesign/core/Banner";
import { Card } from "@astryxdesign/core/Card";
import { HStack } from "@astryxdesign/core/HStack";
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
    <VStack
      as="main"
      minHeight="100dvh"
      vAlign="center"
      hAlign="center"
      padding={5}
      className="bg-body"
    >
      <Card padding={6} width="100%" maxWidth="26rem">
        <VStack gap={6}>
          <HStack gap={3} vAlign="center">
            <BrandIcon />
            <VStack gap={1}>
              <Text weight="semibold">QuantBot</Text>
              <Text type="supporting">v{version}</Text>
            </VStack>
          </HStack>
          {setup.isPending ? (
            <Loading />
          ) : setup.error ? (
            <ErrorView error={setup.error} retry={() => void setup.refetch()} />
          ) : (
            <VStack
              as="form"
              gap={5}
              onSubmit={(event: React.FormEvent) => {
                event.preventDefault();
                if (username && password && !mutation.isPending)
                  mutation.mutate();
              }}
            >
              <VStack gap={2}>
                <Heading level={1}>
                  {setup.data.required ? t("setup") : t("login")}
                </Heading>
                <Text type="supporting">
                  {setup.data.required ? t("setupHint") : t("loginHint")}
                </Text>
              </VStack>
              <TextInput
                label={t("username")}
                autoComplete="username"
                htmlName="username"
                isRequired
                hasAutoFocus
                value={username}
                onChange={setUsername}
              />
              <TextInput
                label={t("password")}
                type="password"
                htmlName="password"
                autoComplete={
                  setup.data.required ? "new-password" : "current-password"
                }
                isRequired
                value={password}
                onChange={setPassword}
              />
              {mutation.error && (
                <Banner
                  status="error"
                  title={t("error")}
                  description={mutation.error.message}
                />
              )}
              <Button
                variant="primary"
                type="submit"
                label={setup.data.required ? t("setup") : t("login")}
                isLoading={mutation.isPending}
                isDisabled={!username || !password}
                width="100%"
              />
            </VStack>
          )}
          <Button
            variant="ghost"
            label={lang === "zh" ? "English" : "简体中文"}
            onClick={() => setLanguage(lang === "zh" ? "en" : "zh")}
          />
        </VStack>
      </Card>
    </VStack>
  );
}

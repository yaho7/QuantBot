import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { RiContrast2Line, RiTranslate2 } from "@remixicon/react";
import { setLanguage, useLanguage } from "../shared/i18n";
import { appearanceOptions, setAppearance, useAppearance } from "../shared/preferences";
import { Choices } from "../shared/ui";

export function DisplayPreferences() {
  const { lang, t } = useLanguage();
  const appearance = useAppearance();

  return (
    <Card className="display-preferences">
      <CardHeader><h2 className="text-base font-semibold">{t("appearance")}</h2></CardHeader>
      <CardContent className="grid gap-5">
        <fieldset className="grid gap-2">
          <legend className="mb-2 flex items-center gap-2 text-sm font-medium">
            <RiTranslate2 size={16} aria-hidden="true" />{t("language")}
          </legend>
          <Choices label={t("language")} value={lang} select={setLanguage}
            options={[{ value: "zh", label: "简体中文" }, { value: "en", label: "English" }]} />
        </fieldset>
        <fieldset className="grid gap-2">
          <legend className="mb-2 flex items-center gap-2 text-sm font-medium">
            <RiContrast2Line size={16} aria-hidden="true" />{t("appearance")}
          </legend>
          <Choices label={t("appearance")} value={appearance} select={setAppearance}
            options={appearanceOptions.map(value => ({ value, label: t(value) }))} />
        </fieldset>
      </CardContent>
    </Card>
  );
}

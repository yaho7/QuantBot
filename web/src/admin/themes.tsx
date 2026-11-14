import { Page } from "../app/App";
import { useLanguage } from "../shared/i18n";
import { DisplayPreferences } from "../components/display-preferences";

export default function ThemeAdmin() {
  const { t } = useLanguage();
  return <Page title={t("themes")}><DisplayPreferences /></Page>;
}

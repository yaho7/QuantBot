// The quantbot theme. `astryx experimental theme editor` wrote this file once and never changes it again.
// The checked settings live in quantbot.settings.json and the generated quantbot.settings.ts;
// change them with `astryx experimental theme editor set quantbot ...`. Add your own changes below: they win over the settings.
import {defineTheme} from '@astryxdesign/core/theme';
import {quantbotSettings} from './quantbot.settings';

export const quantbotTheme = defineTheme({
  extends: quantbotSettings,
  name: 'quantbot',
});

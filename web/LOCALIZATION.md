# Console localization

The console uses i18next and react-i18next. Its locale catalogs live in
`src/locales/en.json` and `src/locales/zh-CN.json`. The language selector is
available on the sign-in screen and in the console header. A browser preference
is used until the user makes an explicit choice, which is saved locally.

- Add the same semantic key to both catalogs. Use a feature prefix such as
  `sandbox` and a short name describing the message's purpose.
- Use `t("feature.message", { name })` in the component or helper. Keep complete
  messages in the catalog and use named placeholders for variable content.
- Keep translation keys in module-level lists and resolve them while rendering.
  Use language-independent IDs for options, route segments, and saved values.
- Translate built-in labels by their stable identifiers. Preserve strategy
  names, custom widget titles, and agent-supplied content.
- Use `Intl` with the active language for presentation. Keep protocol fields
  and machine-readable timestamps independent of the display language.
- Run `npm run check:i18n` to check catalog parity and placeholder consistency.
  The production build also runs this check.

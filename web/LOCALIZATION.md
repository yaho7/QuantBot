# Interface languages

The QuantBot 3.0 interface supports English and Simplified Chinese. Shared messages are defined in `src/shared/i18n.ts`. Use `useLanguage().t` for interface labels and add both translations when extending the catalog. The language preference is stored in `qb.language` and can be changed from the floating appearance controls.

Agent-supplied names, descriptions, metric units, control values and report content preserve their original text. Protocol scopes and diagnostic units use their documented technical names.

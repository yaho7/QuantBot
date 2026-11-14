# Interface languages

The QuantBot 3.0 interface supports English and Simplified Chinese. Shared messages are defined in `src/shared/i18n.ts`. Use `useLanguage().t` for interface labels and add both translations when extending the catalog. The language preference is stored in `qb.language` and can be changed from the floating appearance controls.

The interface translates built-in labels, strict protocol enums and actual JSON booleans at display time. This leaves stored data and command payloads unchanged. Control choices display the labels declared by the Agent. Agents should provide human-readable names, descriptions, choice labels, and reasons in the language their users expect. Custom strings, enum values without labels, identifiers, and custom schema keys are displayed as reported; a string such as "true" is not interpreted as a boolean.

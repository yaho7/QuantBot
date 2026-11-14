# Classical appearance

Classical (`classical`) is the sole enabled theme and the default for both
new and existing installations. It retains the former Lumina dashboard layout.
The theme API lists only Classical. Theme upload, package settings, rollback,
and deletion routes are no longer exposed; existing package files are not deleted.

Settings > Appearance provides Forest, Ocean, Violet, Amber, and Graphite
palettes. The selected palette is applied to both the monitoring workspace and
the trusted settings/admin UI, including light and dark mode. Palette choice is
stored in the current browser (`qb.palette`) and synchronized across its tabs.

Language selection (Simplified Chinese / English) is in Settings, with a language
icon. The workbench settings gear opens this page directly. The former language
text toggle is removed from the navigation rail. Saved widget layouts are unaffected.

## Widget editing

Resize updates the actual card once per animation frame. Width is stored as an
integer percentage (1% steps), height in 8px steps. Content-width minimums prevent
cards becoming unusably narrow. Mouse, touch, and arrow keys are supported.

Viewports up to 600px select a separate mobile layout key; wider viewports use the
desktop key. An edit session stays bound to its starting layout until Done, so a
window resize cannot redirect an in-progress save. Each device layout starts with
its own suggestions and stores independent order, visibility, width, and height.

Changes are saved after 500ms of inactivity, with one request in flight at a time.
The UI shows pending/saved/error state. Failed saves retain the draft for retry;
Undo is itself saved. Done is available after the current draft is persisted.
Scrollbar tracks are hidden; scrollable card content uses subtle edge shadows.

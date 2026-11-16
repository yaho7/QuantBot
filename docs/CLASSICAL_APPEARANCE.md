# Classical appearance

Classical (`classical`) remains the default and retains the original dashboard
and administration layouts. Astryx is now an optional frontend theme package.
Install it from Administration > Themes and explicitly enable it to replace the
monitoring home. Restore Classical to return to the original view. Administration,
strategy pages and trusted command flows remain owned by the host.

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

## Dashboard interaction

- Attention items precede the portfolio: offline strategies, reported error
  states, confirmations, and commands whose outcome is unknown.
- Device preview tabs select desktop or mobile without changing browser width.
  While editing, the selection is locked. Mobile editing can copy desktop
  widgets into a single-column layout, with overwrite confirmation and undo.
- A saved indicator replaces the former save-status button; failures expose
  Retry. The primary Done action waits for persistence.
- Widget density follows actual measured width and height. Secondary descriptions
  and details recede in smaller cards; an Expand action opens full details.
- Scrollable widget bodies and tables show small directional arrows only while
  more content is available. Clicking scrolls; 2px motion is disabled for reduced
  motion preferences. The earlier edge-shadow hint has been removed.
- Commands show claim, execution, and receipt stages. A success receipt is not
  labelled as independently verified actual state. Unknown outcomes block new
  execution and link to the existing receipt/reconciliation dialog.

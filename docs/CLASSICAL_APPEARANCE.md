# Classical appearance

Classical (`classical`) is the default interface. The overview pairs an equity
chart with strategy status and puts the saved widget board below. A labeled rail
on desktop becomes a bottom bar on phones. Administration has its own navigation
and uses a modal drawer on mobile.

The optional Lyra theme package can replace the monitoring home. Install and
enable it from Administration > Themes. Restore Classical to return to the
default overview. The host handles administration, strategy pages, and command
confirmation.

Settings > Appearance supports System, Light, and Dark. The selected mode is
applied to both the monitoring workspace and administration and synchronized
across tabs in the current browser. The Lyra preset uses a neutral palette.

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

- The status panel shows online and offline counts. Select a strategy in the
  panel or from the equity chart to change the series. The alerts navigation
  carries the count of items needing attention.
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

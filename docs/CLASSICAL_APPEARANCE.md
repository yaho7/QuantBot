# Classical appearance

Classical (`classical`) is the default interface. The overview opens with a
full-width equity chart. Strategy status and the attention queue sit below it,
followed by the saved widget board. The workbench uses a single sticky top bar
with navigation aligned beside the brand. Links display icons only when there
is insufficient room for their labels. Strategy detail
places runtime status beside equity on desktop and stacks the panels on mobile.
Administration uses its own command bar and grouped navigation, with a modal
drawer on mobile.

The workbench opens the active theme at `/`. Install, enable, or restore themes
from Administration > Themes. If the active theme fails, the workbench loads
Classical. The host handles administration, strategy pages, and command confirmation.

Settings > Appearance supports System, Light, and Dark. The selected mode is
applied to both the monitoring workspace and administration and synchronized
across tabs in the current browser. The Lyra preset uses a neutral palette.

Language selection (Simplified Chinese / English) is in Administration >
Settings. The appearance toggle is in the administration toolbar.

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
  panel or from the equity chart to change the series. Hosts, Activity, and
  Alerts are under Monitoring in Administration. Recent alert counts appear on
  the workbench administration icon, the administration Alerts item, and the
  mobile administration toolbar.
- The strategy directory uses one display dropdown for cards and list. The
  built-in directory keeps the selected view when the page reloads.
- The attention queue links to commands awaiting confirmation, commands with
  unknown execution outcomes, and warning or more severe alerts received in the
  last 15 minutes.
- Mobile editing can copy desktop widgets into a single-column layout, with
  overwrite confirmation and undo.
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

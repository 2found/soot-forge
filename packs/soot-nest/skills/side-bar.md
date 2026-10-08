# Nest tool area

Nest renders each selected pack's `interface.tool_area` in the right sidebar.
This skill describes the desktop surface; it does not grant browser access.
Browser access comes from the browser-use capability selected by the Soot.

Use the tool's existing actions; Nest renders the same conversation's session.
Do not open a second browser or invent an iframe URL. Tabs belong to the browser
session, not to an agent run. Returning to a conversation reattaches its session.
Closing the sidebar only hides it. Explicitly closing a browser ends its live
session while keeping the profile for later use.

When the task needs browser work, invoke the selected browser capability yourself;
do not require a separate user prompt to open a browser or Nest's Browser tab.
An availability/view probe alone does not open a page. Use the browser's open or
navigate action with the relevant URL. Nest shows Browser automatically on the
first browser-tool use in each run. Later calls respect the user's manual tab
choice; resource refreshes and historical replay do not reopen the panel.

Pack metadata supplies label, renderer kind, default/min/max width, aspect ratio,
and whether the user can resize. Nest owns layout, rendering and interaction.
Every page defaults to fitting the visible tool area. Nest updates the actual
viewport on navigation, pane/window resize and focus-mode changes; agents should
use that current viewport rather than applying a fixed desktop size. Explicit
desktop/portrait sizes are for requested viewport checks. Refresh the snapshot
after any resize before using refs or coordinates. Allow the user to operate the displayed browser too;
refresh snapshots and verify the selected tab before acting.

The browser is live and interactive, including OAuth popups and new tabs. Soot
attaches it to the conversation's resource list on use. Users can inspect last
use/availability, check stale resources and explicitly close a browser. Never
infer that closing the sidebar should close a browser or log the user out.

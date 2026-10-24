---
version: 1
slug: "src-ui-index-html"
primary_target: "src/ui/index.html"
related_targets: []
---

## Scope

The claude-nonstop web UI (src/ui/index.html), served at http://claude-nonstop.localhost by `claude-nonstop ui`. Mode: Operate.

Audience and task: developers and their teammates set up subscription accounts and API keys once, then glance to see what's live and what traffic flows, re-route the relay by hand, add a top-up key, or fix a sign-in.

Constraints: one static file, inline CSS/JS, strict CSP (no external fonts, scripts or images), works offline, light and dark, keyboard and screen-reader usable, 390px to 1600px, honours reduced motion, reduced transparency and increased contrast.

## Direction contract

THESIS: A quiet settings pane in Apple's own manner. The relay reads like System Settings: one status card, inset grouped lists, plain sentences. The only physical thing on the page is a single white cable, and it is plugged into whichever line carries your work. It refuses decoration, glow, glass for its own sake and the dashboard card grid.

OWN-WORLD: Apple grouped-list materials. Light: #f2f2f7 ground, white groups, hairline inset separators. Dark: black ground, #1c1c1e groups. One accent, system blue (#0066cc text, #0071e3 fills; #2997ff text in dark), used only for controls and the live line. Semantic dots only: green ready, orange limited, red used up. The platform font (SF Pro through system-ui) with Apple's size-specific tracking; SF Mono only for keys, URLs and tokens. Translucency only on the toolbar, menus, sheets and toasts, where content passes beneath. Light cable like an Apple USB-C cable; dark mode a graphite one. The plug carries a MagSafe-style status light.

STORY: At a glance the visitor reads "Running on Work" and the line that takes over next, then any alerts. They drag the cable's plug onto another line's port (or use a row's menu), add accounts and keys from sheets, and read every switch in Activity.

FIRST VIEWPORT: A translucent toolbar: app icon and name, a segmented control (Relay / Desktop App / Settings), gateway status. A status card with the live line's symbol, "Running on <line>", what takes over next and whether the choice is automatic. Alerts as an inset group. Then the Accounts group and the API keys group; each row has a port on the group's left edge; the cable hangs in the left margin from the status card to the live row's port. On wide screens Activity sits in a right column; narrower, it follows the lists.

FORM: User-pinned direction ("very minimalistic, like how Apple designs its UI"), replacing the glass light-cable switchboard; topology (source, cable, ports, ordered relay) carries over. Signature interaction: grab the plug (it lifts on press), it tracks 1:1 from the grab point, ports within reach pull it in, and release hands the pointer's velocity to a spring, projecting a flick toward the port it was thrown at. Requests show as a soft glint along the cable and a blink of the plug's light. Reduced motion draws a still curve and keeps every function. Springs are critically damped by default and only bounce after a throw.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md

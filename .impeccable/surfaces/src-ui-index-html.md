---
version: 1
slug: "src-ui-index-html"
primary_target: "src/ui/index.html"
related_targets: []
---

## Scope

The claude-nonstop web UI (src/ui/index.html), served on 127.0.0.1 by `claude-nonstop ui`. Mode: Operate.

Audience and task: developers (the maintainer and teammates) set up subscription accounts and API keys once, then glance later to see what's live, add a top-up key, or fix a sign-in. First view after setup: what's in use now, plus any problem.

Constraints: one static file, inline CSS/JS, strict CSP (no external fonts, scripts or images), light and dark, keyboard and screen-reader usable, 390px to 1600px.

## Direction contract

THESIS: The relay is a switchboard line field. Accounts and keys are numbered lines in fixed order; the session's cord sits in the live jack and moves down the field when a line goes dead. It refuses the category default: a settings page of stacked cards and status pills.

OWN-WORLD: Painted-steel field panel (graphite in dark, pale enamel in light); ivory designation strips in brass-edged holders carry each line's name; flat round lamp caps (green live, amber limited or kept, red dead, unlit standby); lever keys for on/off; a rust cloth cord. One system sans, rank by weight, case and reversal at one tight scale; monospace only for readouts.

STORY: The visitor sees which line carries the session and whether any line needs attention, plugs in a new line (account sign-in or key), tests and reorders, and leaves sure the relay holds.

FIRST VIEWPORT: A reversed "connected" plate across the top names the live line with its lit lamp, the next line, and any trouble with its fix. Below, the jack field: the accounts bank, then the keys bank, each line one row (number, lamp, strip, readout, controls), each bank ending in a spare jack that is its add action. The cord runs in the left gutter from the plate's plug to the live jack.

FORM: Switchboard Line Field; position 6 of my ordered list; seed key 91b92915. Raises: one tight type scale ranked by weight, case and reversal (timetable); identical line scale on one baseline (folio); visible field grid as the order (Crouwel); honest lit/dark lamps, no glow (bitmap); live monospace readout beside every lamp (specimen). Signature interaction: when a check finds a line dead, its lamp turns red and the cord re-routes to the next live jack (220 ms ease-out; snaps under reduced motion).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

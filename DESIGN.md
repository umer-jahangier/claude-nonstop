---
name: claude-nonstop
description: A switchboard line field for a relay of Claude accounts and API keys.
colors:
  panel: "#e3e6e0"
  bank: "#d9ddd6"
  legend: "#d1d6ce"
  rule: "#bcc2ba"
  rule-strong: "#8f978f"
  ink: "#1b1f22"
  ink-2: "#4a524d"
  ink-3: "#545c57"
  field: "#f2f3ef"
  strip: "#f6f1e3"
  strip-ink: "#2b2620"
  brass: "#9a7542"
  plate: "#23282c"
  plate-2: "#2e3439"
  plate-ink: "#eef0ea"
  plate-ink-2: "#b4bbb5"
  cord: "#8f3a20"
  cord-hi: "#c06a48"
  action: "#8f3a20"
  action-hover: "#79301a"
  action-ink: "#ffffff"
  live: "#2e9a46"
  live-ring: "#1f6e31"
  warn: "#d48a14"
  warn-ring: "#9a630b"
  dead: "#c0392b"
  dead-ring: "#8a2419"
  unlit: "#8e968f"
  jack: "#2a2f33"
  jack-ring: "#737b75"
  focus: "#1f5fd1"
typography:
  headline:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "20px"
    fontWeight: 650
    lineHeight: 1.25
  title:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    letterSpacing: "-0.01em"
  title-small:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.25
  body:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  label:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 600
  bank-legend:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 700
    letterSpacing: "0.08em"
  designation:
    fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "13px"
    fontWeight: 650
    letterSpacing: "0.04em"
  readout:
    fontFamily: "ui-monospace, SF Mono, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    fontFeature: "tnum"
rounded:
  strip-label: "2px"
  board: "3px"
  plate: "4px"
  control: "6px"
  lamp: "50%"
spacing:
  line-y: "10px"
  bank-x: "16px"
  plate-x: "22px"
  gutter-narrow: "40px"
  gutter-wide: "56px"
  container: "1120px"
components:
  button-primary:
    backgroundColor: "{colors.action}"
    textColor: "{colors.action-ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "34px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
    textColor: "{colors.action-ink}"
  button-secondary:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0 14px"
    height: "34px"
  button-danger:
    backgroundColor: "{colors.dead-ring}"
    textColor: "{colors.action-ink}"
    rounded: "{rounded.control}"
    height: "34px"
  icon-button:
    textColor: "{colors.ink-2}"
    rounded: "{rounded.control}"
    size: "34px"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "7px 10px"
    height: "36px"
  connected-plate:
    backgroundColor: "{colors.plate}"
    textColor: "{colors.plate-ink}"
    rounded: "{rounded.plate}"
    padding: "18px 22px 18px 56px"
  board:
    backgroundColor: "{colors.bank}"
    textColor: "{colors.ink}"
    rounded: "{rounded.board}"
  bank-legend:
    backgroundColor: "{colors.legend}"
    textColor: "{colors.ink}"
    typography: "{typography.bank-legend}"
    padding: "12px 16px 10px"
  designation-strip:
    backgroundColor: "{colors.strip}"
    textColor: "{colors.strip-ink}"
    typography: "{typography.designation}"
    rounded: "{rounded.board}"
    padding: "4px 9px"
  line:
    textColor: "{colors.ink}"
    padding: "10px 12px 10px 14px"
    height: "56px"
  lamp:
    rounded: "{rounded.lamp}"
    size: "12px"
---

# Design System: claude-nonstop

## Overview

**Creative North Star: "The Switchboard Line Field"**

The relay is a telephone switchboard. Accounts and API keys are numbered lines in a fixed order on one painted-steel field panel: pale enamel by default, graphite under a dark color scheme. Each line carries an ivory designation strip in a brass holder, a flat round lamp, a monospace readout and, for accounts, a brass lever key. A rust cloth cord leaves the socket on the reversed "connected" plate at the top and runs down the left gutter into the live jack. When the live line changes, the cord re-routes.

This is an Operate surface. It is dense and quiet, and it reads at a glance. A healthy board is mostly neutral steel and ivory. Color shows up only where a lamp is lit, where the cord runs, and on the one primary action. Every line uses the same scale on one baseline, so the order of the lines is the main thing the eye reads. The field grid is the structure: banks are separated by rules on a single continuous board, never by stacked cards.

Everything is drawn from system resources. Only system font stacks are used, because the CSP forbids external fonts, and all icons are inline SVG line icons at 16px on a 1.5 stroke.

**Key Characteristics:**
- One continuous board, divided by rules into banks and lines, never broken into cards.
- One reversed plate on top names the live line, the next line, and any trouble.
- Binary lamps: lit solid with a darker ring, or unlit as an empty ring. No glow, no gradient.
- Ivory designation strips in brass holders carry each line's name in caps.
- The rust cord is the one moving signature. It re-routes to the live jack over 220 ms.
- Monospace only for identifiers, numbers and times.

## Colors

A restrained steel-and-ivory field. Rust and three lamp hues are the only saturated colors, and each one appears only because of a state or an action. Light values are listed in the frontmatter. The `prefers-color-scheme: dark` override swaps every token to a graphite counterpart (listed in the sidecar).

### Primary
- **Cloth-Cord Rust** (cord / action): the cord sheath, the brand plug glyph, the text caret, the selection tint, and the background of the one primary button per form ("Save timing", "Add and sign in"). The cord and the primary action share this hue on purpose: the action is what plugs a line in.
- **Cord Weave** (cord-hi): the dashed highlight stitched along the cord sheath. Never used elsewhere.

### Secondary
- **Holder Brass** (brass): strip holders, the cord tip, the plate socket ring, lever bats in the "on" position, and the ring of the live jack. Brass always marks hardware, never text.

### Tertiary (lamp states)
- **Live Green** (live, with live-ring): the line carrying sessions, and the gateway-up lamp in the masthead. The live row also gets a 9 to 10% green wash (live-tint).
- **Warn Amber** (warn, with warn-ring): limit reached, check failed, or key kept.
- **Dead Red** (dead, with dead-ring): not signed in, or used up. The darker dead ring fills the destructive confirm button and the error toast, so their white text holds contrast in both schemes.
- **Unlit Ring** (unlit): standby. An empty 2px ring with no fill, dashed when the line is switched off.

### Neutral
- **Enamel Panel / Graphite Panel** (panel): the page ground.
- **Bank Steel** (bank): the board surface under the lines.
- **Legend Band** (legend): the bank heading band, one step deeper than the bank.
- **Rule / Strong Rule** (rule, rule-strong): line dividers and bank dividers. A strong rule separates banks, and also outlines buttons and inputs.
- **Field White** (field): input and secondary-button fill.
- **Ink, Ink 2, Ink 3** (ink, ink-2, ink-3): primary text, secondary prose, and quiet metadata (line numbers, readout meta, version). Ink 3 is the lightest text allowed. It passes AA (4.5:1 or better) on the bank in both schemes for its 12.5px mono uses.
- **Ivory Strip / Strip Ink** (strip, strip-ink): the designation label face and its text.
- **Plate Graphite** (plate, plate-2, plate-ink, plate-ink-2): the reversed connected plate, the sign-in job panel, and toasts.
- **Jack Black / Jack Ring** (jack, jack-ring): jack sockets and lever slots.
- **Focus Blue** (focus): the 2px focus outline. It is the only blue, and it is reserved for keyboard focus.

### Named Rules
**The Lit-Or-Dark Rule.** A lamp is either lit (a solid fill inside a darker ring of the same hue) or unlit (an empty ring). There are no glows, no pulses, no gradients and no half states.

**The Quiet Board Rule.** Saturated color appears only for a lamp state, the cord, or the single primary action in a form. A healthy board is steel and ivory.

**The Shared Rust Rule.** The primary action uses the cord's rust and no other accent. A second accent hue is not part of this world.

## Typography

**Display Font:** none. The largest type is the 20px live-line name.
**Body Font:** system sans (ui-sans-serif, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial)
**Label/Mono Font:** system mono (ui-monospace, SF Mono, Menlo, Consolas, Liberation Mono), with tabular figures

**Character:** a timetable voice. There is one sans on one tight scale (20 / 17 / 16 / 14 / 13 / 12.5 px), and rank comes from weight, case and reversal, not from size jumps.

### Hierarchy
- **Headline** (650, 20px, 1.25): the live-line name on the plate. It is the only 20px text.
- **Title** (700, 17px, -0.01em): the wordmark.
- **Title Small** (600, 16px, 1.25): the "if it runs out" line on the plate.
- **Body** (400, 14px, 1.45): prose, trouble messages, inputs, toasts. Panel prose is capped at 68ch.
- **Label** (600, 13px): buttons, plate slot terms, form labels. Readout states use 700.
- **Bank Legend** (700, 13px, 0.08em, uppercase): bank and panel headings ("Subscription accounts", "API keys", "Timing").
- **Designation** (650, 13px, 0.04em, uppercase): the line name on its ivory strip.
- **Readout** (mono, 12.5px, tabular): line numbers, identifiers, usage numbers, times, the gateway URL, the version, file paths.

### Named Rules
**The One Scale Rule.** No size outside 20 / 17 / 16 / 14 / 13 / 12.5 px. To raise something's rank, change its weight, case or reversal (light on plate), not its size.

**The Readout Rule.** Monospace is used only for identifiers, numbers and times. Sentences, including the words of a state ("Used up", "Works"), stay in the sans.

## Layout

There is a single centered column (max 1120px). Wrap padding is 20px 16px 72px on narrow screens and 28px 32px 88px from 720px. The masthead (wordmark and facts) comes first, then the connected plate, then the field. The field reserves a left gutter for the cord (40px narrow, 56px from 720px), and each line's jack sits in that gutter.

The board holds the accounts bank, the keys bank, and a lower aux section (desktop-app setup and timing) as one panel. Each bank ends with a spare jack whose dashed strip is the add action.

Each line is a grid: number (26px), lamp (12px), strip, readout, controls, lever (a fixed 28px column on every line, so strips and controls align across both banks). Below 640px the readout and controls drop to their own rows under the strip. From 640px the controls join the first row. From 900px everything sits on one row, with the strip at 160 to 236px. Line padding is 10px vertical, and the minimum row height is 56px. The aux section splits into two columns (1.25fr / 1fr) from 900px. Breakpoints in use: 560, 640, 720, 900px.

## Elevation & Depth

The board is flat: depth comes from tonal steps (panel, bank, legend) and from rules. Only things that sit on top of the field get a soft lift: the connected plate and the toast share one two-layer ambient shadow. Hardware is drawn with inset rings rather than cast shadows. The socket uses stacked brass, plate and black insets, jacks use a 2px inset ring, and strips use a hairline inner highlight and an inner bottom shade. The lever bat is the one small physical object, with a 1px drop.

### Shadow Vocabulary
- **Plate lift** (`box-shadow: 0 1px 2px rgba(20,24,26,0.12), 0 4px 14px rgba(20,24,26,0.06)`; dark: `0 1px 2px rgba(0,0,0,0.5), 0 6px 18px rgba(0,0,0,0.25)`): the connected plate and the toast only.
- **Jack ring** (`box-shadow: inset 0 0 0 2px <jack-ring | brass | rule-strong>`): idle, live, and spare jacks.
- **Strip face** (`box-shadow: inset 0 1px 0 rgba(255,255,255,0.6), inset 0 -1px 0 rgba(60,45,20,0.12)`): ivory designation labels.

### Named Rules
**The Flat Field Rule.** The board, banks and lines never cast shadows. Only the plate and transient overlays lift off the field.

## Shapes

The geometry is tight and machined. The board has 3px corners, as does the brass strip holder (the ivory label inside it uses 2px). The connected plate and the job panel use 4px. Interactive controls (buttons, icon buttons, inputs, toasts) use 6px, which is slightly softer so that controls read as touchable and separate from the hardware. Lamps, jacks, the socket and the cord tip are true circles. The cord is a 5px round-capped stroke with a 2/4 dashed weave on top. Dashed outlines always mean something is not live yet: the spare-jack strip, and the ring of a lamp that is switched off.

## Components

### Buttons
Compact and quiet. They are labeled with verbs and sit at the right edge of their line.
- **Shape:** gently squared (6px), 34px tall (30px in a bank legend), 14px side padding, with an optional 16px SVG icon at a 7px gap.
- **Primary:** rust fill with white label. Use one per form.
- **Secondary:** field-white fill with a strong-rule border. On hover the border darkens to ink-3.
- **On plate:** transparent with a 28% white border. On hover the border goes to 60%.
- **Danger:** dead-ring red fill and border with white label, used only inside a remove confirmation.
- **Icon button:** 34px square, transparent until hover (field fill plus rule border). The danger variant turns red on hover.
- **Hover / Focus:** 150ms ease-out color transitions. Keyboard focus is a 2px focus-blue outline offset 2px. Busy controls drop to 50% opacity with a progress cursor.

### Inputs / Fields
- **Style:** field-white fill, strong-rule border, 6px corners, min height 36px, 14px text (13px mono for numbers and keys). Placeholders use ink-3.
- **On plate:** plate-2 fill, plate-ink text, 28% white border.
- **Focus:** the shared 2px focus-blue outline.

### Connected Plate (signature)
A reversed graphite plate that answers "what runs now". A brass-ringed socket sits at top left, where the cord plugs in. A definition grid pairs the Live line (lamp and 20px name) with "If it runs out" (16px). Below a 12% white rule comes a trouble list: each problem gets a red lamp, a sentence, and on-plate fix buttons. With no trouble, it shows one quiet all-ready line.

### Line (signature)
One row per account or key: jack in the gutter, mono number, lamp, designation strip, readout (bold state word, then mono identifier and meta), icon controls, lever. The live line gets the green wash and a brass jack ring. A line that is switched off fades its strip to 55%.

### Designation Strip
An ivory label (strip-ink, 650, caps, 0.04em) in a 2px brass holder. It is also the rename affordance: it turns into an inline input with the same type. On the spare jack it becomes a dashed empty holder containing a plus icon and "Add an account" or "Add an API key".

### Lever Key
A 24 by 36px switch. A brass bat in a dark slot is thrown up for on and down for off, where it turns unlit grey. It moves over 180ms on cubic-bezier(0.2, 0.8, 0.2, 1). It exposes a switch role through aria-checked.

### Cord (signature interaction)
An SVG over the wrap. It drops from the plate socket, runs down a lane just left of the jack column, and turns into the live jack, ending in a brass tip. Only a change of live line animates. The end point travels over 220ms with an exponential ease-out (1 − 2^(−10t)). Layout shifts, hidden tabs and `prefers-reduced-motion` all snap it into place. With no live line, it hangs loose from the socket.

### Toast
A plate-graphite pill at bottom center with 6px corners and the plate-lift shadow. It enters over 180ms opacity and 220ms cubic-bezier(0.16, 1, 0.3, 1) translate. The error variant uses the dead-ring red and the alert role.

## Do's and Don'ts

### Do:
- **Do** show every account and key as a numbered line on the one board, in relay order, with the same row scale.
- **Do** give every line a lamp and a readout beside it. Use a lit lamp only for live, warn or dead states.
- **Do** keep type to 20 / 17 / 16 / 14 / 13 / 12.5 px and rank by weight, caps and reversal.
- **Do** use the rust action color for the single primary action in a form, and nowhere else except the cord.
- **Do** end each bank with a spare jack as its add action.
- **Do** keep the 3px board, 4px plate, 6px control radius split.
- **Do** honor reduced motion: every transition goes to 0ms, and the cord snaps.

### Don't:
- **Don't** break the board into stacked cards or status pills; banks are divided by rules.
- **Don't** add glow, pulse, gradient or partial fills to lamps.
- **Don't** set sentences or state words in monospace.
- **Don't** load external fonts, scripts, images or icon fonts; system stacks and inline SVG only.
- **Don't** cast shadows from the board, banks or lines; only the plate and toasts lift.
- **Don't** animate the cord on layout changes; it moves only when the live line changes.

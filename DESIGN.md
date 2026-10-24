---
name: claude-nonstop
description: A quiet Apple-style settings pane for a relay of Claude accounts and API keys, with one white cable plugged into the live line.
colors:
  accent: "#0066cc"
  accent-fill: "#0071e3"
  accent-hover: "#0077ed"
  accent-tint: "rgba(0, 113, 227, 0.1)"
  focus: "rgba(0, 113, 227, 0.45)"
  select: "rgba(0, 113, 227, 0.2)"
  accent-dark: "#2997ff"
  accent-tint-dark: "rgba(41, 151, 255, 0.16)"
  focus-dark: "rgba(41, 151, 255, 0.55)"
  green: "#34c759"
  orange: "#ff9500"
  red: "#ff3b30"
  red-text: "#d70015"
  gray: "#aeaeb2"
  green-dark: "#30d158"
  orange-dark: "#ff9f0a"
  red-dark: "#ff453a"
  red-text-dark: "#ff6961"
  gray-dark: "#636366"
  ground: "#f2f2f7"
  group: "#ffffff"
  label: "#1d1d1f"
  label-2: "#6e6e73"
  sep: "rgba(60, 60, 67, 0.17)"
  fill: "rgba(120, 120, 128, 0.12)"
  fill-2: "rgba(120, 120, 128, 0.2)"
  track: "rgba(120, 120, 128, 0.16)"
  key-tile: "#8e8e93"
  bar: "rgba(242, 242, 247, 0.78)"
  material: "rgba(251, 251, 253, 0.84)"
  scrim: "rgba(0, 0, 0, 0.2)"
  ground-dark: "#000000"
  group-dark: "#1c1c1e"
  sheet-group-dark: "#2c2c2e"
  label-dark: "#f5f5f7"
  label-2-dark: "#98989d"
  sep-dark: "rgba(84, 84, 88, 0.55)"
  thumb-dark: "#636366"
  bar-dark: "rgba(22, 22, 24, 0.76)"
  material-dark: "rgba(44, 44, 46, 0.86)"
  cable: "#ffffff"
  cable-dark: "#3a3a3c"
  plug-bottom: "#e3e3e8"
  port: "#dcdce1"
  port-dark: "#0c0c0d"
typography:
  large-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.14
    letterSpacing: "-0.024em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.022em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: "-0.015em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.47
    letterSpacing: "-0.01em"
  callout:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
    letterSpacing: "-0.01em"
  footnote:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.38
    letterSpacing: "-0.003em"
  control:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 500
    lineHeight: 1.33
    letterSpacing: "-0.005em"
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.33
    letterSpacing: "0"
  mono:
    fontFamily: "ui-monospace, SF Mono, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "0"
rounded:
  xs: "5px"
  sm: "7px"
  md: "8px"
  seg: "9px"
  fields: "10px"
  group: "12px"
  sheet: "14px"
  toast: "20px"
  pill: "999px"
spacing:
  hair: "1px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "20px"
  section: "32px"
components:
  button:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.accent}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "30px"
  button-hover:
    backgroundColor: "{colors.fill-2}"
  button-primary:
    backgroundColor: "{colors.accent-fill}"
    textColor: "{colors.group}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    padding: "0 12px"
    height: "30px"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
  button-danger:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.red-text}"
    rounded: "{rounded.md}"
    height: "30px"
  button-large:
    padding: "0 16px"
    height: "34px"
  icon-button:
    textColor: "{colors.label-2}"
    rounded: "{rounded.pill}"
    size: "30px"
  segmented-control:
    backgroundColor: "{colors.track}"
    rounded: "{rounded.seg}"
    padding: "2px"
  segmented-item:
    textColor: "{colors.label}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "0 14px"
    height: "28px"
  segmented-thumb:
    backgroundColor: "{colors.group}"
    rounded: "{rounded.sm}"
  group:
    backgroundColor: "{colors.group}"
    rounded: "{rounded.group}"
  row:
    textColor: "{colors.label}"
    typography: "{typography.body}"
    padding: "10px 12px 10px 16px"
    height: "52px"
  symbol-tile:
    backgroundColor: "{colors.accent-fill}"
    textColor: "{colors.group}"
    rounded: "{rounded.sm}"
    size: "30px"
  symbol-tile-key:
    backgroundColor: "{colors.key-tile}"
  live-pill:
    backgroundColor: "{colors.accent-tint}"
    textColor: "{colors.accent}"
    typography: "{typography.caption}"
    rounded: "{rounded.pill}"
    padding: "3px 9px"
  switch:
    backgroundColor: "{colors.track}"
    rounded: "13px"
    width: "42px"
    height: "26px"
  switch-on:
    backgroundColor: "{colors.green}"
  number-field:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.label}"
    rounded: "{rounded.sm}"
    padding: "0 8px"
    width: "64px"
    height: "30px"
  menu:
    backgroundColor: "{colors.material}"
    rounded: "{rounded.group}"
    padding: "5px"
    width: "228px"
  menu-item:
    textColor: "{colors.label}"
    typography: "{typography.callout}"
    rounded: "{rounded.sm}"
    padding: "0 10px"
    height: "32px"
  menu-item-hover:
    backgroundColor: "{colors.accent-fill}"
    textColor: "{colors.group}"
  sheet:
    backgroundColor: "{colors.ground}"
    rounded: "{rounded.sheet}"
    padding: "22px 20px 20px"
    width: "460px"
  sheet-fields:
    backgroundColor: "{colors.group}"
    rounded: "{rounded.fields}"
    padding: "0 8px 0 14px"
    height: "44px"
  toast:
    backgroundColor: "{colors.material}"
    textColor: "{colors.label}"
    typography: "{typography.callout}"
    rounded: "{rounded.toast}"
    padding: "10px 16px"
  toolbar:
    backgroundColor: "{colors.bar}"
    height: "52px"
    padding: "0 20px"
---

# Design System: claude-nonstop

## Overview

**Creative North Star: "The Quiet Settings Pane"**

The UI reads like a pane of Apple's System Settings: a pale ground, white inset groups with hairline separators, plain sentences, the platform font, and a single system-blue accent reserved for controls and the live line. Density is comfortable and list-driven; nothing is a card grid, and nothing glows for its own sake. Light and dark are both first-class, declared as one token set on `:root` and swapped by `data-theme` on the root element. Dark is the default; Settings and the toolbar offer Light and Automatic (which follows `prefers-color-scheme`), and a script in `<head>` applies the choice before the first paint.

Exactly one physical object lives on the page: a cable (white like an Apple USB-C cable in light mode, graphite in dark) that runs from a boot on the status card's left edge to a port on the live row. Its plug carries a MagSafe-style status light. The status card's right side holds a WebGL dotted globe where each gateway request flies as a light from this computer to Anthropic. These two are the only illustrative elements; everything else is platform chrome.

Motion is one physics. A critically damped spring is sampled into a CSS `linear()` easing at load and shared by CSS transitions and WAAPI animations; only a thrown plug is allowed to bounce. Exits are short and accelerate away.

**Key Characteristics:**
- Grouped inset lists on a tinted ground; hairline separators inset to the text column.
- One accent (system blue), semantic dots only (green, orange, red, gray).
- Platform font with size-specific negative tracking; mono only for keys, URLs, tokens.
- Translucency only where content passes beneath: toolbar, menu, toast.
- A single cable-and-plug object and a dotted globe as the only illustration.
- Spring motion, critically damped by default; reduced motion keeps every function.

## Colors

A neutral Apple grouped-list palette with one blue voice and three semantic status hues; every value has a dark counterpart.

### Primary
- **System Blue** (`accent`; dark `accent-dark`): link and control text: button labels, text buttons, add rows, the live pill's word.
- **System Blue Fill** (`accent-fill`, hover `accent-hover`): filled surfaces only: primary button, highlighted menu item, account symbol tiles and avatar, the cable's request glint, the active port ring, the caret. Not overridden in dark.
- **Blue Tint** (`accent-tint`; dark `accent-tint-dark`): the live pill background, port hover halo, a freshly arrived activity row.
- **Focus Blue** (`focus`; dark `focus-dark`) and **Selection Blue** (`select`): the 3px focus outline and text selection.

### Semantic
- **Ready Green** (`green` / `green-dark`): ready dots, switch on, plug light OK, success result icon.
- **Limited Orange** (`orange` / `orange-dark`): warning dots, plug light warn, gateway down, warning alert icon.
- **Used-up Red** (`red` / `red-dark`): exhausted dots, error alert and toast icons, destructive menu item highlight.
- **Destructive Text Red** (`red-text` / `red-text-dark`): destructive button and menu text, sheet errors. Darker than `red` so it holds text contrast.
- **Idle Gray** (`gray` / `gray-dark`): unknown state dots, off-state ring, idle plug light.

### Neutral
- **Grouped Ground** (`ground` / `ground-dark` pure black): page background and sheet panel.
- **Group White** (`group` / `group-dark`; sheet field groups use `sheet-group-dark` in dark): inset groups.
- **Label** (`label` / `label-dark`) and **Secondary Label** (`label-2` / `label-2-dark`): primary and secondary text.
- **Separator** (`sep` / `sep-dark`): hairlines between rows, menu separators.
- **Fills** (`fill`, `fill-2`, `track`): tonal backgrounds for buttons, inputs, code, the segmented track and switch track; `fill-2` is the hover/pressed step.
- **Key Tile Gray** (`key-tile`): API-key symbol tiles and avatar, distinguishing keys from blue accounts.
- **Bar and Material** (`bar`, `material` and dark pair): translucent toolbar and menu/toast backgrounds. **Scrim** (`scrim`) dims behind sheets.
- **Cable materials** (`cable`, `plug-bottom`, `port` and dark pair): white cable body and plug gradient, recessed port slots; dark mode is graphite on near-black ports.

The globe takes its own RGB triplet tokens (`--globe-body`, `--globe-rim`, `--globe-dot`, `--globe-dot-back`, `--globe-arc`, `--globe-aura`, `--globe-aura-a`), recorded in the sidecar; its arc and aura are the system blue.

**The One Voice Rule.** Blue appears only on controls, the live line and request traffic. Status is never blue; it is a green, orange, red or gray dot.

**The Dot, Not Paint Rule.** Semantic hues appear as small dots (7-8px), icons, the plug light or the switch, never as row or card backgrounds.

## Typography

**Font:** the platform face (`-apple-system, BlinkMacSystemFont, system-ui`, falling back to Segoe UI, Roboto, Helvetica Neue, Arial).
**Mono:** `ui-monospace` / SF Mono, for API keys, URLs, tokens and log detail only.

**Character:** Apple's own text style ladder, with tracking tightened as size grows. In this world the system face is the material, not a fallback.

### Hierarchy
- **Large Title** (700, 28px, 1.14, -0.024em; 22px at 640px and below): the status card's "Running on ..." and the Desktop App and Settings view titles. Its dimmed part drops to 600 in secondary label.
- **Headline** (600, 17px, 1.3, -0.022em): sheet titles.
- **Title** (600, 15px, -0.015em): group headings. Row titles use the same size at 500.
- **Body** (400, 15px, 1.47, -0.01em): page default, add rows, step text; the view lede is capped at 60ch.
- **Callout** (14px, 1.43): alert text, sheet ledes, menu items, toasts (toasts at 500).
- **Footnote** (13px, 1.33-1.38, -0.003em): row subtitles, group footers (capped at 64ch), hints, activity text, the toolbar status.
- **Control** (500, 13px, -0.005em): buttons and segmented items. Large buttons step up to 14px.
- **Caption** (600, 12px, 0 tracking): live pill, step numbers, timestamps (400). The globe labels use 11px at 600.
- **Mono** (12px; 13px in sheet inputs; inline code at 0.8125em): secrets and addresses.

**The Tracking Ladder Rule.** Every size carries its own letter-spacing (from -0.024em at 28px to 0 at 12px and below). Don't reuse one tracking value across sizes.

**The Numbers Line Up Rule.** Counts, times, durations and step numbers use tabular figures.

## Layout

- **Container:** content max 1080px, centred. Main padding is `12px 20px 72px 44px`; the extra left gutter holds the cable and the ports that straddle each group's left edge.
- **Relay view:** two columns (main up to 640px, side 320px, 40px gap). The Activity column is sticky under the toolbar with its own scroll. Below 1100px it collapses to one 660px column with Activity after the lists.
- **Other views:** single 660px column with a large title and lede.
- **Status card:** a grid of heading and key/value rows on the left and a 280px globe on the right, the globe faded in from its left edge by a 40px mask. At 640px and below the globe shrinks to 124px beside the heading, the avatar and globe labels hide, and the rows span the full width.
- **Rhythm:** 32px above each group heading, 8px between heading and group, 8px to the footer, 16px between stacked groups. Rows are 52px minimum (46-50px in compact lists, 44px in sheet fields).
- **Separators** start at the text column (`--sep-left`: 58px for rows with a symbol, 50px for alerts and steps, 37px in Activity, 16px in plain lists), never full-bleed.
- **Breakpoints:** 1099px (one column), 760px (tighter gutters), 640px (toolbar wraps to two rows with a full-width segmented control, sheets become bottom sheets, state words go screen-reader only).

## Elevation & Depth

Depth comes from tone first: tinted ground, white groups, no shadow on groups at rest. Shadows exist only on things that float above content or that are physical objects.

### Shadow Vocabulary
- **Menu / toast** (`--shadow-menu`): a 0.5px ring plus a soft 12px/32px drop; stronger in dark.
- **Sheet** (`--shadow-sheet`): a 0.5px ring plus a long 30px/80px drop.
- **Thumb** (`--shadow-thumb`): segmented-control thumb; the switch knob uses its own small 2px/4px drop.
- **Plug**: a 0.5px edge plus a 1px and a 4px/10px drop; lifted, it becomes 8px/18px and scales 1.16.
- **Port slot**: an inset 1px/2px shadow with a 1px ring, so it reads as a recess.

Translucency is `saturate(180%) blur(20-24px)` on the toolbar, menu and toast, and 8px blur on the globe labels. The toolbar gains a hairline bottom edge only once the page has scrolled.

**The Floats Only Rule.** Groups never cast shadows. Only menus, toasts, sheets, the segmented thumb, the switch knob and the plug do.

**The Glass Where It Passes Rule.** Blur only surfaces that content scrolls or sits beneath; never blur a static group for effect.

## Shapes

Continuous, modest rounding that scales with the container: 5px (inline code, rename input), 7px (segmented items and thumb, symbol tiles, menu items, number fields), 8px (buttons, port hit areas), 9px (segmented track), 10px (sheet field groups), 12px (groups, menus), 14px (sheets; top corners only as a bottom sheet), 20px (toasts), and full pills or circles for the live pill, dots, avatar, icon buttons and the switch. Only the first and last row of a list take the group's corner radius. The app icon is a squircle tile. Icons are inline SVG line glyphs, 1.6 stroke, round caps.

## Components

### Toolbar
Sticky, translucent bar 52px tall over a three-part grid: app icon and name (600, 15px), the segmented control centred, gateway status (dot and 13px secondary label) at the end. At 640px and below it wraps: brand and status on top, segmented control full width beneath.

### Segmented Control
A 2px-padded track with a white (dark: gray) thumb that slides under the selected item on the shared spring. Unselected items dim to 0.72 on hover and 0.55 on press. Implemented as a tablist with roving tabindex.

### Groups and Rows
White inset groups, no border. A row is a symbol tile (30px, blue for accounts, gray for keys), a title and subtitle, a trailing state and actions. States: a dot plus a word; the live line instead gets a blue tint pill. Turned-off rows dim the title and tile to 0.45. Add rows are full-width blue text with a plus icon; hover and press step through `fill` and `fill-2`. Group footers explain behaviour in a plain sentence.

### Buttons
- **Shape:** 8px radius, 30px tall (34px large).
- **Default:** tonal gray fill with blue text; hover steps to `fill-2`.
- **Primary:** blue fill, white text; hover lightens slightly.
- **Destructive:** default fill with red text.
- **Press:** scales to 0.97 (icon buttons 0.92). Disabled drops to 0.45 opacity.
- **Text and icon buttons:** borderless blue text; circular 30px gray icon buttons that fill on hover or while their menu is open.

### Switch
42 by 26px track, gray off, green on; a white 22px knob slides on the spring and widens to 26px while pressed.

### Inputs
Number fields are 64px tonal wells with right-aligned tabular numbers. Sheet fields sit in a grouped field block (44px rows, 72px labels, inset hairlines); focus draws a 2px inset blue ring on the whole field row rather than an outline. Secret and URL inputs use mono.

### Menu
Translucent 228px popover, 12px radius, 5px inset. Items are 32px with a leading gray icon; hover and keyboard focus fill the item blue with white text (red fill for destructive). Opens from the button that triggered it with scale 0.94 to 1 on the spring; closes with a 120ms fade.

### Sheet
A modal dialog over a scrim. Centred 460px panel (340px narrow, centred text, full-width actions) entering from 14px above with scale 0.97 and a 5px blur; at 640px and below it is a bottom sheet sliding up from the edge with safe-area padding. It leaves the way it came on the exit easing. Actions sit bottom right; errors are footnote red text.

### Toast
Translucent 20px pill, top centre below the toolbar, callout 500. It drops in from 12px above at 0.96 scale and leaves the same way on the exit easing; errors carry a red icon and stay longer.

### Cable, Plug and Ports (signature)
The cable is four stacked SVG strokes (shade 6, edge 4.6, body 3.3, highlight 1) from the status card's boot to the live row's port. Ports are recessed 6 by 20px slots on each group's left edge; hover adds a blue tint halo, and a port in magnetic reach stretches and takes a blue ring. The plug (22px, 19px on narrow screens) has a top-to-bottom gradient body and a 4px status light: green ready, orange limited, gray idle, and a white blink for each request while a blue glint travels the cable. Grabbed, it lifts; it tracks the pointer 1:1, ports pull it in, and release hands the pointer's velocity to a 2D spring (damping 0.8 after a throw, otherwise 1). Keyboard: arrow keys and Return. Reduced motion draws a still curve.

### Globe (signature)
A dotted Earth in plain WebGL inside the status card: land dots on a soft body with a blue rim and aura, back-face dots dimmed. "This computer" (guessed from the timezone) and "Anthropic" carry small translucent labels. Each gateway request sends a blue light along an arc and back. Drag tracks 1:1, coasts, then springs home; hover tilts it slightly. Its colours come from tokens and swap with the colour scheme; if WebGL is lost the art hides.

### Motion and Accessibility
- **Spring:** `springCurve(0.42, 1)`, a critically damped step response sampled into 41 `linear()` stops, written to `--spring` and `--spring-ms` at load. The fallback is `cubic-bezier(0.2, 0.8, 0.2, 1)` at 420ms.
- **Exit:** `cubic-bezier(0.4, 0, 1, 1)` at 200ms for toasts and sheets; scrims fade in over 240ms and out over 200ms.
- **Micro:** 0.12s ease for press and hover feedback; activity rows arrive on `cubic-bezier(0.16, 1, 0.3, 1)` over 0.6s.
- **Reduced motion:** spring transitions collapse to 0.01ms; WAAPI keeps only its opacity frames, capped at 160ms; the cable draws still; no globe comets, logo or favicon glints; the spinner slows to 2.4s.
- **Reduced transparency:** toolbar, menu and toast become solid ground or group colour with no blur.
- **Increased contrast:** separators and secondary labels darken (lighten in dark), and groups gain a 1px ring.
- **Focus:** 3px blue outline at 2px offset on `:focus-visible`; plugs and fields draw a ring instead.
- **Hairlines:** 1px, 0.5px on 2x displays.

## Do's and Don'ts

### Do:
- **Do** build every new screen from inset groups on the grouped ground, with hairlines inset to the text column.
- **Do** keep blue for controls, the live line and request traffic; show status with a green, orange, red or gray dot plus a word.
- **Do** move things on the shared `--spring` / `--spring-ms` and leave on the exit easing; keep springs critically damped unless the user threw something.
- **Do** define every new colour as a `:root` token with a dark value, and check it under reduced transparency and increased contrast.
- **Do** use the platform font with its per-size tracking, and mono only for secrets, URLs and tokens.

### Don't:
- **Don't** add a second physical object or illustration beyond the cable, plug and globe.
- **Don't** use a dashboard card grid, glow or decorative glass; blur only the toolbar, menus, toasts and labels that float over content.
- **Don't** put shadows on groups at rest.
- **Don't** paint rows or groups in semantic colours.
- **Don't** let meaning depend on motion; every function must still work with reduced motion.

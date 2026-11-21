---
name: PFT
description: Prop-trading platform — challenges, funded accounts, payouts, in a dark instrument-panel world
colors:
  deep-space-navy: "#070b16"
  instrument-ink: "#0b1122"
  console-slate: "#111a2d"
  cosmo-indigo: "#172239"
  deep-grid: "#223052"
  starlight: "#e7edff"
  gauge-white: "#f4f7ff"
  moon-mist: "#8fa3c4"
  signal-blue: "#4388ff"
  aurora-cyan: "#55d6e8"
  nebula-violet: "#9466ff"
  alert-rose: "#f43f5e"
  caution-amber: "#f59e0b"
  void-black: "#02040a"
typography:
  display:
    fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif"
    fontWeight: 600
    letterSpacing: "-0.02em"
  body:
    fontFamily: "var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
  label:
    fontFamily: "var(--font-geist-mono), ui-monospace, monospace"
    fontSize: "0.75rem"
    fontWeight: 500
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  base: "0.625rem"
  lg: "0.625rem"
  xl: "0.875rem"
  2xl: "1.25rem"
components:
  button-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "{colors.void-black}"
    rounded: "{rounded.lg}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.starlight}"
    rounded: "{rounded.lg}"
  card:
    backgroundColor: "{colors.console-slate}"
    textColor: "{colors.gauge-white}"
    rounded: "{rounded.xl}"
  input:
    backgroundColor: "transparent"
    textColor: "{colors.starlight}"
    rounded: "{rounded.lg}"
---

# Design System: PFT

## Overview

**Creative North Star: "Night Planetarium"**

The product is a dome at night: the universe (stars, nebulae, comet trails) is decoration that lives far away on established background layers, while everything the visitor reads is a calm, precise instrument. Star fields and the nebula wash appear only on dedicated atmosphere utilities; data surfaces stay quiet and honest.

Density is functional: trading dashboards reward numbers that sit still. Interfaces are dark-only (single `color-scheme: dark`); there is no light theme to make work. Depth comes from surface tone, almost never from shadow.

**Key Characteristics:**
- Dark-only palette of navy decks with a single blue accent and cool cyan highlight
- Tonal elevation: `#070b16` page → `#0b1122` shell → `#111a2d` card; borders carry separation
- Geist sans for reading, Geist Mono for anything that measures a value
- Motion is rare, short (200–320ms), and always reduced-motion-capped

## Colors

Cosmic dark palette: deep navy decks, electric blue instrument lighting, one violet atmosphere tone, corrective rose/amber for states.

### Primary
- **Signal Blue** (#4388ff): the one live accent — primary buttons, links, active states, focus rings, chart-1.
- **Aurora Cyan** (#55d6e8): highlight lighting on gradients and chart-2; cools the primary when used together.

### Tertiary
- **Nebula Violet** (#9466ff): atmosphere only — the nebula-atmosphere wash on branding surfaces; never a control color.

### Neutral
- **Deep Space Navy** (#070b16): page background.
- **Instrument Ink** (#0b1122): shells — sidebar, surfaces.
- **Console Slate** (#111a2d): cards, popovers.
- **Cosmo Indigo** (#172239): secondary/muted/accent fills.
- **Deep Grid** (#223052): borders and input strokes.
- **Starlight** (#e7edff): body text; **Moon Mist** (#8fa3c4): muted text.
- **Gauge White** (#f4f7ff): high-emphasis text on cards.
- **Void Black** (#02040a): text on Signal Blue / Aurora Cyan fills.

### Named Rules
**The One Light Rule.** Signal Blue is the only accent that acts. Aurora Cyan lights, Nebula Violet decorates — neither may invite a click.

**The Star Budget Rule.** Star fields, nebulae, and grid backgrounds belong to atmosphere utilities (`.cosmic-stars`, `.nebula-atmosphere`, `.bg-grid`); raw fills per screen stay inside those utilities.

## Typography

**Display Font:** Geist (via `next/font/google`, fallback ui-sans-serif)
**Body Font:** Geist
**Label/Mono Font:** Geist Mono

**Character:** engineered neutrality — a single modern grotesque with a true mono companion for numeric instrument value.

### Hierarchy
- **Display** (600, tightened tracking): hero statements on landing surfaces.
- **Headline/Title** (600): section and card titles.
- **Body** (400, 0.875rem default): dashboard text sits at 14px; marketing pages scale up.
- **Label/Mono** (500, 0.75rem): monospace for prices, timestamps, limits, IDs.

### Named Rules
**The Mono Measures Rule.** Anything measured — balances, drawdowns, payout amounts, dates in tables — renders in Geist Mono, never in the sans.

## Layout

Tailwind utility layout with content maxing out around `max-w-[1600px]` in admin frames; public pages use narrower centered containers. Default spacing rhythm follows Tailwind's 4px scale with card padding at `p-4`–`p-6` (`lg` adds breathing room). Breakpoints are the Tailwind defaults; `sm:/md:/lg:` prefixes govern the responsive passes and admin tables scroll in `overflow-x-auto` wrappers rather than reflowing.

## Elevation & Depth

Tonal layering by default: separation reads as background tone steps plus `--border: #223052` strokes. Shadow is a response, not a base state.

### Shadow Vocabulary
- **Accent glow** (`0 0 40px -20px var(--primary)` class of values): hero/admin-login surfaces only.
- **Gradient light lines** (linear-gradient washes in `globals.css`): decorative edges on signature surfaces, used by atmosphere utilities.

### Named Rules
**The Tone-Not-Shadow Rule.** At rest, surfaces separate by tone and border. Shadows appear on interaction or on the few signature hero surfaces.

## Shapes

Rounded but not pill-soft: `--radius: 0.625rem` (10px) is the instrument radius, derived scale `--radius-sm` (6px) → `--radius-4xl` (26px) steps by multipliers for larger containers. Buttons and inputs use the base/lg radius; cards run xl. Hairline borders (#223052) are part of the silhouette — surfaces are delineated, not floating.

## Components

### Buttons
- **Shape:** rounded-lg (10px), sans 14px medium.
- **Primary:** Signal Blue background, Void Black text; lighter on parent hover (`primary/80`).
- **Hover / Focus:** focus-visible ring in ring/50 at 3px width; active presses translate 1px down.
- **Outline / Ghost:** transparent fills, Starlight text, hover fills step up via muted tones.

### Cards / Containers
- **Corner Style:** xl (14px).
- **Background:** Console Slate; inner sections step to Cosmo Indigo.
- **Border:** 1px Deep Grid.
- **Signature variant:** `.cosmic-card` — gradient edge light inside a bordered panel.

### Inputs / Fields
- **Style:** transparent background, 1px Deep Grid stroke, rounded-lg.
- **Focus:** ring glow in Signal Blue; invalid state additionally uses a row of destructive stroke.

### Navigation
- Sidebar in Instrument Ink with active items lit by Signal Blue; mobile collapses to sheets. Public header steps quieter on scroll.

## Do's and Don'ts

### Do:
- **Do** resolve every surface color through tokens (`bg-background`, `bg-card`, `border-border`); new shades go into `:root` first.
- **Do** render numeric values in Geist Mono with tabular alignment.
- **Do** wrap any wide table (`min-w-[...]`) in `overflow-x-auto`.

### Don't:
- **Don't** hardcode hex against the token set (known offenders are being migrated to tokens; do not add new ones).
- **Don't** introduce a light theme or per-component color-scheme exceptions.
- **Don't** animate layout properties or leave motion without a `prefers-reduced-motion` off-switch.

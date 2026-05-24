---
name: MicroRealEstate
description: A landlord's ledger, made digital and made Greek. Architectural calm, editorial typography, sea-blue accent earned not given.
colors:
  ink: "oklch(20% 0.012 240)"
  ink-soft: "oklch(34% 0.010 240)"
  ink-muted: "oklch(50% 0.008 240)"
  bone: "oklch(98% 0.004 85)"
  cream: "oklch(96% 0.006 85)"
  stone: "oklch(92% 0.006 85)"
  stone-line: "oklch(88% 0.008 85)"
  marble: "oklch(82% 0.010 85)"
  sea: "oklch(48% 0.092 240)"
  sea-deep: "oklch(38% 0.098 240)"
  sea-tint: "oklch(94% 0.024 240)"
  oxide: "oklch(55% 0.144 35)"
  oxide-tint: "oklch(94% 0.030 35)"
  olive: "oklch(48% 0.080 130)"
  olive-tint: "oklch(94% 0.024 130)"
typography:
  display:
    fontFamily: "Source Serif 4, Source Serif Pro, Newsreader, Georgia, 'Times New Roman', serif"
    fontSize: "1.75rem"
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: "-0.01em"
    fontFeature: "'kern' 1, 'liga' 1, 'calt' 1"
  headline:
    fontFamily: "Source Serif 4, Source Serif Pro, Newsreader, Georgia, serif"
    fontSize: "1.375rem"
    fontWeight: 500
    lineHeight: 1.25
    letterSpacing: "-0.005em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "1rem"
    fontWeight: 600
    lineHeight: 1.35
    letterSpacing: "0"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "0"
    fontFeature: "'kern' 1, 'liga' 1, 'calt' 1, 'ss01' 1"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0.04em"
  numeric:
    fontFamily: "JetBrains Mono, IBM Plex Mono, SF Mono, ui-monospace, Menlo, monospace"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "-0.01em"
    fontFeature: "'tnum' 1, 'calt' 0, 'ss01' 1"
rounded:
  sharp: "4px"
  sm: "8px"
  md: "10px"
  lg: "12px"
  pill: "999px"
spacing:
  hair: "1px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "48px"
  4xl: "64px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.bone}"
    rounded: "{rounded.md}"
    padding: "10px 18px"
    typography: "{typography.title}"
  button-primary-hover:
    backgroundColor: "{colors.sea-deep}"
    textColor: "{colors.bone}"
  button-secondary:
    backgroundColor: "{colors.bone}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 18px"
    typography: "{typography.title}"
  button-secondary-hover:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.ink}"
  button-ghost:
    backgroundColor: "{colors.bone}"
    textColor: "{colors.ink-soft}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    typography: "{typography.title}"
  button-ghost-hover:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.ink}"
  card:
    backgroundColor: "{colors.bone}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "20px 24px"
  card-quiet:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "20px 24px"
  input:
    backgroundColor: "{colors.bone}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    typography: "{typography.body}"
    height: "40px"
  input-numeric:
    backgroundColor: "{colors.bone}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
    typography: "{typography.numeric}"
    height: "40px"
  badge-paid:
    backgroundColor: "{colors.olive-tint}"
    textColor: "{colors.olive}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
    typography: "{typography.label}"
  badge-overdue:
    backgroundColor: "{colors.oxide-tint}"
    textColor: "{colors.oxide}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
    typography: "{typography.label}"
  badge-pending:
    backgroundColor: "{colors.sea-tint}"
    textColor: "{colors.sea-deep}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
    typography: "{typography.label}"
  table-row:
    backgroundColor: "{colors.bone}"
    textColor: "{colors.ink}"
    padding: "14px 16px"
    typography: "{typography.body}"
  table-row-hover:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.ink}"
  nav-rail:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.ink-soft}"
    padding: "20px 16px"
  nav-item-active:
    backgroundColor: "{colors.bone}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
    typography: "{typography.title}"
---

# Design System: MicroRealEstate

## 1. Overview

**Creative North Star: "The Pangrati Apartment"**

A well-kept apartment in central Athens at 11am. Cream walls, raw-linen upholstery, marble countertop, a single fishing-boat-blue shutter against the light. The visual language descends from architectural calm: the surface is mostly bone and cream, the type does the work of hierarchy, color is rare on purpose. The app is the landlord's own desk made digital, not a tool sold to them.

Three commitments sit underneath every decision. First, **typography carries the weight**. A display serif (Source Serif 4) for figures the user should pause on, a precise sans (Inter) for everything operational, a tabular monospace (JetBrains Mono) wherever a number is money. Greek glyphs render with proper diacritics; tabular numerals hold rent columns straight. Second, **color is earned, never decorative**. One accent (sea-blue), one warning (oxide), one success (olive). They mean what they say every time they appear. Third, **paper-flat material**. No drop shadows at rest. Depth comes from tonal layers (body to bone to cream) and 1px hairline rules. Shadows appear only on overlays where they're structural, never on cards.

This system explicitly rejects the four anti-references in PRODUCT.md: it is not generic property-tech SaaS (no cobalt-blue primary, no hero-metric template, no smiling-house illustrations); not heavy enterprise CRM (no toolbar soup, no nested tabs, no gray-on-gray density without discipline); not crypto/fintech bro (no glassmorphism, no neon, no animated mesh, no gradient text); and not the default shadcn demo (the cobalt `--primary: 221 83 53` currently shipped is the gap to close, not the destination).

**Key Characteristics:**
- Bone-and-cream surface, ink text, sea-blue accent ≤5% of any screen
- Display serif + UI sans + tabular mono, with first-class Greek
- 10–12px radius, generous whitespace, hairline (1px) borders for hierarchy
- Paper-flat material; shadows reserved for overlays
- Currency renders as `1.234,56 €` (el-GR convention) in tabular numerals
- State carries a glyph and a label, not just a hue
- Motion is restrained: 150–200ms ease-out-quart on state transitions, instant on `prefers-reduced-motion`

## 2. Colors: The Architectural Palette

The palette is borrowed from materials, not from a brand guideline: ink, paper, stone, sea, terracotta, olive. Every neutral is tinted toward the ink hue (chroma 0.004–0.010) so the system reads as warm, not clinical. Color appears on purpose; on most screens, only ink, bone, and one accent should be visible.

### Primary
- **Sea Blue** (`oklch(48% 0.092 240)`): The single identity accent. Appears on primary buttons (or, more often, the rare *secondary* call-to-action; primary buttons default to ink), the active navigation item indicator, focus rings, the current row in a table, and the "pending" pill on a rent statement. **Rule of thumb: ≤5% of any given screen.** If a stranger could spot the brand color in three places at once, you're using too much.
- **Sea Deep** (`oklch(38% 0.098 240)`): Hover state for sea-blue surfaces; also serves as the high-contrast text color when type sits on `sea-tint`.

### Secondary
- **Ink** (`oklch(20% 0.012 240)`): Carries the *primary* button background, headlines on cream, and the densest text. Tinted toward the sea hue at chroma 0.012 so it never reads as pure black on bone. **Never use `#000`.**

### Tertiary
- **Oxide** (`oklch(55% 0.144 35)`): Terracotta-red. Used exclusively for overdue rent, destructive button text, and validation errors. Never decorative. The roof-tile color of an Athens rooftop, not a SaaS error red.
- **Olive** (`oklch(48% 0.080 130)`): Used exclusively for paid status, success toasts, and resolved indicators. The leaf of an old olive tree, not a Twitter-green.

### Neutral
- **Bone** (`oklch(98% 0.004 85)`): The default surface. Cards, table rows at rest, modal interiors, button-secondary background. Slightly warm; never reads as cold-white.
- **Cream** (`oklch(96% 0.006 85)`): The body background. The page sits on cream so cards (bone) lift one step without a shadow. Also the navigation-rail background, secondary panels, hovered table rows.
- **Stone** (`oklch(92% 0.006 85)`): Subtle dividers and disabled fills. Use sparingly.
- **Stone Line** (`oklch(88% 0.008 85)`): The 1px hairline border color. The single most-used line in the system. Tables are ruled with it; cards are bordered with it; sections separate with it.
- **Marble** (`oklch(82% 0.010 85)`): Stronger borders for selected states, focused inputs, the active table row's leading edge.
- **Ink Soft** (`oklch(34% 0.010 240)`): Body text where slightly de-emphasized. Default body color on `cream` surfaces is ink-soft; on bone it's ink.
- **Ink Muted** (`oklch(50% 0.008 240)`): Labels, secondary metadata, table column headers, "last updated 5 minutes ago" timestamps.

### Tints (for state-bearing surfaces)
- **Sea Tint** (`oklch(94% 0.024 240)`): Background for "pending" pills and informational callouts.
- **Oxide Tint** (`oklch(94% 0.030 35)`): Background for "overdue" pills and destructive callouts.
- **Olive Tint** (`oklch(94% 0.024 130)`): Background for "paid" pills and success callouts.

### Named Rules

**The Earned-Accent Rule.** Sea-blue is forbidden as decoration. It appears only when it carries semantic weight: primary action, current selection, focus, pending state, link. If you can remove it and the meaning survives, remove it.

**The No-Black Rule.** `#000`, `oklch(0% 0 0)`, and bare `black` are prohibited. The darkest text is `ink` (`oklch(20% 0.012 240)`). The same rule applies on the inverse: `#fff` and `oklch(100% 0 0)` are prohibited; the lightest surface is `bone`.

**The Hue-Drift Rule.** Every neutral carries a small hue shift (chroma 0.004–0.012) toward the sea or ink hue. Pure-grey neutrals (chroma 0) are forbidden because they look clinical against the warm bone surface and break the architectural feel.

## 3. Typography

**Display Font:** Source Serif 4 (with Source Serif Pro, Newsreader, Georgia as fallbacks)
**Body Font:** Inter (with `ui-sans-serif`, `system-ui`, `-apple-system`, Segoe UI as fallbacks)
**Numeric Font:** JetBrains Mono (with IBM Plex Mono, SF Mono, `ui-monospace` as fallbacks)

**Character:** A typographic pairing borrowed from a financial publication. Source Serif 4 is the most patient, most legible screen-serif drawn in the last decade; it carries Greek glyphs with diacritics that don't crowd. Inter does what Inter does, with the `ss01` stylistic set on for unambiguous lowercase l (`l` not `I`). JetBrains Mono is the numeric workhorse: tabular by default, designed for columns of money to read straight. Together they read as *editorial*, never *demo*.

### Hierarchy

- **Display** (Source Serif 4, weight 400, 1.75rem / 28px, line-height 1.15): Page-level titles. The single biggest type on a page. Appears in landlord names on a tenant detail screen, the building name at the top of a polykatoikia view, the month-and-year on a rents page. **One per page.**
- **Headline** (Source Serif 4, weight 500, 1.375rem / 22px, line-height 1.25): Section titles inside a page. The "Σύμβαση," "Πληρωμές," "Δαπάνες" headers in a tenant detail. Used three to six times per page.
- **Title** (Inter, weight 600, 1rem / 16px, line-height 1.35): Card titles, modal titles, button text, table column headers. The transition point where serif gives way to sans.
- **Body** (Inter, weight 400, 0.9375rem / 15px, line-height 1.55): The default text size. Body copy capped at **65–75ch** for readability. Notes, descriptions, tooltips, paragraph text. Numerals in body text remain proportional unless they're standing in a column.
- **Label** (Inter, weight 500, 0.75rem / 12px, line-height 1.4, letter-spacing 0.04em): Small UPPERCASE-ish labels (sentence case, but with the wider tracking labels need at small sizes), pill text, table-cell labels, "Παγκράτι" on a property card, "Ληγμένη" on an overdue rent.
- **Numeric** (JetBrains Mono, weight 400, 0.9375rem / 15px, line-height 1.4, `font-variant-numeric: tabular-nums`): Every column of money, every IBAN, every ATAK number, every percentage in a thousandths allocation, every IRIS RF code. **If it's a number that stacks, it's mono.**

### Named Rules

**The Tabular-Numeral Rule.** Anywhere two numbers stack vertically and a user might compare them, they render in JetBrains Mono with `font-variant-numeric: tabular-nums`. Rents tables, payment columns, building expense allocations, dashboard totals. Proportional numerals stacked in a column read as sloppy bookkeeping.

**The el-GR Currency Rule.** Currency is formatted via `Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR' })` and rendered as `1.234,56 €`. Period thousands, comma decimal, space, then symbol *after* the amount. Force-formatting Greek currency as `€1,234.56` is a category-1 bug, not a style issue.

**The Diacritic-Headroom Rule.** Greek body type uses line-height ≥ 1.5 so polytonic and monotonic diacritics never collide with the line above. The Source Serif and Inter pairing was chosen partly for diacritic positioning; substituting a font without proper Greek support is forbidden.

**The Single-Display-Per-Page Rule.** The display serif appears once on a page. It marks "where am I?" If display type appears twice, one of the two is a headline and should be downgraded.

## 4. Elevation

The system is **paper-flat by default**. Hierarchy comes from three tonal layers (`cream` body → `bone` card → `cream` pressed/active) and from 1px hairline rules in `stone-line`. Shadows are not used decoratively. They appear only when an element genuinely lifts away from the page: popovers, dropdowns, dialogs, drawers, toasts.

This is not "no shadows ever." It is "shadows mean lift, and lift means the element is structurally above the page surface."

### Shadow Vocabulary

- **Surface lift** (`box-shadow: 0 1px 2px oklch(20% 0.012 240 / 0.04)`): Reserved for hovered table rows that are *interactive* (clickable rows lift a hair on hover). Almost imperceptible.
- **Floating** (`box-shadow: 0 8px 24px oklch(20% 0.012 240 / 0.08), 0 1px 2px oklch(20% 0.012 240 / 0.06)`): Popovers, dropdowns, command palettes. Two-stop shadow so the element reads as both *near* (the 1px contact shadow) and *up* (the 24px ambient shadow).
- **Modal** (`box-shadow: 0 24px 64px oklch(20% 0.012 240 / 0.16), 0 2px 4px oklch(20% 0.012 240 / 0.08)`): Dialogs and drawers. Stronger lift; behind it sits a backdrop at `oklch(20% 0.012 240 / 0.32)` so the page recedes.
- **Toast** (`box-shadow: 0 12px 32px oklch(20% 0.012 240 / 0.12)`): Sonner toasts. Floats top-right.

### Named Rules

**The Flat-Card Rule.** Cards do not have drop shadows. Cards have a 1px `stone-line` border and sit on a `cream` body, which is enough to read as a card. The current shadcn `shadow-sm` on cards is the visual signature of every Vercel demo and must be removed.

**The Lift-Means-Above Rule.** A drop shadow is a structural claim. If the element is inline on the page, it has no shadow. If the element is overlaid above the page (popover, dropdown, dialog, drawer, toast, command palette), it gets the appropriate shadow from the vocabulary above.

**The Backdrop Rule.** Modal-class overlays (dialog, drawer) always pair their shadow with a darkening backdrop on the page behind. The backdrop uses `ink` at 32% alpha, never pure black, so the warm tone of the page survives.

## 5. Components

Each component leads with the character it should project, then the specifics.

### Buttons

Buttons are quiet. They sit on the page at 40px height, 10px radius, 18px horizontal padding, with 600-weight Inter text. They never lift on hover; they shift color.

- **Shape:** 10px radius (`rounded.md`), 40px height for the default size, 32px for `sm`, 44px for `lg`. **No icon-only square buttons unless the icon's meaning is unambiguous.**
- **Primary:** Ink background, bone text. Hover transitions ink → sea-deep over 150ms ease-out-quart. The primary button is the *single* primary action on a screen; if there are two, one is wrong.
- **Secondary:** Bone background, ink text, 1px `stone-line` border. Hover: cream background. The default for "Cancel," "Επεξεργασία," "Εξαγωγή."
- **Ghost:** No background, ink-soft text. Hover: cream background, ink text. Used in dense toolbars and table rows.
- **Destructive:** Bone background, oxide text, 1px oxide border. Hover: oxide-tint background. Reserved for delete, archive, force-delete actions. Confirmation dialogs use destructive style on the destructive button only; the cancel button stays secondary.
- **Focus:** All variants get a 2px sea-blue ring with 2px offset against the page color. The ring must be visible against bone *and* cream surfaces; this is non-negotiable.
- **Disabled:** 50% opacity, `pointer-events: none`. No alternative styling.

### Cards

Cards are paper. They hold related content together with a hairline border, no lift.

- **Corner Style:** 12px radius (`rounded.lg`).
- **Background:** Bone (default) or cream (when the card is *quieter* than its surroundings, e.g. a metadata sidebar next to a primary content column).
- **Border:** 1px `stone-line`. **Always a full border, never a side stripe.** Side-stripe borders greater than 1px are forbidden by the absolute bans.
- **Internal Padding:** 20px vertical, 24px horizontal for default. Compact variants drop to 16px / 20px.
- **Shadow:** None at rest. None on hover unless the card is itself a clickable affordance, in which case `surface-lift` applies.
- **Nested Cards:** Forbidden. If you find yourself nesting a card in a card, replace the inner card with a horizontal rule + section heading, or split into two side-by-side panels.

### Inputs and Form Fields

Inputs read as paper, with the typing happening on the surface, not in a recessed slot.

- **Style:** 40px height, 10px radius, 1px `stone-line` border, bone background, ink text, 14px horizontal padding.
- **Numeric inputs:** Use the JetBrains Mono numeric type role at the same size. Currency inputs include the `€` glyph as a static suffix in the field, right-aligned.
- **Focus:** Border shifts to sea-blue, plus a 2px sea-blue ring at 2px offset. No glow. No animation beyond a 120ms color transition.
- **Error:** Border shifts to oxide, error message renders below in Label type / oxide color. The field icon (if any) shifts to oxide as well.
- **Disabled:** 60% opacity, cream background, `cursor: not-allowed`.
- **Label position:** Above the field, in Label type / ink-muted, 8px below the field's top edge.

### Tables

Tables are the most-used surface in this app. They must read like a printed ledger, not like an interactive spreadsheet.

- **Row height:** 48px default, 56px for tables that include avatars or two-line cells.
- **Row background:** Bone, alternating with `cream` only when the table exceeds 12 rows; otherwise no zebra striping (zebra in short tables creates noise).
- **Row hover:** Cream background, 120ms color transition, no lift.
- **Row selected:** Sea-tint background, 2px sea-blue leading edge (1px counts as a hairline; this is the one place a marble-thicker indicator earns its keep, and it's a 2px *fill on the row's leading edge*, not a `border-left` stripe; implement via `box-shadow: inset 2px 0 0 var(--sea)`).
- **Column headers:** Label type, ink-muted, 1px `stone-line` bottom rule, sticky on scroll. Right-aligned for numeric columns, left for text.
- **Numeric cells:** JetBrains Mono, tabular numerals, right-aligned. Currency uses the el-GR rule.
- **Empty state:** A single line of body text in ink-muted, vertically centered in 240px of empty space. No illustration. No "Get started" button unless the table genuinely supports a primary action and the user is allowed to do it.

### Navigation Rail

The left navigation is the spine of the app. It must read as part of the room, not as a control panel.

- **Background:** Cream.
- **Width:** 240px on desktop, collapses to 64px (icons only) on tablet, becomes a sheet on mobile.
- **Item style:** 8px vertical padding, 12px horizontal, Title type, ink-soft, 12px gap between icon and label. 10px radius on the hover/active state's background.
- **Active item:** Bone background (lifts one tonal step from the cream rail), ink text, 2px sea-blue indicator on the leading edge (same `box-shadow: inset` technique as table-row-selected).
- **Hover:** Bone background at 50% opacity, ink text, no shift.
- **Section dividers:** Hairline `stone-line`, 16px vertical margin.

### Pills (Status Badges)

Pills carry state. The user reads them in a glance.

- **Shape:** Pill (999px radius), 4px vertical padding, 10px horizontal, Label type.
- **Paid:** Olive-tint background, olive text. Includes a small filled-circle glyph (4px) on the leading edge.
- **Overdue:** Oxide-tint background, oxide text. Includes a small triangle-warning glyph.
- **Pending:** Sea-tint background, sea-deep text. Includes a small clock glyph.
- **Archived:** Stone background, ink-muted text. No glyph.
- **Color is not the only signal.** Each state has a glyph; each pill includes a label. Color blindness must not break a rents table.

### Dialogs and Drawers

- **Dialog:** 12px radius, bone background, 32px internal padding, modal shadow, ink-at-32% backdrop. Title in Display type at the dialog scale (1.375rem). Primary action right, secondary action left, both at the bottom edge with 12px gap.
- **Drawer:** Same internal treatment. Slides from right at 480px wide on desktop, full-height. Used for create/edit flows that don't need the page-level context (NewTenantDialog, BillImportDialog).
- **Modal-as-first-thought is forbidden.** Inline edits and progressive disclosure are the default. Modals appear only when the user must commit a complete operation (delete with consequences, multi-step import, complex form) and the surrounding context is genuinely irrelevant.

### Currency Display

This is a signature component because it appears everywhere money does, and getting it wrong betrays the whole product.

- **Format:** `Intl.NumberFormat(orgLocale, { style: 'currency', currency: 'EUR' }).format(amount)`. For el-GR: `1.234,56 €`.
- **Type:** Numeric role (JetBrains Mono, tabular).
- **Alignment:** Right in tables, default in body text.
- **Color:** Ink for default, olive for credits/paid, oxide for debits/overdue. **Never colorize positive vs. negative with red/green only.** Pair with a leading sign (`+ 1.234,56 €` for credits, `‑ 1.234,56 €` for debits, using a true minus sign U+2212, not a hyphen).

## 6. Do's and Don'ts

### Do:
- **Do** use ink (`oklch(20% 0.012 240)`) as the darkest color and bone (`oklch(98% 0.004 85)`) as the lightest. Pure black and pure white are forbidden.
- **Do** keep sea-blue accent ≤5% of any screen. If you can remove it without losing meaning, remove it.
- **Do** render every column of money in JetBrains Mono with `font-variant-numeric: tabular-nums`.
- **Do** format Greek currency as `1.234,56 €` (period thousands, comma decimal, space, symbol after). Use `Intl.NumberFormat('el-GR', { style: 'currency', currency: 'EUR' })`.
- **Do** use 12px radius (`rounded.lg`) for cards, 10px (`rounded.md`) for buttons and inputs, 8px (`rounded.sm`) for nested controls. Never larger.
- **Do** convey depth through tonal layers (cream → bone → cream-pressed) and 1px `stone-line` hairlines. Reserve drop shadows for genuine overlays.
- **Do** pair every status color with a glyph and a label. Color must not be the only signal.
- **Do** use the display serif (Source Serif 4) once per page, on the page-level title only.
- **Do** respect `prefers-reduced-motion`: reduce non-essential motion to instant; keep essential motion (toast, dialog open) at reduced amplitude.
- **Do** ensure 2px sea-blue focus rings are visible across both bone and cream surfaces. WCAG 2.2 AA minimum, AAA on body text where free.
- **Do** keep body line length capped at 65–75ch.

### Don't:
- **Don't** use the cobalt `--primary: 221 83 53` currently in `globals.css`. That is the **default shadcn demo** anti-reference from PRODUCT.md, and shipping it is the gap to close.
- **Don't** use stock illustrations of houses, smiling people, or hand-drawn pastel shapes. The **generic property-tech SaaS** anti-reference from PRODUCT.md.
- **Don't** ship the hero-metric template (big number + small label + supporting stats + gradient accent). That is the SaaS cliché the absolute bans prohibit.
- **Don't** use glassmorphism, blurred translucent panels, neon glow, gradient text, or animated mesh backgrounds. **Crypto / fintech bro** anti-reference.
- **Don't** stack tabs inside tabs, nest cards inside cards, or build toolbar-soup action bars. **Heavy enterprise CRM** anti-reference.
- **Don't** use `border-left` or `border-right` greater than 1px as a colored stripe on cards, list items, or alerts. Side-stripe borders are absolutely banned. The single exception, the active row/nav indicator, uses `box-shadow: inset 2px 0 0 var(--sea)` on the leading edge instead.
- **Don't** use `background-clip: text` with a gradient. Gradient text is forbidden.
- **Don't** use display serif for buttons, labels, or table headers. Display is for page titles only.
- **Don't** use proportional numerals in any column of money.
- **Don't** force en-US currency formatting (`€1,234.56`) on Greek users. The format is `1.234,56 €`. This is correctness, not preference.
- **Don't** colorize positive vs. negative balances with red/green alone. Pair with a leading `+` / `−` sign and the appropriate olive/oxide color.
- **Don't** add drop shadows to cards. Cards are paper. Hierarchy comes from tonal layers and hairline borders.
- **Don't** reach for a modal as the first answer. Inline edits and progressive disclosure are default; modals are reserved for committed operations.
- **Don't** use `#000`, `#fff`, `oklch(0% 0 0)`, or `oklch(100% 0 0)` anywhere. Tinted neutrals only.
- **Don't** use em dashes in copy (`—` or `--`). Commas, colons, semicolons, periods, or parentheses instead.
- **Don't** use exclamation marks in UX copy. The voice is "competent neighbor explaining," not "Awesome!"

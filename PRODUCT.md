# Product

## Register

product

## Users

A solo Greek landlord at their desk, managing 1–20 properties across one or more polykatoikia. They work mostly on a laptop, in Greek (with occasional English), often in the evening after a day of other work. They are not a power user of software, but they are an expert on their own portfolio: which tenant pays late, whose lease ends in March, what the DEH bill was last quarter.

The job is reconciliation, not exploration. They open the app to answer one of a small set of questions: who owes me what, what did I send to whom, when does this contract end, how do I split this κοινόχρηστα bill across the units. Everything else is overhead.

Secondary users (small teams of 2–5 collaborators, international self-hosters) are respected, not centered. The design optimizes for the solo Greek landlord; the rest gets the system as a side effect.

## Product Purpose

MicroRealEstate is the landlord's ledger, made digital and made Greek. It exists so the landlord can stop maintaining a spreadsheet, a folder of PDFs, and a notebook in three different places. Success looks like: the landlord opens the app, sees what they need to know, acts on one thing, and closes it. Not a session. A glance.

The Greek-market specifics are the product, not a localization layer:

- AADE Taxisnet lease PDF import (regex-parsed contracts straight from the tax authority)
- DEH utility bill OCR and auto-allocation across building units
- IRIS QR codes and RF payment codes on tenant statements
- Polykatoikia model with thousandths-based κοινόχρηστα allocation, διαχειριστής role, ATAK numbering
- el-GR formatting (comma decimal, € symbol after the amount, polytonic-safe Greek typography)

Take those away and what remains is a generic property tracker. The product loses.

## Brand Personality

Warm, local, human.

Voice: the way a competent neighbor explains something. Direct, in the user's own words, without jargon or condescension. Short sentences. No exclamation marks, no celebratory micro-copy, no "Awesome!" toasts.

Materials and references that evoke the right feel: a well-organized accountant's office in Pangrati. A leather-bound λογαριασμός book. Worn marble, raw linen, terracotta tile, the blue of a fishing-boat hull, the cream of an old ledger page. Mediterranean light, not Bay Area gradient.

The interface should feel like the landlord's own desk: organized, lived-in, theirs. Not a tool that was sold to them.

## Anti-references

This product should explicitly NOT look like:

- **Generic property-tech SaaS.** Stock cobalt blue, stock illustrations of houses with smiling faces, hero-metric boxes with gradient accents, the Zillow / Buildium / AppFolio aesthetic. The current default theme (cobalt `--primary: 221 83 53`) is exactly this trap. Escape it.
- **Heavy enterprise CRM.** Salesforce / SAP density without the discipline. Toolbar soup, modal-everything, tabs nested inside tabs, gray-on-gray Bootstrap energy, action menus with twenty-five options.
- **Crypto / fintech bro.** Neon on black, glassmorphism, gradient text, animated mesh backgrounds, every card lifting on hover, "Powered by AI" badges anywhere.
- **Default shadcn demo.** Cobalt-blue primary, identical card grids, hero-metric template, the look every Vercel demo ships with. The current state of the codebase, basically. The starting point, not the destination.

If a stranger visited the app and could guess the framework from the first screen, the design has failed.

## Design Principles

1. **Local before global.** Greek-market workflows are first-class, not afterthoughts. AADE import, DEH bills, IRIS, polykatoikia, διαχειριστής, thousandths allocation: design the screens that handle these *first*, then make sure the rest of the world fits the system, not the other way around.

2. **Lived-in, not corporate.** This is a personal ledger that happens to run in a browser. Reach for materials and palette that feel like a place, not a SaaS demo. Color references: stone, terracotta, sea, paper, ink. Avoid the categorical reflex of "real-estate app → cobalt blue."

3. **Quiet authority.** Information density without chaos. Restrained type, deliberate spacing, deliberate color. No decoration that doesn't earn its place. The landlord is the expert; the app shouldn't shout at them.

4. **Workflow first, identity follows.** Identity emerges from how the daily-driver screens (rents, tenants, properties, dashboard, building expenses) actually feel under fingers, not from a logo or a splash. Polish those four screens to a high finish before chasing identity in marginal surfaces.

5. **Greek typography is the test.** If Greek doesn't render beautifully — diacritics cramped, € on the wrong side, monospace numbers misaligned in a rents table — nothing else matters. The script is the hardest case; if it works, Latin works for free.

## Accessibility & Inclusion

- **WCAG 2.2 AA** as the floor for all text and non-text UI. AAA where it's free (body copy on `--background` should hit 7:1 by default; tight contrast appears only on intentional secondary surfaces).
- **Full keyboard navigability.** Every interactive control reachable in a logical tab order, every focused state visible at a glance (focus rings strong enough to read across the cream/stone neutral surfaces this palette will lean toward).
- **`prefers-reduced-motion` respected** without ceremony. Non-essential motion (hover lifts, page-transition fades) cuts to instant. Essential motion (toast entry, dialog open) stays but at reduced amplitude.
- **Greek typography quality is part of accessibility, not aesthetics.** Body type must include both polytonic and monotonic Greek with proper diacritic positioning, line-height ≥ 1.5 to give marks room, and no fallbacks to `Times New Roman`-style ugly Greek glyphs. Number tables use `font-variant-numeric: tabular-nums`.
- **el-GR locale conventions are first-class.** Currency renders as `1.234,56 €` (space, then symbol, after the amount). Decimal separator is comma; thousands separator is period. Date format is `DD/MM/YYYY`. The same rule, written in code, applies to other locales: respect the locale, don't force en-US.
- Color is never the only signal. State (overdue, paid, pending) carries a glyph and a label, not just a hue, so red-green color blindness doesn't break the rents table.

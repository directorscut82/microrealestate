I'll synthesize this into a per-surface UI defect catalogue. Let me process the data according to your rules: drop any P0/P1 where verdict.confirmed=false or corrected=not-a-defect, apply corrected severities to confirmed P0/P1s, keep P2/P3 as-is, and order worst-first.

Let me work through the severity recalculations carefully, since the adversarial verification often downgrades P0/P1 claims.

# Per-Surface UI Defect Catalogue — MicroRealEstate (Greek property management)

The owner is right: most of these screens read as AI-default card walls with off-palette color and broken figures. Below, every P0/P1 has been run through adversarial verification — claims that didn't survive (confirmed=false / not-a-defect) are dropped, and surviving ones carry their corrected severity. P2/P3 stand as filed. Surfaces are ordered worst-first by remaining defect weight.

---

## 1. building-overview — verdict: POOR · looksAIGenerated: NO

The worst real screen. Two confirmed money-display bugs plus a missing ledger total. (Both original P0s survived but were downgraded: the em-dash to P2, the contradictory bar to P1.)

| Sev | Category | What | Where | Fix |
|---|---|---|---|---|
| **P1** | other | "ΜΗ ΕΙΣΠΡΑΧΘΕΝΤΑ" bar is self-contradictory. Header reads "Καλυμμένα 10,85 € / 10,85 €" (looks fully covered) but the track is empty and the foot says "Καλυμμένα: 0,00 €". `BarRow` is fed `uncollected.outstanding` (10,85) as the first number while labeled `t('Covered')`; fill pct uses `paidTotal` (0). | ΜΗ ΕΙΣΠΡΑΧΘΕΝΤΑ card; `BuildingDashboard.js` BarRow | First number must be `uncollected.paidTotal`, not `outstanding`. Then header reads 0,00 € / 10,85 €, empty track, consistent foot. |
| **P1** | mockup-divergence | Floor table has no totals row. Mockup ends with a bold "Σύνολο" row (493,25 τ.μ. / 650,00 €, top-ruled marble, cream bg). Shipped table just stops; operator can't see total m²/rent at a glance. | Floor-by-floor table; `BuildingDashboard.js` TableBody | Add the totals row: sum `unit.surface` + tenant rent, bold, `border-top border-marble`, `bg-cream`, m² via `fmtNum`, rent via NumberFormat. |
| **P2** | banned-pattern | Em dashes (—) in UX copy in ≥4 places, banned by DESIGN.md. "Δεν αποτελούν οφειλή — οι καταβολές…"; "ΕΝΟΙΚΙΑΣΤΕΣ — δεν αφαιρούνται…"; "ΙΔΙΟΚΤΗΤΕΣ — αφαιρούνται…". Literal — chars in source strings. | ΜΗ ΕΙΣΠΡΑΧΘΕΝΤΑ body; breakdown group labels | Replace each — with colon/comma/parens in source + el/en locales, not just render. e.g. "ΕΝΟΙΚΙΑΣΤΕΣ (δεν αφαιρούνται από το Καθαρό)". |
| **P2** | hierarchy | "ΑΠΟ ΑΡΧΗΣ ΕΤΟΥΣ" card dominated by a full-width 100%-filled olive bar for a trivial 0,21 € figure — reads as broken ("fully paid" bar for nothing). Three near-identical stacked progress-bar cards are monotonous. | ΑΠΟ ΑΡΧΗΣ ΕΤΟΥΣ + ΜΗ ΕΙΣΠΡΑΧΘΕΝΤΑ cards | Suppress the bar (plain figure) below a meaningful threshold; vary visual weight so the rent bar reads as primary. |
| **P2** | color | Income (360,00 €) rendered olive/green; olive is reserved for credits/paid, not a routine gross projection. | ΕΤΗΣΙΑ ΠΡΟΒΟΛΗ card, Έσοδα row | Render Έσοδα in `text-ink`. Keep −/oxide on Έξοδα ιδιοκτήτη and the conditional color on Net only. |
| **P2** | cramping | ΙΔΙΟΚΤΗΤΕΣ group renders one lonely 0,21 € cell in a `grid-cols-4` wrapper, leaving ~3 empty columns of dead space next to a full 4-up ΕΝΟΙΚΙΑΣΤΕΣ row. Looks unfinished. | ΑΝΑΛΥΣΗ ΕΞΟΔΩΝ ΚΤΙΡΙΟΥ, ΙΔΙΟΚΤΗΤΕΣ row | When the owner group has one cell, constrain width (mockup's `.comp.one` max-w-[260px]) so it isn't stranded across 4 cols. |
| **P2** | typography | "Διαγραφή" (Delete) button styled as neutral outline with ink-muted text — no destructive signal. Safety + consistency issue. | Top-right header action | Apply destructive style (oxide text + oxide border, oxide-tint hover). |
| **P3** | greek-wording | "δεν χρεώνονται σε κανέναν" is machine-flavored; "Καταβολή κάλυψης" button is terse jargon. | ΜΗ ΕΙΣΠΡΑΧΘΕΝΤΑ body + button | "…δεν επιβαρύνουν κανέναν…"; reconsider button verb to match the term used elsewhere for recording an owner payment. |
| **P3** | spacing | "ΔΟΚΙΜΗ ΒΗΤΑ" repeats on ~7 basement rows; (50%) suffix shown inconsistently (only when <100%), looks like a data glitch. | Floor table, Ιδιοκτήτης column | Collapse repeated owner per floor group (like the floor label); make the (50%) suffix consistent within a unit. |

---

## 2. property-detail — verdict: POOR · looksAIGenerated: YES

Both original P0s did NOT survive verification (the total-mismatch was not-a-defect; the leaked-id and missing-price were downgraded). What remains is a single-tab dead-chrome layout with no page title.

| Sev | Category | What | Where | Fix |
|---|---|---|---|---|
| **P2** | banned-pattern | Garbage id leaks into the expense line: "Ύδρευση (d6aa8660a511asdas)". `_looksLikeId()` regex `/^[0-9a-f]{8,}$/i` rejects the token because of the 's' chars, so it's treated as a real name. | "Έξοδα ακινήτου" card, current-month line | Broaden heuristic to catch space-free mixed-alphanumeric handles (e.g. `/^[0-9a-z]{10,}$/i` no spaces); fall back to "Ύδρευση" alone. |
| **P2** | typography | Surface (81,44), ATAK (00849565780), ΔΕΗ supply number render in proportional Inter, not the mandated tabular mono numeric role. | PropertyForm fields | Apply `font-mono tabular-nums` to Surface, ATAK, plot-surface, ΔΕΗ inputs. |
| **P2** | banned-pattern | Left column wrapped in a Tabs/TabsList with exactly ONE TabsTrigger ("Ακίνητο") — dead chrome, full-width tab bar that can't switch, reads as AI scaffolding. | "Ακίνητο" tab bar above the form | Remove the Tabs wrapper for a single panel; render the form Card directly. |
| **P2** | typography | Energy-cert date field is a raw native `<input type="date">` with browser-default "dd/mm/yyyy" (English) placeholder + OS calendar glyph; unstyled vs design inputs. | Form, energy-cert date field | Use the design-system styled field / app date-picker; localize placeholder to ηη/μμ/εεεε. |
| **P2** | color | Multiple sea-blue glyphs (key, history, receipt) + dotted building link + name link all in the narrow right column at once — stretches the ≤5% earned-accent rule; decorative icons carry no semantic weight. | Right sidebar card-header icons + building link | Render decorative icons ink-muted; reserve sea-blue for the interactive building link + focus/selected only. |
| **P2** | alignment | In "Έξοδα ακινήτου", header total 5,01 € (with chevron) and child 0,15 € right-align to different edges; decimal commas/€ don't line up. | "Έξοδα ακινήτου" card | Right-align all amounts to one rail; put the disclosure chevron in a separate fixed-width gutter outside the number column. |
| **P3** | other (was P1) | "Ακίνητο" overview card shows a bare "—" in the price slot (price undefined/0). The single most important figure reads as a stray dash. | Top "Ακίνητο" card, right of name | If price is 0/unset, render "0,00 €" with `showZero` or hide the slot; confirm price actually flows through. |
| **P3** | hierarchy (was P1) | No display-serif page title naming the property; only the lone "Ακίνητο" tab + a repeated "Ακίνητο" card title. No "where am I?" anchor. | Top of page | Add a Source Serif 4 display-scale title with the property name; demote the duplicate "Ακίνητο" labels. |
| **P3** | spacing | "Προηγούμενοι ενοικιαστές" gives a junk-named tenant ("3ed3ed") a full-height card with empty space below. (Partly seed data.) | "Προηγούμενοι ενοικιαστές" card | Verify name isn't a raw id; tighten card so a single short entry doesn't leave a tall empty block. |

---

## 3. tenant-detail — verdict: POOR · looksAIGenerated: YES

Two strong layout-law violations survived as P1 (no-hierarchy total, nested card). The toolbar-soup claim was downgraded to P2; the page-title claim to P3.

| Sev | Category | What | Where | Fix |
|---|---|---|---|---|
| **P1** | hierarchy | "Σύνολο" total renders at the exact same mono size/weight/color as its line items (450,00 / 100,00 / 550,00 are one undifferentiated stack separated only by a hairline). The figure to pause on is invisible. | Right "Ενοικίαση" card, Σύνολο row | Promote: label in Title weight (Inter 600 ink), amount one step larger (~1.125rem mono) below the hairline; line items stay body/ink-muted. |
| **P1** | banned-pattern | Nested card: "Επαφή #1" is a fully-bordered rounded card INSIDE the bordered "Στοιχεία επικοινωνίας" card. DESIGN.md §5: nested cards forbidden. | Center column, contact block | Remove inner border/bg; use a section heading + 1px stone-line rule; separate multiple contacts with hairline dividers. |
| **P2** | banned-pattern (was P1) | Toolbar soup: six identical large icon-over-label boxes (Πίσω, Αρχειοθέτηση, Διαγραφή, Τερματισμός, Επεξεργασία, Πρόγραμμα). Zero hierarchy; destructive actions get no oxide treatment. | Button row above the tabs | One primary (Επεξεργασία ink button); Πίσω as a plain back-link; group Αρχειοθέτηση/Διαγραφή/Τερματισμός in an overflow menu or render destructive (oxide). |
| **P2** | other | Lease status "Σε εξέλιξη" is plain ink text — no pill, glyph, or color; indistinguishable from a date. | Right "Μίσθωση" card, Κατάσταση row | Render as a status pill: olive-tint bg + olive text + filled-circle glyph for active (sea-tint pending if not yet started). |
| **P2** | other | Dangling empty key: "Συμβόλαιο" row shows a label with no value, while other rows have a value or "—". Reads as a render bug. | Right "Μίσθωση" card, Συμβόλαιο row | Show the lease/template name, use the "—" placeholder, or hide the row when empty. |
| **P2** | greek-wording | "Σε εξέλιξη" reads like a task state ("in progress"), not a lease label. Greek accountant says "Ενεργή". | Right "Μίσθωση" card, Κατάσταση value | Use lease-appropriate Greek: Ενεργή / Λήγει / Λήξασα / Μελλοντική. |
| **P3** | typography (was P1) | Two display-serif section headlines ("Πληροφορίες ενοικιαστή", "Στοιχεία επικοινωνίας") and neither is the page title; biggest serif is a section header, no anchor naming the tenant. | Center column headers; absent page title | Add one display-serif page title with the tenant name; downgrade both section headers to Headline/Title. |
| **P3** | hierarchy | Right column stacks two near-identical bordered cards ("Μίσθωση" + "Ενοικίαση"), same width/radius/header. Reads as template filler. | Right column | Differentiate or consolidate — give the money summary more emphasis or merge lease + rent into one sectioned card with a hairline divider. |

---

## 4. buildings-list — verdict: AWFUL · looksAIGenerated: YES

The owner's "awful" verdict. But adversarial verification was brutal: both P0s (side-stripe rainbow, identical-card-grid) were confirmed-but-downgraded to P2, the cobalt-avatar P1 was not-a-defect, and the rest of the P1s landed at P2. So despite the worst verdict, no P0/P1 survives — it's a pile of consistent P2s that collectively make the surface look generated.

| Sev | Category | What | Where | Fix |
|---|---|---|---|---|
| **P2** | banned-pattern (was P0) | Every card has a thick colored left side-stripe (`border-l-4` + cycling `ACCENT_COLORS` of raw blue/violet/rose/cyan-500). Side-stripe borders >1px are absolutely banned; the rainbow is just `index%8`, off-palette, meaningless. | `BuildingListItem.js` L17-26 + L68 | Delete `ACCENT_COLORS`; remove `border-l-4` + `accent`. The Card's 1px stone-line is the only border. |
| **P2** | banned-pattern (was P0) | Identical-card grid — 5 visually identical cards (avatar + name + code + address + amber box + footer). DESIGN.md bans identical-card-grids. No anchor; reads as an AI card wall. | `BuildingList.js` L9 grid | Replace with a ruled ledger table: name+code, address, managed/total units (mono right-aligned), status pill. Drop avatar + warning box. |
| **P2** | greek-wording (was P1) | Spelling error: "Ελλειπή στοιχεία" — correct is "Ελλιπή στοιχεία" (single λ, ι not ει). Hardcoded wrong in locale, appears on nearly every card. | `el/common.json` L519 | Change to "Ελλιπή στοιχεία". |
| **P2** | color (was P1) | Warning callout uses raw Tailwind amber (`bg-amber-50 text-amber-700 border-amber-200`); palette has no amber — warnings use oxide on oxide-tint. | `BuildingListItem.js` L105 | Switch to `bg-oxide-tint`, `text-oxide`, oxide border; use the Pills warning glyph. |
| **P2** | typography (was P1) | Unit counts (11/11, 1/1, 5/5…) in proportional Inter, not tabular mono; figures don't align down the column. | `BuildingListItem.js` L116-124 | Render managed/total counts in the mono tabular numeric role, right-aligned. |
| **P2** | other | Redundant count badge: footer says "11 διαχειριζόμενα από 11 μονάδες" then a pill repeats "11 μονάδες", which wraps to two lines. | `BuildingListItem.js` L116-124 | Remove the duplicate Badge; show the count once, e.g. "Διαχειριζόμενες: 11 / 11" in mono. |
| **P2** | greek-wording | Singular mismatch: "1 διαχειριζόμενα από 1 μονάδα" — plural participle on a count of 1. No Greek plural form for the participle. | `BuildingListItem.js` L117-120 | Add singular/plural handling or use count-agnostic "Διαχειριζόμενες μονάδες: 1 / 1". |
| **P2** | color | Drop shadow under cards (banned Flat-Card rule). Base Card is flat, so a wrapper introduces it. | List/ResourceList wrapper | Find and remove the `shadow-sm`/shadow; depth from cream→bone step + 1px stone-line only. |
| **P3** | typography | ATAK codes "(008495)" etc. in proportional Inter; DESIGN.md lists ATAK numbers as the mono numeric role. | `BuildingListItem.js` L81-85 | Render the code in mono, or drop the parens code from the list view. |
| **P3** | spacing | Full-width amber box dominates each card so a directory of healthy buildings looks like a wall of errors; weak/inverted hierarchy. | `BuildingListItem.js` L101-112 | Demote the missing-data signal to a compact inline pill/icon next to the name. |

---

## 5. xreoseis-expenses — verdict: POOR · looksAIGenerated: YES

All three P1s confirmed-but-downgraded to P2 (id leak, identical-stack wall, truncated calc line). No P0/P1 survives; the cluster is what makes it read as machine output.

| Sev | Category | What | Where | Fix |
|---|---|---|---|---|
| **P2** | truncation (was P1) | Raw db id leaks: "Κοινόχρηστο Νερό (d6aa8660a511asdas)" in left panel + ΕΝΟΙΚΙΑΣΤΕΣ + ΙΔΙΟΚΤΗΤΕΣ rows. Same `_looksLikeId()` hex-only regex fails on the 's' chars. | `BuildingExpensePanel.js` ~L629-635; `ExpenseList.js` L1022 | Broaden the id heuristic (space-free `/^[0-9a-z]{10,}$/i`); apply the same fix to the Όνομα cell in ExpenseList. |
| **P2** | cramping (was P1) | ΧΡΕΩΣΕΙΣ breakdown is a wall of ~13 near-identical rows (same tenant ΔΟΚΙΜΕΖΟΥ ΒΗΤΑ, same expense, mostly 4,86 €). Monotonous identical-stack anti-pattern. | `BuildingExpensePanel.js` L815-853 | Group by recipient: tenant name once as a section header, units beneath, or collapse to "ΔΟΚΙΜΕΖΟΥ ΒΗΤΑ — 13 units, … σύνολο 63,18 €" with expand. |
| **P2** | truncation (was P1) | Calc-basis grey sub-line clipped into the amount column — "…× 2,45 …" cut mid-formula; panel too narrow (`lg:grid-cols-2` half width) for the content. | `BuildingExpensePanel.js` L834-851 | Give the breakdown its own full-width row below the calendar, or wrap the calc line, or move to a tooltip. Amount must not collide with label. |
| **P2** | hierarchy | Three unaligned money columns at three sizes (left total semibold, left rows mono body, right ΧΡΕΩΣΕΙΣ amounts elsewhere). Violates "one aligned column at one size". | Left header total vs rows vs right breakdown | Right-align all money in one mono column width + one body size; reserve larger weight for the single month total. |
| **P2** | color | "Επαναλαμβανόμενη" badges use `variant='default'` (solid ink bg) — loud primary chip for a routine yes/no status. | `ExpenseList.js` L1058-1066 | Use `variant='neutral'`/`'pending'` for "Ναι", `'archived'`/`'secondary'` for "Όχι"; pair with a glyph. |
| **P2** | other | Variable (κυμαινόμενο) expense shows a bare "—" in Ποσό — reads as missing/broken, meaning split across two columns. | `ExpenseList.js` L1032-1034 | Show "μηνιαία καταχώριση"/"κυμαινόμενο" as an ink-muted label in the Ποσό cell instead of an em-dash. |
| **P2** | mockup-divergence | "Κοινόχρηστο Νερό" appears at 0,21 € in BOTH ΕΝΟΙΚΙΑΣΤΕΣ and ΙΔΙΟΚΤΗΤΕΣ (and twice in the left panel). Looks like a double-count. | `BuildingExpensePanel.js` L862-935 + L556-581 | Make the renter-vs-owner distinction explicit (e.g. "κενή μονάδα → ιδιοκτήτης" suffix) or visually tie the two entries. |
| **P3** | spacing | Left-panel entry rows tight (`py-0.5`); variable Input + € + save-icon cramped; read-only rows at a different weight. | `BuildingExpensePanel.js` L217-256 | Increase to `py-1.5`/`py-2`; align read-only amount column with the input's right edge. |

---

## 6. owners-list — verdict: POOR · looksAIGenerated: YES

One P1 survived (unaligned money column). The identical-card-grid and em-dash-for-zero were downgraded to P2.

| Sev | Category | What | Where | Fix |
|---|---|---|---|---|
| **P1** | alignment | paid/total figures don't share one aligned column. Kappa/Lamda render "— / 35,00 €" inline at the card's right edge; Beta wraps the same datum onto two lines because the long label forces a break. Same datum, three shapes. | `OwnerListItem.js` L84-93 | Give the value its own fixed right-aligned `whitespace-nowrap` column; same paid/total format on every card so the eye scans one column. |
| **P2** | banned-pattern | Identical-card-grid of 4 owner cards; worse because frames are identical but interiors ragged — Georgios has no progress block, leaving a dead vertical gap with a pill floating mid-card. | OwnerList grid / OwnerListItem | Replace with a paper list (rows + 1px dividers): name+ΑΦΜ left, units/buildings middle, one right-aligned money column, state pill far right. |
| **P2** | typography | Paid value shows "—" for zero: "Πληρωμένα έξοδα ιδιοκτήτη — / 35,00 €" — the dash collides with " / " and is ambiguous. `NumberFormat` returns "—" for 0 without `showZero`. | `OwnerListItem.js` L87 | Pass `showZero` so zero-paid shows "0,00 €"; reserve "—" for genuinely-absent data. |
| **P2** | color | Progress bar uses shadcn `bg-primary` (ink) fill — Beta's 100% card is a solid near-black slab, heavier than anything else; not the sea-accent that progress should use. | `ui/progress.jsx` via `OwnerListItem.js` L94 | Recolor to sea accent (olive when settled) at restrained weight; better, drop the bar and show figure + pill. |
| **P2** | greek-wording | "Πληρωμένα έξοδα ιδιοκτήτη" inline reads like machine output; genitive "ιδιοκτήτη" redundant on an owners screen; combined with the dash → broken "… — / 35,00 €". | `OwnerListItem.js` L85, L112 | Shorten to "Πληρωμένα"/"Εξοφλημένα" as a column header; "Πληρωμένα: 0,00 € από 35,00 €"; pill → "Χωρίς έξοδα". |
| **P2** | cramping | Beta card: long label wraps two lines AND value "0,21 € / 0,21 €" wraps two lines — a 21-cent datum eats four wrapped lines, looks broken. | `OwnerListItem.js` L84-96 | Stack label above value (right-aligned), or widen value column + nowrap. |
| **P3** | hierarchy | Georgios (no-expense) card has a large empty band between units line and a mid-card pill because the progress block is omitted but card height is dictated by siblings. Reads as loading/broken. | `OwnerListItem.js` CardContent/Footer | Collapse the card to natural height for no-expense owners, or surface a quiet "Δεν υπάρχουν έξοδα ιδιοκτήτη" line. |

---

## 7. accounting-owners — verdict: POOR · looksAIGenerated: NO

Carries the one true **P0** in the whole catalogue — Spanish month names on a Greek screen — plus an empty-grid skeleton and missing column headers.

| Sev | Category | What | Where | Fix |
|---|---|---|---|---|
| **P0** | greek-wording | Every month label renders in SPANISH (Enero, Febrero, Marzo…) on an el-GR screen. Root cause: `OwnerStatements.js:13` captures `moment.localeData().months()` at MODULE-EVAL time, before `_app.js:64` sets the locale; `_app.js:2-6` imports locales fr,pt,de,el,**es** so the last import leaves Spanish active and the array freezes Spanish. Category-1 i18n failure. | Statement grid month column; `OwnerStatements.js:13/18`; `_app.js:2-6` | Compute months inside the component at render time (`moment().month(i).format('MMMM')`) after locale is set. Apply the identical fix to `TenantSettlements.js:13/27`. Ensure `moment.locale('el')` is set before first render. |
| **P1** | hierarchy | Entire money grid empty — all 12 month rows blank, producing a ~900px striped skeleton that reads as broken/half-loaded. | Καταβολές card, all month rows | When an owner has no settlements for the year, collapse to one ink-muted line ("Καμία καταβολή για το 2026"); render the month grid only when payment data exists. |
| **P2** | other | Grid has no column headers — month/payments/notes columns unlabeled, so the empty middle/right columns are unintelligible. | Row above Ιανουάριος | Add a Label-type, ink-muted header row with stone-line bottom rule: Μήνας · Καταβολές · Σημειώσεις (money right-aligned). |
| **P2** | color | Empty grid is two-tone for no reason — `bg-muted` fill on the empty payments column paints a solid grey vertical band down the card center. | Middle column of every row | Drop the `bg-muted` fill on empty payment cells; convey "no payment" via the empty-state line. |
| **P2** | typography | Money uses `text-lg` plain font via NumberFormat, not a dedicated tabular-mono treatment; el-GR `1.234,56 €` format + alignment unverifiable because the grid is empty. | `OwnerStatements.js:132` | On a populated owner, verify NumberFormat renders `1.234,56 €` in mono tabular-nums, right-aligned, consistent size. |
| **P3** | other | Download-statement button uses a paperclip (LuPaperclip); paperclip means "attachment", not "download/generate statement". | Owner header, "Εκκαθαριστικό" button; `OwnerStatements.js:45` | Swap to a download/document glyph; reserve the paperclip for genuine attachments. |

---

## 8. tenants-list — verdict: POOR · looksAIGenerated: YES

The lease-pill-contradiction P1 was not-a-defect. The identical-card-grid, missing title, and "ΑΘΗΝΑ GR" leak all downgraded to P2.

| Sev | Category | What | Where | Fix |
|---|---|---|---|---|
| **P2** | banned-pattern (was P1) | 3-column grid of 6 visually identical cards (same avatar, "Μίσθωση N μηνών", green bar, address, footer pill). A tenant list is a ledger; this is a generic SaaS dashboard. | `TenantList.js` L9 grid | Replace with a ruled table: Tenant (avatar+name), contract/duration, property, status pill. Kill the per-card progress bar. |
| **P2** | hierarchy (was P1) | No page title on screen — the only large top text is the dev banner "Λειτουργία ανάπτυξης". No "where am I?" anchor. | `pages/[organization]/tenants/index.js` | Add a display-serif "Ενοικιαστές" title (Source Serif 4, ~1.75rem) at the top of the List header. |
| **P2** | greek-wording (was P1) | First card address reads "ΑΘΗΝΑ GR" — raw ISO country code; other cards say "ΑΘΗΝΑ Ελλάδα". Inconsistent + machine output. | `TenantPropertyList.js` L23-27 | Map country codes to localized names ("GR" → "Ελλάδα") or strip the country line; never print bare ISO codes in el-GR. |
| **P2** | color | Three non-palette warning treatments on one screen: amber badges, amber-50/200 box, oxide pill. DESIGN.md defines exactly ONE warning color (oxide). | `TenantListItem.js` L210; `TenantPropertyList.js` L46 vs L241 | Replace all amber-* with oxide tokens so every warning uses one earned color. |
| **P2** | color | Each card has an unlabeled green (`bg-success`) progress bar encoding lease-time-elapsed — green is reserved for paid/resolved, spent as decoration even on setup-incomplete cards. | `TenantListItem.js` L170-176 | Drop the bar from the list (move to detail), or render neutral (stone/ink-muted) with no color meaning. |
| **P2** | typography | Long company/ref names ("DashTest2-178093431761…") run as proportional sans and clip at the card edge; no mono for embedded ΑΦΜ/identifier. | `TenantListItem.js` L145-151 | Truncate long names with ellipsis (`truncate min-w-0`); render embedded ΑΦΜ/identifier in mono. |
| **P3** | cramping | Uneven card heights; five horizontal divisions inside one ~300px card (contract / date / bar / address / hairline / missing-fields strip / pill) — airy-yet-cluttered, two stacked hairlines. | `TenantListItem.js` L163-276 | Merge the missing-fields strip and status pill into one footer row (no double hairline); tighten spacing; standardize card height. |

---

## 9. accounting-tenants — verdict: POOR · looksAIGenerated: YES

All three P1s confirmed-but-downgraded to P2 (no display serif, inverted size hierarchy, monotonous zero stack). No P0/P1 survives.

| Sev | Category | What | Where | Fix |
|---|---|---|---|---|
| **P2** | typography (was P1) | No display serif anywhere — `tailwind.config.js` aliases `display`/`font-display`/`font-headline` to `var(--font-sans)` (Manrope), so every token is one rounded sans. No typographic hierarchy or anchor. | `globals.css` L209-217 + `tailwind.config.js` | Wire Source Serif 4 as a real `font-display`/`font-headline`; apply to the page title only. At minimum restore a serif page-level title. |
| **P2** | hierarchy (was P1) | Inverted size hierarchy: deposit value is `text-2xl` (24px), tenant name only `text-xl` (20px). The loudest thing in each row is a zero-euro deposit, not the person. | `IncomingTenants.js` L35 vs L64 | Make the name dominant (≥ figure size); demote deposit to body/numeric size. |
| **P2** | other (was P1) | Five rows all show identical loud "0,00 €" deposits at 24px — monotonous zeros as the biggest thing on screen; reads as un-seeded demo data. | Deposit column, all rows | Render "0,00 €" deposits muted (ink-muted, body size) or collapse to an em-dash; reserve emphasis for figures requiring action. |
| **P2** | spacing | Top search card is a tall near-empty box: only "Αναζήτηση" placeholder + a large "2026" + stacked chevrons, with a dead band across the middle; nothing shares a baseline. | `[year].js` TopBar L43-54 | Tighten to one row: search left, year + chevrons grouped on one baseline right; remove excess vertical padding. |
| **P2** | greek-wording | Tab labels mix case: nominative plural ("Εισερχόμενοι ενοικιαστές") vs genitive ("Εκκαθαριστικά ενοικιαστών"); reads as separate translation strings; labels overflow and scroll. | `[year].js` TabsList L229-243 | Harmonize to one voice (all noun-led) and/or shorten so all four fit without horizontal scroll. |
| **P3** | typography | Card title forced to `text-lg md:text-xl`, overriding the `text-title` token; no distinct heading identity vs the rows. | `IncomingTenants.js` L18 | Drop the size override; use the design's Title/Headline token. |

---

## 10. rents — verdict: AWFUL · looksAIGenerated: NO

The headline P0 (route 404s) did NOT survive verification — it was a capture artifact, not a structural defect (not-a-defect). What remains is the English/unstyled 404 page, both downgraded to P2.

| Sev | Category | What | Where | Fix |
|---|---|---|---|---|
| **P2** | greek-wording (was P1) | The 404 page is stock Next.js English ("This page could not be found.") on an el-GR app — reads as broken/unfinished. | Content area 404 text | Provide a localized branded `src/pages/404.js` in Greek ("Η σελίδα δεν βρέθηκε") with a link back to Επισκόπηση/Ενοίκια; competent-neighbor tone, no exclamation, no em dashes. |
| **P2** | typography | The 404 uses the Next.js default system font + thin hairline divider — none of the design tokens (Source Serif 4, Inter, tinted-neutral). Indistinguishable from any unstyled Next.js app. | Content area 404 block | Style the custom 404 with design tokens: display serif headline, Inter body, ink/ink-muted on cream, secondary button back to a working route. |

---

# PRIORITIZED FIX LIST (all surfaces, P0s first)

### P0 — ship immediately (1)
1. **accounting-owners — Spanish month names on a Greek screen.** `OwnerStatements.js:13` (+ `TenantSettlements.js:13/27`) captures `moment.localeData().months()` at module-eval, before locale is set; `_app.js:2-6` import order leaves `es` active. Compute months per-row at render time after `moment.locale('el')`. This is a category-1 i18n correctness failure visible on a financial statement.

### P1 — next (5)
2. **building-overview — ΜΗ ΕΙΣΠΡΑΧΘΕΝΤΑ bar contradicts itself.** Feed `uncollected.paidTotal` (not `outstanding`) as the first BarRow number so header, fill, and foot agree. (Money-trust bug.)
3. **building-overview — floor table missing the "Σύνολο" totals row.** Add the bold top-ruled totals row (total m² + total rent) per the mockup.
4. **tenant-detail — "Σύνολο" total has no hierarchy.** Promote the total (Title-weight label + larger mono amount below the hairline); demote line items.
5. **tenant-detail — nested card ("Επαφή #1" inside "Στοιχεία επικοινωνίας").** Remove the inner card; use a section heading + hairline divider. (Banned pattern.)
6. **owners-list — paid/total money not in one aligned column.** Give the value a fixed right-aligned nowrap column with one consistent format across all cards.

### P2 — batch by theme (recurring root causes worth fixing once)
- **`_looksLikeId()` hex-only regex leaks ids** — appears on **property-detail** AND **xreoseis-expenses** (and `ExpenseList.js`). One fix (broaden to space-free `/^[0-9a-z]{10,}$/i`) clears both surfaces.
- **Raw Tailwind amber for warnings** — **buildings-list** and **tenants-list**. Replace every `amber-*` with oxide tokens app-wide; fix locale "Ελλειπή" → "Ελλιπή".
- **Identical-card-grids → ledger tables** — **buildings-list**, **tenants-list**, **owners-list**. Convert all three list views to ruled tables; drop per-card avatars, progress bars, and warning boxes.
- **Missing display-serif page title / no anchor** — **tenants-list**, **accounting-tenants**, **property-detail**, **tenant-detail**. Wire Source Serif 4 as a real `font-display` (currently aliased to Manrope in `tailwind.config.js`) and add one serif page title per surface.
- **Money columns unaligned / wrong size** — **building-overview**, **xreoseis-expenses**, **property-detail**, **owners-list**, **accounting-owners**. Right-align all money in one mono tabular column at one size; reserve weight for the single total; put disclosure chevrons in a separate gutter.
- **Em-dash "—" misused as a value** — `showZero` for legitimate 0,00 € (**owners-list**, **property-detail**, **accounting-tenants**); explicit label for variable/unknown (**xreoseis-expenses**); olive reserved for paid/resolved only (**building-overview** income, **tenants-list**/**owners-list** progress bars).
- **Dead chrome / off-palette decoration** — single-tab Tabs wrapper + sea-blue icon overload (**property-detail**); toolbar soup with no destructive styling (**tenant-detail**); side-stripe rainbow + drop shadow (**buildings-list**); solid-ink/`bg-muted` washes (**owners-list**, **accounting-owners**).
- **Em dashes in copy** (**building-overview**), **single-tab dead chrome** (**property-detail**), **monotonous identical-stack rows** (**xreoseis-expenses**), **missing column headers + grey-band empty grid** (**accounting-owners**), **English/unstyled 404** (**rents**), **search-card empty box** (**accounting-tenants**).

### P3 — polish
ATAK/code mono treatment and singular-plural Greek (**buildings-list**); repeated owner-name stutter (**building-overview**); two-clone metadata cards (**tenant-detail**); tight entry rows (**xreoseis-expenses**); no-expense card dead gap (**owners-list**); paperclip icon for download (**accounting-owners**); over-divided tenant cards (**tenants-list**); card-title size override (**accounting-tenants**); junk seed-data tenant card + bare "—" price (**property-detail**).

**Bottom line:** exactly one true P0 (Spanish months), five P1s concentrated in **building-overview** and **tenant-detail**, and a long P2 tail dominated by four cross-surface root causes — the `_looksLikeId` regex, raw amber warnings, identical-card-grids, and the never-wired display serif. Fix those four once and roughly half the catalogue closes. The two "awful"-verdict surfaces (buildings-list, rents) ironically carry no surviving P0/P1 after verification — they look awful from accumulated P2s and a capture artifact, not from a single critical break.
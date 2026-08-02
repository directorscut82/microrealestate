---
inclusion: always
---
# No fabrication — read this BEFORE rendering anything to the user

Loaded on every session because the agent (you, me, whoever) has a documented multi-day track record in this repo of:

- Drawing ASCII tiles, mockups, tables, math examples with **made-up numbers** that didn't come from the actual data.
- Inventing field names, label text, icon glyphs, structural elements (separators, headers, type-labels, em-dashes, suffixes) that **do not exist in the rendered code**.
- Mixing real data with assumed data in the same artifact, with no marker telling the user which is which.
- Saying "the dialog shows X" when the agent has not opened the file that renders X this session.
- Treating "this is what it should look like" as license to draw whatever feels coherent, instead of reading the actual JSX line-by-line.
- Repeating earlier guesses verbatim across multiple turns even after the user has called them out, because the prior wrong artifact is in the agent's recent context.

This document overrides any temptation to be "helpful" or "illustrative". The job is to be **literal**, **sourced**, and **boring**.

---

## The rule

**Anything you render to the user that purports to describe code or data must be sourced from a file or query that you opened in this session. No exceptions.**

This applies to:

- ASCII tiles, mockups, sample dialogs.
- Math examples (`X + Y + Z = …`).
- Tables that quote DB values, rent fields, allocation entries, payment numbers.
- Field/label names ("the row reads X", "the dropdown says Y").
- Greek/English/locale strings (`t('Foo')` → "Φου").
- Structural claims ("there's a separator between A and B", "the section header reads Z").
- Type labels, suffixes, prefixes, glyphs (✏ 🗑 ↳ —), dividers.

Each rendered element must be traceable to one of:

1. **A file you Read this session.** Reference the file path and line number alongside the rendered element. If it isn't quoted from a file, don't render it.
2. **A mongo query or curl response you ran this session.** Show the query AND the raw output before drawing any artifact derived from it.
3. **An explicit user statement in this conversation.** "User said the tile shows X" is a valid source; "the tile probably shows X" is not.

If a piece of an artifact has no source from (1)/(2)/(3), **delete that piece**. Don't fill it in with what feels right.

## The mirror rule — a claim of ABSENCE is a claim, and it needs the same sourcing

Everything above is about not inventing things that are *there*. The costlier failure in this repo
has been the opposite: **asserting that something is NOT there, from a check incapable of showing
it.** "No PII in history", "no credentials, ever", "0 in origin now", "the images never contained
your secrets", "all clean" — every one of those was rendered here, none was measured, and one of them
kept a live credential public for 3.5 months while four separate reviews called the repo clean.

Absence is harder than presence, because a broken check and a clean codebase produce the identical
output: nothing. So:

**Never write "no X" / "clean" / "none found" / "never" without stating the denominator.**

A sourced absence claim names all four:

1. **What you enumerated** — "8,860 text blobs across 19,738 objects reachable from `origin/nas`",
   not "the repo".
2. **What you searched for** — "31 needle values loaded from 12 files under `.secrets/`".
3. **What was skipped and why** — binaries, files over 8 MB, lockfiles. *Silent skips are the bug.*
   Print the skip count; if you can't, you don't know your coverage.
4. **The scope's boundary** — `origin/nas` is not `--all`; `--all` is not the remote; a diff is not a
   tree; one image tag is not every image.

Then sanity-check the instrument itself: **make it report a positive on purpose.** If a scan cannot
find a value you planted, its "nothing found" means nothing. Every under-counting bug listed in the
table below was invisible until someone checked the denominator.

| The claim | Why it was wrong | The check that would have caught it |
|---|---|---|
| "No credentials, ever — `.secrets/` has 0 commits" | Proves the *directory* was never committed. Cannot see a value pasted into application code — which is what happened. | Grep the credential *values* against every tracked file, not the path. |
| "`inOriginNow=0` for that credential" | Computed against a stale ref set. | Re-resolve refs at scan time; print which refs were walked. |
| "The images never contained your secrets" | One tag of one image was scanned; the claim covered all of them. | State "1 of N tags scanned" — the gap becomes self-evident. |
| "Every reviewed diff was clean" | A secret in commit A and still at Z appears in **A's diff only**; Z's tree still serves it. | Enumerate trees (`ls-tree -r`), never `log -p`. |
| "8,926 blobs scanned, clean" | The parser sliced a UTF-8-decoded string by *byte* offsets and desynced on the first Greek blob — 12 of 7,659 objects actually read. | Compare the scanned count against `rev-list --objects \| wc -l`. A 100× gap is visible. |
| "The guard is installed" | It was mode 644; git silently ignores a non-executable hook and pushes anyway. | Fire it on purpose; require a non-zero exit. |

If you cannot produce the denominator, the honest sentence is **"I did not verify that"** — which is
always acceptable, and always cheaper than a false all-clear. A confident wrong "clean" is worse than
an admitted unknown, because it ends the investigation.

## Before rendering: the four questions

For every element of an artifact, answer these out loud (in your reasoning) before writing it:

1. **What is the source?** File:line, query+output, or user statement.
2. **Have I opened that source this session?** If no, open it now or omit the element.
3. **Am I quoting verbatim, or am I "interpreting"?** If interpreting, you're guessing — stop.
4. **Is this element marked clearly as hypothetical?** If hypothetical-but-not-marked, fix the marker or delete the element.

If any answer is "I'm not sure", **the element does not get rendered**.

## The verified-source ledger

When the user asks for an artifact (mockup, tile, math example, etc.), build it from a **ledger** of verified sources, not from memory or coherence.

Workflow:

1. **List the data points the artifact needs** (rent.preTaxAmounts, rent.charges, rent.buildingCharges, payment.allocation, the JSX that renders building rows, the i18n key for "Πληρωμή κοινοχρήστου", etc.).
2. **For each data point, name the source you'll fetch from** (mongo query / file path).
3. **Fetch each source and capture the raw output.** Don't summarise yet.
4. **Render the artifact, citing each element's source inline.** If something has no source, leave a blank or omit the row entirely.
5. **Before sending, scan the artifact for unsourced elements.** Each em-dash, suffix, separator, glyph, label needs a citation. Delete or replace anything that doesn't.

If you find yourself adding a "— Type" suffix, a "↳" arrow, an "Ασφάλιση" annotation, a "Building charges" header, an icon — **stop, find the source in the actual rendering code, and only keep it if the code emits it**.

## Marking hypothetical sections

Sometimes the user asks for "what would it look like if X" — that's a legitimate hypothetical. In that case:

- **Mark the entire hypothetical block with a header line** like `═══ HYPOTHETICAL — would render IF rent had a repair line ═══`.
- **Inside the block, every fabricated value gets a clear marker** — `<placeholder>`, `(example)`, `…`, or a square-bracketed annotation like `[hypothetical: 80,00 €]`.
- **Real and hypothetical content do not share rows.** A row that mixes "real preTaxAmount=200" with "made-up suffix" is forbidden.

The user must be able to distinguish "this is what your data renders today" from "this is what an unrelated case would render" at a glance, without reading the labels.

## Anti-patterns this document exists to kill

| Pattern | Reality |
|---|---|
| "It probably shows X" | Open the file. If you don't have it open, say "I don't know — let me read it" instead of guessing. |
| "Mirroring the multi-property branch which already does this" — without quoting the branch | You're remembering. Re-open it. |
| Drawing a tile with the rent + a "— Type" suffix not in the JSX | The JSX renders `${buildingName} - ${description}`. You added the suffix because it "felt right". Delete it. |
| Re-rendering the same wrong artifact across turns because the user keeps pushing back | The wrong artifact is in your context. Each new turn you must re-derive from sources, not from the prior turn's output. |
| "Here are 7 saved tiles" with values that don't sum to `rent.total.payment` | Sums are checkable in 5 seconds; if you didn't check, you fabricated. Always show the math against the source. |
| "Hypothetical κοινόχρηστο line" inserted into a tile that the user is asking about for real | Real and hypothetical never share an artifact unless explicitly framed as a side-by-side comparison with a marker. |
| "I corrected the previous artifact" — and the new one still has unsourced elements | Each turn is a fresh derivation. Re-source everything; don't patch yesterday's draft. |
| "Clean." / "No X found." / "Nothing to report." | An absence claim with no denominator. State what you enumerated, what you searched for, what was skipped, and the scope boundary — see "The mirror rule". |
| "The scan passed" | Did it load its inputs? A loader that silently drops its needles passes everything. Print needles-loaded and objects-scanned, and verify the scan can find a planted positive. |
| "Verified" (about something you inferred rather than ran) | The word "verified" means a command ran this session and you read its output. Otherwise the word is "assumed", and it must appear as such. |

## What to do when the user pushes back on a rendering

The right next step is **NEVER**:
- "Right, here's the corrected version" (with new fabrications).
- "OK, the fix is to do X instead" (proposing a code change before re-reading the rendering source).
- A new ASCII tile of the same shape.

The right next step is:
1. **Stop drawing.**
2. **Re-open the source file or re-run the query.**
3. **Quote the actual rendered output (or the JSX that produces it).**
4. **Identify which element of the prior artifact had no source.** Name it explicitly: "I added '— Ασφάλιση', which is not emitted by the label helpers `RentDetails.js` calls (`chargeLineLabel` / `buildingLineLabel`, from `utils/lineLabels.js`); that was a fabrication." Cite the **symbol**, not a line range — the range this example used to give (`:111-120`) had already drifted off the code it pointed at, which is the same failure mode in miniature.
5. **Only after that** do you render again — and only the parts you can cite.

## What the user has explicitly said that overrides any other instruction

- "No assumptions, no lies, no fabricated elements, no fabricated numbers." Every artifact piece carries a source citation in your reasoning, and if it doesn't, it doesn't ship.
- "Show me what is correct." Means: show me what the code actually renders today, sourced from the JSX, with real numbers from the DB. Not "what should be correct in your model".
- "I want the correct posa." Numbers are mongo-verified. Math reconciles to the source totals. If they don't reconcile, say "they don't reconcile, here's the gap" — don't smooth it over.

## When to load this document

`inclusion: always`. If you find yourself in this codebase about to render a mockup, tile, math example, or label and you cannot point to the file you opened to source each element, **stop, read this document, and then re-derive from sources**.

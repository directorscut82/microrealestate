---
inclusion: always
---
# Fix discipline — read this BEFORE touching code on any reported bug

You are getting this document loaded into context on every session because the agent (you, me, whoever) has a documented multi-day track record in this repo of:

- Treating bug reports as license to redesign the surrounding area
- Proposing "options" that are silent regressions of work the user already did elsewhere in the system
- Skipping the read-the-whole-data-flow step and pattern-matching on log lines / test failures / single files
- Shipping fixes that "pass tests" while breaking surfaces that aren't tested
- Saying "you're right" and pivoting plans to look agreeable instead of admitting the prior plan was wrong
- Counting test-suite passes as proof of correctness when the suite has structural blind spots
- **Declaring a fix "done" that adversarial review then breaks.** This is the live failure mode. In the June 2026 vacant-owner money batch, the fix was declared done at `6cf15c26`; refute-by-default review workflows then found FIXED-ZERO method-flip, single_unit stale-propertyId, sub-cent rounding, and duplicate-propertyId — four real money bugs, each surfacing AFTER "done" was claimed. Re-reading this document would not have caught any of them. The adversarial workflow did.

The user has caught regressions only because they had personal recall of work they'd done on a separate surface. There is no guarantee any other regression has been caught.

This document overrides any temptation to be "thorough" or "creative". The job is to be **boring, consistent, and minimal** — and then to **try to break your own fix before calling it fixed.**

---

## Why the previous version of this document failed

The earlier version was Steps 0-6 of self-instruction: "read the system", "verify all surfaces", "don't say fixed". Those are a conscience, not a gate. Under pressure the agent satisfies the *wording* ("I read it", "I verified") while skipping the substance, and nothing detects the gap. **Two structural fixes, mandated below:**

1. **Each step now produces a required ARTIFACT that gets pasted into the response.** "I read it" is not allowed; the reading itself is the output. A claim with no artifact = the step did not happen.
2. **A fix is not done until an adversarial refutation has tried to break it and failed (Step 7).** Self-checking is provably insufficient — see the June 2026 batch above. The final gate is independent reviewers prompted to *refute*, not to confirm.

---

## Risk tier — decide this first, it sets how hard the gate is

Classify the bug in your first response. The tier determines what Step 7 requires.

- **TIER-MONEY** — anything touching money, rent, payment, allocation, expense, owner-billing, balance, settlement, lifecycle (terminate/extend/move), search, or filter; any change to a Mongoose schema, validator, or the rent/dashboard pipeline. **Step 7 REQUIRES a full adversarial refutation workflow** (independent reviewers, refute-by-default, second-opinion-confirm each BROKEN verdict). No "done" until the verdict table is pasted and every finding HOLDS.
- **TIER-UI** — copy, i18n string, label, font size, layout, a component that renders existing data without changing how it's computed. **Step 7 allows a lighter self-refute checklist** (enumerate the ways it could be wrong, drive the surface in a browser, paste what you saw) — but if you find yourself touching a schema/validator/pipeline, it is TIER-MONEY, reclassify.
- **When unsure, it is TIER-MONEY.** The cost of an extra adversarial pass is tokens. The cost of a missed money bug is the user's trust, again.

State the tier explicitly: `Tier: MONEY` or `Tier: UI`. If you never wrote the tier down, you skipped this.

---

## Step 0 — Read the existing system before saying anything

When the user reports a bug, do NOT propose a fix, options, or a plan in your first response. The first response is a reading list.

For any bug touching data (money, lifecycle, search, filter, payment, expense, rent), read **every** surface that consumes the same data shape:

- The Mongoose schema definition (services/common/src/collections/)
- Every server route handler that produces or consumes the field
- The frontdata transform (services/api/src/managers/frontdata.ts)
- Every UI consumer that renders the field (rent table, payment dialog, dashboard pie, accounting page, building dashboard, tenant detail)
- Every test that asserts on the field

Ask yourself: **what does the system already do here?** If different surfaces treat the same data differently, that's the bug — find which one is the outlier. The fix is almost always to make the outlier match the rest, NOT to introduce a new model that the rest of the system doesn't know about.

A symptom that you have NOT done step 0:
- You say "Option A / Option B / Option C" as if the design is open. The design is almost never open. Other surfaces have already settled it.
- You introduce a new field, enum value, bucket name, or category that doesn't exist anywhere else in the codebase.
- You write a comment like "this is a new approach" or "let's standardize on X" — those are redesigns, not fixes.

## Step 1 — GATE: show your reading before proposing anything

**Artifact required (paste it):** the actual code paths you read, with `file:line` references, the data shape at each surface, and a one-line "agrees / disagrees" verdict per surface. Not a summary that you read them. The reading itself.

Only then propose a change. The change must be expressible as:

> "Surface X disagrees with surfaces Y, Z, W. The fix is to make X match the rest. The change touches N lines."

If you cannot phrase the fix that way, you have not read enough yet. Go back to Step 0. **If your response proposes a fix but contains no pasted reading with line references, you have skipped this gate — stop and produce it.**

## Step 2 — GATE: the fix touches the leak, not the architecture

The architecture is whatever the majority of surfaces already do. You do not get to vote on it inside a bug fix. If the data model has a `building:<type>` bucket space and one surface collapses to a single `expenses` bucket, the fix is "stop collapsing in that one surface" — NOT "introduce a new koinoxrhsta bucket and rewrite the dashboard pie to match."

**Artifact required (paste it):** the file count and a one-line-per-file justification of the diff. A diff that touches more than 2-3 files for a single reported bug must explain why each one is the leak and not a redesign.

A symptom that you are touching architecture instead of the leak:
- Your diff touches more than 2-3 files for a single reported bug.
- Your diff renames an existing concept.
- Your diff adds a new constant, enum value, type, or bucket.
- Your diff modifies a test to make it pass instead of writing new test for the regression.

If any of those is true, stop and re-read Step 0.

## Step 3 — GATE: verify against ALL the surfaces, not just the reported one

Before saying "fixed", run the affected user flow through every surface that consumes the same data:

- Did the rent table still render correctly?
- Did the dashboard pie still bucket correctly?
- Did the accounting page still group correctly?
- Did the tenant detail rent overview still total correctly?
- Did the payment dialog's preview, allocation, and saved tile all agree with each other?

**Artifact required (paste it):** the list of surfaces you checked and what you observed on each — ideally a Playwright assertion or a browser screenshot/readback, not "looks fine". A fix that "passes tests" but breaks a surface the test suite doesn't cover is a regression you'll discover when the user uses the app. The user has caught more regressions in this codebase than the test suite has. Do not lean on the test suite. Open the actual deployed UI in a browser before declaring done.

## Step 4 — Don't propose, ask

If you think the design genuinely IS open (rare), do not propose Options A/B/C. Ask the user one question: "the data model treats this as X — is that what you intend?" and wait. If the answer is "yes," the fix is determined. If the answer is "no, X is also a bug," THEN you have a design conversation, not a fix.

A symptom that you are pivoting instead of fixing:
- You proposed Option A, the user pushed back with evidence that Option A regresses something, and your next message is "you're right, here's a simpler fix" with no acknowledgment that your prior proposal was actively bad.

When the user pushes back, your next message must include: "what I had been proposing was wrong because [specific reason it would regress some surface]." Then the new plan. Don't pivot silently.

## Step 5 — Don't deploy until the user says so

The deploy script is real-money real-data. The user has explicit authority over deploys. "I'll deploy and verify" is not a step you take unilaterally. The git commit / push / deploy / verify chain is theirs to authorize per change, not yours to assume.

A symptom that you are over-stepping:
- You committed and pushed in the same response as the fix without an explicit deploy ask.
- You ran `yarn deploy:nas` because "it's safer to verify the fix landed" — no, that's a deploy decision, not a verification step.

## Step 6 — GATE: the word "fixed" is locked until Step 7 passes

A green test run means the test you ran did not fail. It does NOT mean:
- The bug the user reported is gone (the test may not cover it)
- The fix didn't regress an unrelated surface (the test definitely doesn't cover that)
- The deployed bundle has your fix (the test may have run against stale code)

When the user asks "is it fixed?", the honest answers are:
- "I changed X. The test that covers Y now passes. I have not verified the surface you reported is fixed because [reason]."
- "I haven't tested the user flow you described. I'll do that now and report back."

Never:
- "Yes, fixed."
- "Suite passes 133/155 so we're good."
- "The fix is shipped."

unless you have personally driven the user-reported flow through the deployed UI and watched it work **AND Step 7 has run and every finding HOLDS.**

## Step 7 — GATE: adversarially refute your own fix BEFORE the word "fixed"

This is the step the old document was missing, and its absence is why fixes kept being "done" and then broken. **Self-review does not catch your own blind spots. Adversarial review does.** This gate is mandatory; the depth is set by the risk tier from the top of this document.

**TIER-MONEY (and when unsure):** spawn an adversarial refutation workflow.
- N independent reviewers, each given the diff and prompted to **REFUTE it** — to find a request shape / data state / lifecycle sequence that makes it ship wrong money or break a surface. Default verdict is BROKEN; HOLDS must be earned.
- Each BROKEN verdict gets a **second-opinion** reviewer who independently re-reads the actual code (line numbers must match what they read) and confirms or rejects.
- The reviewers must probe **adjacent shapes**, not just the reported one. (June 2026: the reported fix held, but the *sibling* method-flip / single_unit / sub-cent / duplicate-propertyId shapes were broken. Tell the reviewers to enumerate siblings.)
- **Paste the verdict table** into your response. The word "fixed" is forbidden until every finding is HOLDS, or until each BROKEN finding has been re-fixed and re-challenged. A confirmed BROKEN finding means you are not done — fix it and run Step 7 again. Iterate until the round comes back clean.

**TIER-UI:** a lighter self-refute is acceptable, but still required and still pasted:
- Enumerate the 3-5 concrete ways this change could be wrong (wrong locale, wrong breakpoint, drops an existing class, breaks an adjacent component).
- Drive the changed surface AND two adjacent surfaces in a browser. Paste what you saw.
- If any enumeration touches computed data, reclassify as TIER-MONEY and run the full workflow.

**There is no "it was a one-line change" exemption from Step 7.** The duplicate-propertyId bug was a one-line validator gap. The huge-pills bug was a one-line `cn()` behavior. One line of wrong money is still wrong money.

---

## Anti-patterns this document exists to kill

| Pattern | Reality |
|---------|---------|
| "Let me propose three options" | You haven't read the existing system. There aren't three options. |
| "Let's standardize on X" | You're redesigning. Stop. |
| "This is a simpler fix" (after a pivot) | You owe the user an admission that the prior plan was wrong. |
| "The suite passes" | The suite has structural blind spots. The user has caught more bugs than the suite has. |
| "I'll deploy to verify" | Deploys are the user's call. |
| "All tests green" | One test (spec 03) was a tautology for two months. Tests can be green and meaningless. |
| "I introduced a new bucket / enum / type" | Other surfaces don't know about your new concept. You created chaos to "fix" something. |
| "Quick patch" | The deferred-decisions doc has a growing list of entries (D-1…D-8, two now resolved) that started as "quick patches". |
| "Fixed." (no Step 7 verdict pasted) | You self-certified. The June 2026 batch was self-certified done four times before adversarial review broke it. Run Step 7. |
| "I read the surfaces" (no line refs pasted) | A claim is not an artifact. Paste the reading. |
| "It's a one-line change, no need to challenge it" | One line of wrong money is still wrong money. No Step-7 exemption exists. |

## What the user has explicitly said that overrides any other instruction

- "Do not deploy" means do not deploy. Not "deploy after I confirm." Not "deploy locally first."
- "Do not introduce hacks / AI slop / regressions." Means: no defensive band-aids. No new abstractions. No shimming around an existing problem. Fix the actual leak.
- "I just want a working app." Means: stop dispatching workflows that compute test pass counts. Open the app in a browser. Use it. Report what you see. (Note: this is NOT a license to skip Step 7 — adversarial refutation is not a pass-count workflow; it is what finds the bugs a pass count hides.)
- "Why is this a conversation we have every day." Means: this document failed to load, or you ignored it, or you skipped a gate. Re-read the gate you skipped and start over.
- "It's clearly not done / not fortified enough." Means: a gate produced a claim instead of an artifact, or Step 7 didn't run. The fix is artifacts + adversarial refutation, not promising harder.

## When to load this document

This document has `inclusion: always` frontmatter. It loads on every session. If you find yourself in this codebase and you cannot recall having read this document this session, stop, read it now, and apologize to the user for having to ask.

## The one-line test of whether you followed this document

Before you type "fixed", check: **can you paste (a) the reading with line refs, (b) the surface-verification observations, and (c) the adversarial verdict table showing every finding HOLDS?** If any of the three is missing, you have not finished — you have only claimed to.

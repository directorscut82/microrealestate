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

The user has caught regressions only because they had personal recall of work they'd done on a separate surface. There is no guarantee any other regression has been caught.

This document overrides any temptation to be "thorough" or "creative". The job is to be **boring, consistent, and minimal**.

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

## Step 1 — Show your reading before proposing anything

Your first message after a bug report should be the reading. Quote the actual code paths. Show the data shapes. Identify the surfaces that agree and the surfaces that disagree.

Only then propose a change. The change should be expressible as:

> "Surface X disagrees with surfaces Y, Z, W. The fix is to make X match the rest. The change touches N lines."

If you cannot phrase the fix that way, you have not read enough yet. Go back to Step 0.

## Step 2 — The fix touches the leak, not the architecture

The architecture is whatever the majority of surfaces already do. You do not get to vote on it inside a bug fix. If the data model has a `building:<type>` bucket space and one surface collapses to a single `expenses` bucket, the fix is "stop collapsing in that one surface" — NOT "introduce a new koinoxrhsta bucket and rewrite the dashboard pie to match."

A symptom that you are touching architecture instead of the leak:
- Your diff touches more than 2-3 files for a single reported bug.
- Your diff renames an existing concept.
- Your diff adds a new constant, enum value, type, or bucket.
- Your diff modifies a test to make it pass instead of writing new test for the regression.

If any of those is true, stop and re-read Step 0.

## Step 3 — Verify against ALL the surfaces, not just the reported one

Before saying "fixed", run the affected user flow through every surface that consumes the same data:

- Did the rent table still render correctly?
- Did the dashboard pie still bucket correctly?
- Did the accounting page still group correctly?
- Did the tenant detail rent overview still total correctly?
- Did the payment dialog's preview, allocation, and saved tile all agree with each other?

A fix that "passes tests" but breaks a surface the test suite doesn't cover is a regression you'll discover when the user uses the app. The user has caught more regressions in this codebase than the test suite has. Do not lean on the test suite. Open the actual deployed UI in a browser before declaring done.

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

## Step 6 — Don't say "fixed" when you mean "test passed"

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

unless you have personally driven the user-reported flow through the deployed UI and watched it work.

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
| "Quick patch" | The deferred-decisions doc has six entries that started as "quick patches". |

## What the user has explicitly said that overrides any other instruction

- "Do not deploy" means do not deploy. Not "deploy after I confirm." Not "deploy locally first."
- "Do not introduce hacks / AI slop / regressions." Means: no defensive band-aids. No new abstractions. No shimming around an existing problem. Fix the actual leak.
- "I just want a working app." Means: stop dispatching workflows that compute test pass counts. Open the app in a browser. Use it. Report what you see.
- "Why is this a conversation we have every day." Means: this document failed to load, or you ignored it. Re-read Step 0 and start over.

## When to load this document

This document has `inclusion: always` frontmatter. It loads on every session. If you find yourself in this codebase and you cannot recall having read this document this session, stop, read it now, and apologize to the user for having to ask.

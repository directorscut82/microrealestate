# The GPU agent stack — what it is, and how to prompt every capability

Two packages, one workflow: an **orchestrator family** (Claude, 14 agents) that scopes,
researches and reviews, and a **GPT implementation hop** (`gpu-codex-coder` → Codex →
Bedrock) that writes the code behind a scope-enforcing harness.

Written 2026-08-03. Sources, all read directly — not summarised from memory:

- `code.amazon.com/packages/ClaudeCodexPowerWorkflow/trees/mainline` — README, aim.json,
  Config, hooks.json, the agent spec, all 3 context docs, and the commit log.
- `~/.aim/cc-plugins/ClaudeCodexPowerWorkflow-claude-codex-power-workflow/` (plugin
  `1.0.6488078792`) — including all 1026 lines of the harness.
- `~/.aim/cc-plugins/AIPowerUserCapabilities-multiagent/` — all 14 agent files, the
  delegation table, `ulw-rules.md`, `AGENTS.md`, and the 6 `sop-*` skills.

Claims are tagged: **MEASURED** (I ran it and read the result), **FROM SOURCE** (read in
code/docs, not executed), **UNVERIFIED** (not tested — do not trust).

> **Prompt list → [§4 THE LIST](#4-how-to-prompt-every-capability)** (29 rows, one line each).
> **Feature / bug-fix workflows → [§6a](#6a-the-two-workflows--new-feature-and-bug-fix)**.

---

## 0. Read this first — five upstream defects, all fixed

| # | Problem | Status |
|---|---|---|
| 1 | Harness hard-requires `bwrap`, which cannot exist on macOS | **Fixed** locally (stub) |
| 2 | `gpu-multiagent` cannot reach `gpu-codex-coder` — not on its allowlist | **Fixed** via local `gpu-orchestrator` |
| 3 | `gpu-coder`, `gpu-reviewer`, `gpu-writer-critic`, `gpu-cr-guide-worker` mis-namespaced — all four unreachable | **Fixed & verified**: all four now PERMITTED (were all REJECTED). Still broken in stock `gpu-multiagent` |
| 4 | The package's **own test suite cannot run** — two macOS-only bugs in its scaffolding (wrong harness path + `mktemp` suffix template) | **Fixed in place, both copies: 13 passed, 0 failed** (§5.4) |

| 5 | `gpu-multiagent-bi` declares its MCP tools as bare `mcp__andes-mcp` / `mcp__datanet-mcp` / `mcp__amazon-quick-mcp`, but they register as `mcp__plugin_AIPowerUserCapabilities-multiagent_<name>` — **every data-platform tool unavailable** | **Fixed & verified** via local `gpu-bi`: real Andes call returned 2,008 datasets (§5.5) |

**All five are fixed. If any comes back after an AIM update, run `fix-codex-plugin`** — one
idempotent command that re-applies the file patches and checks the rest. See §5.4's re-fix box.

Defects 1 and 4 share a root cause: **the package was developed and reviewed on Linux.** bwrap
exists there, and GNU `mktemp` tolerates a suffixed template. Expect any further breakage to
be of the same shape.

### ⚠️ IF ANY OF THIS BREAKS AGAIN — RUN ONE COMMAND

```bash
fix-codex-plugin            # re-apply every fix
fix-codex-plugin --verify   # ...and run the suite (expect: 13 passed, 0 failed)
```

**AIM owns the patched files.** `aim plugins update` or a reinstall **overwrites them and
silently reintroduces the bugs.** The script at `~/.local/bin/fix-codex-plugin` re-applies
them, is idempotent (safe to run any time), and reports what it changed.

MEASURED both directions: run against healthy files → `changed 0`; after restoring the
upstream original → detected it, `FIXED`, all three lines corrected, and the healthy sibling
copy left alone.

It also checks the two things it cannot patch, because they are *yours*, not AIM's — so an
update can't remove them, but a fresh machine won't have them:

| Symptom after an update | Cause | Fix |
|---|---|---|
| Suite dies with `JSONDecodeError`, or `mkstemp failed: File exists` | AIM overwrote the test suite | `fix-codex-plugin` |
| `bubblewrap (bwrap) is not installed` | stub gone from `~/.local/bin/bwrap` | recreate it — §5.1 |
| `Agent type 'gpu-codex-coder' not found` | `~/.claude/agents/gpu-orchestrator.md` gone | recreate it — §5.2/§5.3 |

If AIM ever ships a **better** `gpu-multiagent`, re-copy it to `gpu-orchestrator.md` and
re-apply the two edits: add `gpu-codex-coder` to the `Agent()` allowlist, and correct the four
mis-namespaced agents (§5.3).

All five are upstream defects, not local misconfiguration. Details in §5.

**Use `gpu-orchestrator`, not `gpu-multiagent`.** Same 674-line orchestrator, three bugs
patched, at `~/.claude/agents/gpu-orchestrator.md` (yours, not AIM-managed). And `gpu-bi`, not
`gpu-multiagent-bi`, for anything touching Andes/Datanet/QuickSight.

---

## 1. The two packages

### ClaudeCodexPowerWorkflow — small, and only about Codex

Mainline holds exactly four things:

| Thing | What it is |
|---|---|
| `gpu-codex-coder` | One subagent. A **thin forwarder**: writes your prompt to a temp file, runs the harness, returns its JSON. Tool list: `Bash`. That's all. |
| `codex-scoped-run` | The harness — 1026 lines of bash. All real behaviour lives here. |
| 3 context docs | Routing rule, Bedrock model IDs, pipeline overview. |
| 1 SessionStart hook | Warns if the codex CLI or openai-codex plugin cache is missing. Non-fatal. |

It ships **no** orchestrator. `gpu-multiagent`, `gpu-coder`, `gpu-reviewer` come from
`AIPowerUserCapabilities` (Brazil dep in `Config`, opted in via `aim.json`). The 70
agents / 285 skills under `~/.aim/packages/ClaudeCodexPowerWorkflow-1.0/eventId-*/` are the
**merged AIM payload from every installed package** — not this package's content. Easy to
misread as capability that isn't there.

### AIPowerUserCapabilities-multiagent — the orchestrator family

14 agent files: the orchestrator plus 13 specialists. Every one is pinned to
`claude-opus-4-6-v1[1m]` (my local copy uses `model: inherit` instead).

### The premise

Claude scopes and reviews, GPT implements. README's evidence: Aider polyglot GPT-5 88.0% vs
Claude Opus 4 72.0%; Terminal-bench 2.1 GPT-5.5 82.7% vs Opus 4.8 74.6%. Claude keeps
research, scoping, long-context and review. Cross-model review is the real prize — Claude
catches classes of mistake GPT makes, and vice versa. GPT runs on **Bedrock**
(`model_provider = "amazon-bedrock"`), so inference stays inside Amazon.

### `gpu-codex-coder` is deliberately crippled

From the README: no builder-mcp, no web, no research tooling **by design**, because "the
first iteration of this workflow had no restrictions and went rogue often." It is also
**git-banned** — no commit/add/reset/checkout/stash/worktree/clean/merge/rebase. Read-only
git only.

So **it cannot find its own scope.** Hand it a fully-specified task or you get nothing
useful. That constraint is the point, not a limitation.

---

## 2. The orchestrator family — 14 agents

`gpu-orchestrator` is a **dispatcher only**. Its own rules: 3 jobs (TODO lists, spawn
subagents, synthesise results), a hard **3-file read budget**, and "if you catch yourself
reading more than 3 files, STOP — you're doing someone else's job." Two standing rules worth
knowing because they shape every answer you get:

- **Zero direct answers for verifiable facts.** Anything it would need to Google — versions,
  specs, internal knowledge, any "confirm/verify" — goes to the librarian.
- **Never say "I can't."** A missing tool means delegate, not refuse.

| Agent | Use it for | Key tools |
|---|---|---|
| `gpu-multiagent-explorer` | Codebase search, file discovery, pattern matching | Grep, Glob, WorkspaceSearch, InternalCodeSearch |
| `gpu-multiagent-librarian` | External docs, internal wikis, API refs, web research, **any verifiable fact** | WebSearch, WebFetch, ReadInternalWebsites, aws-knowledge, unified_docs |
| `gpu-multiagent-advisor` | Deep reasoning, architecture decisions, **debugging after 2+ failures** | Read, Bash, Grep, InternalSearch |
| `gpu-multiagent-planner` | Work breakdown, task plans, success criteria, dependency maps | Read/Write/Edit, SkillsTool |
| `gpu-multiagent-triage` | Ambiguous requests, scope clarification, intent classification (285 lines — the most elaborate) | Read, Grep, TaskeiGetTask |
| `gpu-multiagent-frontend` | **UI/frontend source code** — React, Vue, CSS, Cloudscape | venue-mcp, playwright-proxy, Write/Edit |
| `gpu-multiagent-browser` | Browser automation, scraping, E2E, screenshots | playwright-proxy-mcp |
| `gpu-multiagent-ops` | Taskei, CRs, pipelines, SAS, Mechanic, Apollo, oncall (~40 MCP tools — the widest) | builder-mcp ops suite, pippin |
| `gpu-multiagent-comms` | Slack, Outlook mail, calendar | slack-mcp, aws-outlook-mcp |
| `gpu-multiagent-lens` | PDFs, images, diagrams — anything not readable as text | Read (+ ReadInternalWebsites) |
| `gpu-multiagent-bi` | Andes datasets/lineage, Datanet ETL, QuickSight, analytical SQL | andes-mcp, datanet-mcp, amazon-quick-mcp |
| `gpu-multiagent-writer` | **Descriptive** docs — READMEs, changelogs, API reference | unified_docs read+write |
| `gpu-multiagent-worker` | Trivial edits, file moves, installs, shell one-liners, log inspection | Write/Edit/Bash |
| `gpu-writer-critic` | **Persuasive** docs — six-pagers, proposals, design docs with open trade-offs. Mandatory devil's-advocate loop | unified_docs, pippin, Agent |
| `gpu-coder` | Substantive Claude-side code work. Produces a CR | (autonomous-coding namespace) |
| `gpu-reviewer` | Code and plan critique | (autonomous-coding namespace) |

### The routing rules that actually decide where your task lands

**coder vs worker** — first match wins:

1. UI/frontend source → `frontend` (**precedes** coder)
2. Substantive source or repo-resident change (build/runtime affecting) → `coder`
3. Hybrid code+ops → `coder`
4. Trivial single-file edit, file ops, env setup, shell → `worker`
5. Tiebreak: do you expect a CR? yes → `coder`, no → `worker`

**writer vs writer-critic** — by **intent, not genre**. If the author must recommend,
decide, evaluate trade-offs or persuade → `writer-critic`. Purely descriptive → `writer`.
A README that recommends an architecture change goes to `writer-critic`; a "design doc"
recording an already-made decision goes to `writer`. Ambiguous → `writer-critic`.

### The 6 `sop-*` skills

Explicit workflow modes, invoked as `@agent-sop:<name>`. All are
`disable-model-invocation: true` — **you must ask for them by name**; the model won't
self-trigger them.

| Skill | Does |
|---|---|
| `sop-ulw` | "Ultrawork" mode. Says "ULTRAWORK MODE ENABLED!", builds a TODO list, spawns explorer+librarian in parallel immediately. Rules live in always-on `ulw-rules.md`. |
| `sop-delegate` | Mandatory **7-section** delegation template (TASK / EXPECTED OUTCOME / REQUIRED SKILLS / …). |
| `sop-plan` | Work breakdown with success criteria, dependencies, agent assignments. |
| `sop-analyze` | Context-gathering pass before implementation on unfamiliar code. |
| `sop-search` | Maximum-effort search across codebase + external docs. |
| `sop-verify` | Verification protocol: pre-check → build → tests → evidence. |

---

## 3. The harness — where the real behaviour is

Flags below are read from the **source**, not from SKILL.md (which is wrong about bwrap).

| Flag | Required | Default | Notes |
|---|---|---|---|
| `--repo` | yes | — | Must be **inside a git work tree**. |
| `--allow` | yes, 1+ | — | Repo-relative glob, repeatable. **Read §3.2 — looser than it looks.** |
| `--prompt-file` | yes | — | There is **no `--prompt`** flag; it dies `Unknown argument: --prompt`. MEASURED. |
| `--model` | no | `openai.gpt-5.6-sol` | §3.4 |
| `--effort` | no | unset | `low\|medium\|high`. Passed straight through, **not validated**. |
| `--mode` | no | `auto` | `auto\|worktree\|inplace`. §3.1 |
| `--verify-cmd` | no | — | Post-edit shell command. Careful: containing `brazil` flips mode to inplace. |
| `--idle-timeout` | no | `600` | Seconds of *total* inactivity → stall. |
| `--max-runtime` | no | `0` | Hard wall-clock cap; 0 = unlimited. |
| `--mcp-profile` | no | `coding` | `coding` = builder-mcp only; `full` = your whole codex config. |
| `--codex-companion` | no | auto | Resolves highest version in the plugin cache. |

Env knobs: `CODEX_SKIP_REAP`, `CODEX_SKIP_BROKER_TEARDOWN`, `STALE_BROKER_MAX_AGE_SEC`
(default 5400s), `TMPDIR`. FROM SOURCE.

### 3.1 worktree vs inplace — decides where your code ends up

`auto` picks **inplace** on any of: `--verify-cmd` contains `brazil`; repo under `/src/`
with a Brazil marker (`Config` or `packageInfo/`) walking up; or a `Config` in the repo
root. Otherwise **worktree**.

- **worktree** — runs in an isolated worktree under `$TMPDIR` and **deliberately does not
  merge back**. The path comes back in the JSON. Since the agent is git-banned, merging,
  verifying and pruning are **yours**. By design; don't "fix" it by forcing inplace.
- **inplace** — edits land in your real repo, and the post-run revert runs against your real
  repo. Hence the clean-tree gate.

MEASURED: worktree auto-picked for microrealestate; `--mode inplace` put edits on disk.

### 3.2 The allowlist leaks — `*` crosses directory boundaries

Enforcement runs **after** GPT finishes: walk `git status --porcelain`, revert anything not
matching (tracked → `git checkout HEAD --`, untracked → `rm -f`). Matching is an inline
python3 `fnmatch`, and **fnmatch does not treat `/` as a boundary.** I extracted the real
function and called it — MEASURED:

| Pattern | Path | Result |
|---|---|---|
| `src/*` | `src/deep/nested/a.ts` | **MATCH** — crossed two dirs |
| `*.ts` | `src/a.ts` | **MATCH** |
| `*.ts` | `node_modules/x/y.ts` | **MATCH** |
| `src/**` | `src/a.ts` | MATCH |
| `src/**` | `other/a.ts` | no |

`--allow '*.ts'` authorises every `.ts` in the repo, `node_modules` included. **Name files
explicitly.** A bare extension glob is nearly no restriction.

Two deliberate details: renames attribute to the **new** path; the revert uses `git checkout
HEAD --` not `git checkout --` (commit `19aa767`) so a GPT-*staged* out-of-scope file reverts
to HEAD instead of being restored to its staged content.

**Out-of-scope deletions are also undone** — MEASURED. I replayed the harness's own
`path_matches_allowlist` against a ` D protected.txt` status line: it classifies out-of-scope,
and `git checkout HEAD -- protected.txt` restores the file. So GPT deleting a file it wasn't
allowed to touch is caught, not just modifying one. Worth knowing, since "revert" could
plausibly have meant modifications only.

### 3.2a A `git commit` during the run defeats the allowlist entirely — MEASURED

The scope guarantee has a hole. `enforce_allowlist` inspects `git status --porcelain`, which
compares against **current HEAD** — and `baseline_head` (captured at line 949/978) is used
**only in the JSON output**, never in enforcement. `grep -n baseline_head` returns hits at
910, 930, 948-949, 970, 977-978, 990: all `emit_result_json` plumbing.

So if anything commits mid-run, the changes disappear from porcelain and enforcement sees
nothing. I tested it: edited an out-of-scope `secret.txt`, committed it, then replayed the
harness's view —

```
porcelain output after commit: ''      <-- empty
files enforcement would inspect: 0
secret.txt content now: TAMPERED       <-- survived
HEAD moved? base=2cc66b41 now=db4f7740
```

`outOfScopeReverted` would be `[]` and `status` `ok`, while the repo carries a committed
out-of-scope change. In **inplace** mode that lands on your real branch.

**Mitigation, and its limit:** the agent spec tells the wrapper agent "GIT IS OFF-LIMITS …
you are not permitted to commit". But that is a **prompt instruction to the Claude forwarder**,
not a technical control on the GPT child — `grep -nE 'git-ban|forbid|deny|sandbox_permissions'`
over the harness returns **nothing**. Nothing mechanically stops Codex from running `git
commit` inside the workspace.

Practical consequence: don't treat `outOfScopeReverted: []` as proof of no sprawl. Check
`git log` as well as `git diff` after an inplace run — if HEAD moved, the harness didn't tell
you. This is why worktree mode (the default for non-Brazil repos) is the safer choice: damage
is confined to a throwaway worktree.

Credit: surfaced by `gpu-multiagent-advisor` (§4.12) and verified here — it also flagged
that a rename of an allowlisted file to a non-allowlisted path may leave the original
deleted-and-unrestored, and that reads (`.secrets/`) are entirely unconstrained. Both
plausible from the code; **neither tested by me.**

### 3.3 Preconditions, in order

1. `--repo` inside a git work tree
2. `bwrap` on PATH — satisfied by the stub (§5.1)
3. **clean tree** — any `git status --porcelain` output aborts

The clean-tree gate is load-bearing: in inplace mode the revert diffs against HEAD, so
pre-existing uncommitted work would be **destroyed**. Upstream prescribes parking:

```bash
git add -A && git commit -m "wip: park local changes for codex run (do not push)"
# … codex, review, verify …
git reset --soft HEAD~1 && git reset HEAD
```

⚠️ **In microrealestate, never `git add -A`.** AGENTS.md forbids it — an `add -A` already
swept a real bill PDF into a public commit. Stage explicit paths or `git stash push --
<paths>`. The upstream doc wasn't written for a public repo.

MEASURED: one untracked doc (`HANDOVER_2026_08_03.md`) aborted a run with `DIRTY TREE`.

### 3.4 Models — and what model/effort the delegation actually uses on this machine

**Answer: `openai.gpt-5.6-sol` at `max` reasoning effort.** MEASURED — traced through the
whole chain, because model and effort are resolved in *different* places:

| | Resolved by | Value here |
|---|---|---|
| **model** | harness default (line 23) **and** `~/.codex/config.toml:8` — they agree | `openai.gpt-5.6-sol` |
| **effort** | *not* the harness. It appends `--effort` **only if you pass it** (lines 570-572) and never writes an effort key into the temp config — so it falls through to `~/.codex/config.toml:7` | `model_reasoning_effort = "max"` |

The subtlety: with the default `coding` MCP profile the harness generates a **temp
`CODEX_HOME`**, so the question is whether your effort setting survives that copy. It does —
the generator preserves every top-level scalar. I ran the generator against the real config
to confirm `model_reasoning_effort` is among the preserved keys, rather than inferring it
from the code.

⚠️ The harness log line reads `effort=default` on these runs. That means **"the harness
passed nothing"** — not "low". The real effort is whatever `~/.codex/config.toml` says.
Change that file to change effort for every run that doesn't pass `--effort` explicitly.

Valid IDs: `openai.gpt-5.6-sol` (default), `openai.gpt-5.6-terra`, `openai.gpt-5.6-luna`,
`openai.gpt-5.5`. **Never append `-codex`** — 404s. A 404 is a bad model string or wrong
region, never a Bedrock outage.

Region table, FROM PACKAGE DOCS (2026-07-13, not re-verified): sol and 5.5 **404 in
us-west-2**; terra/luna work everywhere; luna had a us-east-1 stall report. This machine has
the required pin — `region = "us-east-2"` at `config.toml:40` (MEASURED), which sol needs.
Without a pin, codex falls back to ambient `AWS_REGION` — commonly us-west-2, where sol 404s.
Codex CLI here: `0.146.0.316`.

### 3.5 apply-and-stop — never tell GPT to build

The Codex sandbox blocks `brazil-build` and often the network. A "build and test"
instruction sends GPT into a silent command, and **the watchdog reads that silence as a
stall and kills a healthy run.** Tell it to apply edits and stop. `npx tsc --noEmit` is the
absolute ceiling. Claude builds afterwards, unsandboxed.

### 3.6 Reading the JSON — treat it as a claim

- `verify.ran: false` is **normal** without `--verify-cmd`. Not a failure.
- `outOfScopeReverted` non-empty = sprawl already undone. Log it; don't re-run.
- **`status: stalled` is not necessarily failure.** If the diff shows allowlisted files
  changed, the watchdog killed GPT *after* the edits landed → treat as delivered, go review.
- `status: ok` + **empty** `inScopeChanged` = the run did nothing. On Linux: bwrap. Anywhere:
  the allowlist matched nothing.
- Watchdog is CPU-aware — log growth, git change, *or* advancing CPU seconds reset the idle
  timer. Only genuinely wedged processes die.

`inScopeChanged` is the harness reporting on itself. **Read the diff.**

---

## 4. How to prompt every capability

### THE LIST — copy a line, replace `<…>`, send it

Every capability, one row each. `✅` = I ran it and read the result. `—` = reachable/read from
source, never exercised. Notes and evidence are in §4.1 onward; this table is the lookup.

| # | I want to… | Type this | ✓ |
|---|---|---|---|
| 1 | **The full flow** — Claude scopes, GPT writes, Claude reviews | `Use gpu-orchestrator. <task>. Route the implementation phase to gpu-codex-coder.` | ✅ |
| 2 | **GPT to write one scoped change** | `Use the gpu-codex-coder agent. Repo: <abs path> · Allowlist: <exact/file.ts> · Mode: inplace. Task: <objective + acceptance criteria + exact symbols>. Apply the edits and STOP. Do not build, do not run tests.` | ✅ |
| 3 | Pick a different GPT model | `… Model: openai.gpt-5.6-terra.` (omit → sol) | ✅ |
| 4 | Set reasoning effort | `… Effort: low.` (omit → **max**, inherited from your codex config) | ✅ |
| 5 | Edits in my real tree (not a temp worktree) | `… Mode: inplace.` | ✅ |
| 6 | Isolated worktree I merge myself | omit `Mode:` for a non-Brazil repo → worktree. **You** merge/verify/prune. | ✅ |
| 7 | Run a check after the edits | `… Verify with: npx tsc --noEmit.` | ✅ |
| 8 | Give GPT all my MCP servers | `… Use the full MCP profile.` | ✅ |
| 9 | Change stall timeouts | `… Idle timeout: 300. Max runtime: 900.` | ✅ |
| 10 | Fix what review found | Fresh dispatch, new prompt + allowlist. Max 2 cycles. Never message a running agent to widen scope. | — |
| 11 | **Claude** to implement instead of GPT | `Use gpu-coder for this, not gpu-codex-coder.` | ✅ᴿ |
| 12 | Find code / symbols / callers | `Use gpu-multiagent-explorer — find every place we call <X>.` | ✅ |
| 13 | Docs, API refs, a URL, **any verifiable fact** | `Use gpu-multiagent-librarian — <question>.` | ✅ |
| 14 | Architecture call, or I'm stuck after 2 failures | `Use gpu-multiagent-advisor — <A> or <B> here, and why?` | ✅ |
| 15 | Break an epic into tasks | `Use gpu-multiagent-planner — break this into tasks with success criteria.` | ✅ |
| 16 | Clarify a vague requirement | `Use gpu-multiagent-triage — what does this actually require?` | ✅ |
| 17 | UI / frontend code | `Use gpu-multiagent-frontend — <UI task>.` | ✅ |
| 18 | Drive a browser, scrape, screenshot | `Use gpu-multiagent-browser — <flow>.` | — |
| 19 | Taskei / CR / pipeline / Apollo / oncall | `Use gpu-multiagent-ops — <op>.` | ✅ |
| 20 | Slack / email / calendar | `Use gpu-multiagent-comms — <message>.` | ✅ |
| 21 | Read a PDF / image / diagram | `Use gpu-multiagent-lens — read <EXACT/path.png> and describe it.` ⚠️ exact path required — it cannot search | ✅ |
| 22 | Andes / Datanet / QuickSight / SQL | `Use **gpu-bi** — <data question>.` ⚠️ not `gpu-multiagent-bi`, which has no data tools (§5.5) | ✅ |
| 23 | Descriptive docs (README, changelog) | `Use gpu-multiagent-writer — write <doc>.` | — |
| 24 | Persuasive docs (six-pager, proposal) | `Use gpu-writer-critic — <argument to make>.` | ✅ᴿ |
| 25 | Typo, file move, install, shell one-liner | `Use gpu-multiagent-worker — <chore>.` | ✅ |
| 26 | Code / plan review | `Use gpu-reviewer — review <diff or plan>.` | ✅ |
| 27 | Max-effort multi-agent mode | `@agent-sop:ulw <task>` | — |
| 28 | Other explicit modes | `@agent-sop:plan` · `:analyze` · `:search` · `:verify` · `:delegate` — **must name them; they never self-trigger** | — |
| 29 | Bypass the agent, drive the harness | `bash <harness> --repo <path> --allow '<file>' --prompt-file /tmp/p.txt --mode inplace` | ✅ |

`✅ᴿ` = **r**esolves (dispatch permitted, confirmed) but I never gave it real work.
`⏳` = fix applied, needs one session restart to take effect.

**Four rules that apply to rows 1-10 regardless of what you type:**

1. Target repo must have a **clean git tree** (one untracked file blocks it).
2. **Name files explicitly** in the allowlist — `*` crosses directories, so `*.ts` includes
   `node_modules` (§3.2).
3. **Never tell GPT to build or test** — the watchdog kills the run as a stall (§3.5).
4. **Read the diff.** `inScopeChanged` is the harness quoting itself; check `git log` too
   (§3.2a).

---

### 4.1 The orchestrated flow — the headline capability

> Use `gpu-orchestrator`. <task>. Route the implementation phase to `gpu-codex-coder`.

Claude scopes → GPT implements → Claude reviews → Claude builds. **MEASURED**: I dispatched
it against a scratch repo, it delegated to `gpu-codex-coder` (PERMITTED, `codexExitCode: 0`),
and I independently read `version.ts` → `'2.0.0'`.

### 4.2 GPT implements one scoped change — direct, no orchestrator

> Use the `gpu-codex-coder` agent.
> Repo: `/abs/path` · Allowlist: `exact/file.ts` · Mode: inplace
> Task: <objective, acceptance criteria, exact symbols, house rules>
> Apply the edits and STOP. Do not build, do not run tests.

**MEASURED** twice. Second run: three Greek month names nominative→genitive
(Ιανουάριος→Ιανουαρίου, Φεβρουαρίου, Μαρτίου), comment updated, verified by `git diff`.

### 4.3 Prove the scope guard is live

Add a file that is *not* on the allowlist and say you expect it reverted.

**MEASURED**: `outOfScopeReverted: ["untouchable.ts"]`, file still `'DO_NOT_CHANGE'`, while
the allowlisted file genuinely changed.

### 4.4 Model / reasoning effort

> … Model: `openai.gpt-5.6-terra`. Effort: high.

Without this line you get **sol at `max`** — inherited from `~/.codex/config.toml`, not from
the harness (§3.4, MEASURED). To change the default for every run, edit that file rather than
repeating the flag.

**UNVERIFIED**: terra/luna/5.5, and the `--effort` flag override itself.

### 4.5 Force inplace / accept worktree

> … Mode: inplace.

MEASURED. Omit for a non-Brazil repo and you get worktree — then **you** merge, verify,
prune from the JSON's `worktree` path. Merge-back path UNVERIFIED.

### 4.6 Attach a verification command

> … Verify with: `npx tsc --noEmit`.

**MEASURED**: with `--verify-cmd 'node -e "process.exit(0)"'` the JSON returned
`verify: { "ran": true, "exitCode": 0, "tail": "" }` and the edit still landed
(`N = 1` → `N = 42`). So `ran: true` + the real exit code is what a supplied command
produces — compare §3.6, where `ran: false` just means none was passed.

⚠️ A `brazil` substring anywhere in the command flips auto-detect to `inplace` (§3.1).

### 4.7 MCP exposure / watchdog tuning

> … Use the full MCP profile. Idle timeout: 900. Max runtime: 3600.

`coding` (default) = builder-mcp only. A `WARNING: Failed to generate coding-profile config`
means python `tomllib`/`tomli` is missing and it silently fell back to `full`.
**UNVERIFIED.**

### 4.8 Fix cycle after review

Dispatch a **fresh** `gpu-codex-coder` with a new prompt + allowlist. Max 2 cycles.
Write-scope is **immutable** — messaging a running agent cannot widen it. **UNVERIFIED.**

### 4.9 Claude implements instead

> Use `gpu-coder` for this, not `gpu-codex-coder`.

For vague/exploratory work, or if codex returns nothing. Needs the §5.3 fix + a restart.

### 4.10–4.22 The specialists

| Want | Say |
|---|---|
| Find code | "Use `gpu-multiagent-explorer` — find every place we call X" — **MEASURED**: asked it to find `optimisticConcurrency`; returned Building:465 / Realm:149 / Tenant:219 plus 6 comment-only references. I re-read all three lines and ran my own grep — exact match, no invention. Returns structured JSON (patterns / files / implementations). |
| Docs / any verifiable fact / read a URL | "Use `gpu-multiagent-librarian` — what does <API> accept?" |
| Architecture call, or stuck after 2 failures | "Use `gpu-multiagent-advisor` — SNS or EventBridge here?" — **MEASURED, and it earned its keep:** asked for failure modes in the harness's post-hoc revert design, it found the `git commit` bypass (§3.2a) with correct line-number citations. I verified the top finding and it held. It gives a decisive ranked answer, not a survey — but its output is **claims**: re-read the cited lines before acting. Two of its lower findings I did not test. |
| Break down an epic | "Use `gpu-multiagent-planner` — break this into stories with success criteria" — **MEASURED**: asked for the upstream bwrap-fix CR plan; returned 6 ordered tasks with per-task success criteria, evidence-of-done, a dependency graph, effort estimates (~2.5h) and a risk table. Used zero tools — pure planning from the brief, so its quality is bounded by what you tell it. |
| Clarify a vague ask | "Use `gpu-multiagent-triage` — what does this actually require?" |
| UI/frontend code | "Use `gpu-multiagent-frontend` — add the settings page" |
| Drive a browser | "Use `gpu-multiagent-browser` — screenshot the flow and extract the table" |
| Taskei / CR / pipeline / Apollo | "Use `gpu-multiagent-ops` — open a Taskei ticket for this" |
| Slack / email / calendar | "Use `gpu-multiagent-comms` — send the team channel a summary" |
| PDF / image / diagram | "Use `gpu-multiagent-lens` — extract the architecture from this PDF" — **MEASURED, with a caveat: give it an EXACT path.** Its only tools are `Read` + `ReadInternalWebsites` — no `Bash`, no `Glob`, so it cannot search for files. Asked to "find a screenshot", it guessed directories, missed all of them, and reported "no images found" — while `find` shows **174** PNGs in the repo. Given an exact path it read the image accurately and in detail. **A negative from this agent is not evidence of absence.** |
| Andes / Datanet / QuickSight / SQL | "Use `gpu-multiagent-bi` — why did this ETL fail last night?" |
| Descriptive docs | "Use `gpu-multiagent-writer` — write the README for this package" |
| Persuasive docs | "Use `gpu-writer-critic` — six-pager proposing the new event system" |
| Trivial edit / file move / install | "Use `gpu-multiagent-worker` — fix the typo, move these files" |
| Code review | "Use `gpu-reviewer` — review this diff" (needs §5.3 + restart) |

All UNVERIFIED individually except `gpu-reviewer`, which I probed (replied "probe") and
`gpu-multiagent-*` reachability, confirmed via the orchestrator's own enumeration. MEASURED.

### 4.23 The sop-* modes

> `@agent-sop:ulw` <task> — ultrawork: TODO list + parallel explorer/librarian immediately
> `@agent-sop:plan` / `:analyze` / `:search` / `:verify` / `:delegate`

`disable-model-invocation: true` — **name them explicitly**, they never self-trigger.
FROM SOURCE, all UNVERIFIED.

### 4.24 Call the harness directly, no agent

```bash
printf 'your prompt\n' > /tmp/p.txt
bash ~/.aim/packages/ClaudeCodexPowerWorkflow-1.0/eventId-6488078792/skills/codex-scoped-run/scripts/codex-scoped-run.sh \
  --repo /abs/path --allow 'path/to/file.ts' --prompt-file /tmp/p.txt --mode inplace
```

Best for debugging the harness — you see its stderr directly. **MEASURED.** The path is
baked at install time via an AIM template and **changes on reinstall**; re-read
`~/.aim/cc-plugins/ClaudeCodexPowerWorkflow-claude-codex-power-workflow/agents/gpu-codex-coder.md`
rather than trusting it.

---

## 5. The three defects, in detail

### 5.1 bwrap — the package contradicts itself

Harness line 292 hard-requires `bwrap`. The package disagrees with its own code:

| Source | Says |
|---|---|
| mainline README, prerequisites table | **"bubblewrap (bwrap) — macOS: not needed"** — Codex uses the built-in macOS Seatbelt framework |
| mainline README, "Preconditions" | "must be on PATH (without it the sandbox rejects all writes silently)" |
| `SKILL.md:93` | same, plus "`brew install bubblewrap` (macOS)" |
| the code, line 292 | unconditional `command -v bwrap` → die |

MEASURED:
- No OS guard anywhere — `grep -E 'uname|OSTYPE|darwin|Seatbelt|sandbox-exec'` over 1026
  lines: **zero matches**.
- `brew install bubblewrap` → **`bubblewrap: Linux is required for this software.`** The
  formula is `depends_on :linux`. SKILL.md's macOS remedy is impossible.
- **The premise is false on macOS.** `codex exec --sandbox workspace-write` rewrote a file
  in a scratch repo with no bwrap present, confirmed by `git diff`. macOS has
  `/usr/bin/sandbox-exec`.
- Lines 289–294 are the **only** bwrap references. It's a gate, never invoked.

Origin: commit `bd194a1` added it after bwrap's absence "burned 3 smoke-test attempts" — a
real **Linux** failure mode generalised to all platforms. That CR is
a shipped, two-reviewer-approved CR ("fix(harness): fail fast when bubblewrap is missing…",
merged 2026-07-17 — find it from the commit log of the package, deliberately not linked here
since this repo is public). So the gate is intentional and reviewed; the macOS case was missed.

**Where the Seatbelt claim comes from, precisely.** The `docs.hub.amazon.dev/codex/` internal
guide does **not** document platform sandboxing at all — no mention of bwrap, Seatbelt, or
`sandbox-exec` across all 8 pages of the user guide. Its only sandbox reference is
`codex doctor` validating "the active sandbox profile", undefined. So the
"macOS uses Seatbelt" statement rests on two things, neither of which is official Amazon
documentation:

1. **The package's own README** prerequisites table, which states it outright.
2. **Behaviour I measured** — codex wrote files on macOS with no bwrap present.

Upstream OpenAI source (`codex-rs/sandboxing/src/lib.rs`) reportedly selects bwrap+Landlock
on Linux and Seatbelt on macOS via conditional compilation — but that is a second-hand
citation I have **not** read myself. The *mechanism* is therefore inference; the
*consequence* (writes work on macOS without bwrap) is measured. The fix rests on the
consequence, not the mechanism.

**Fix:** no-op stub at `~/.local/bin/bwrap` (755). Already on PATH in interactive and login
shells, not AIM-managed, so reinstall can't clobber it.

It is **not a sandbox** — zero isolation. Acceptable only because bwrap is never executed on
macOS; scope protection comes from `--allow` + the git revert, which I watched work. The stub
prints a loud stderr warning if ever called **with arguments** (a real invocation, vs a
`command -v` probe), so the assumption fails loudly. Delete it if the harness gains an OS
guard.

Note the SessionStart hook checks the codex CLI and plugin cache but **not** bwrap — nothing
warns you about the one thing that blocks a run.

### 5.2 The README's headline pattern doesn't work

The README says run `claude --agent gpu-multiagent` and ask it to use `gpu-codex-coder`,
calling direct invocation "testing only". **Inverted here.** `gpu-multiagent`'s `Agent()`
allowlist has 17 entries; `gpu-codex-coder` is absent (`grep -n codex` on that file: nothing).

MEASURED: dispatched `gpu-multiagent`, asked for one call →
**`Agent type 'gpu-codex-coder' not found.`**

Cause: `aim.json` declares the dependency the *other* way (ClaudeCodexPowerWorkflow opts
into gpu-multiagent), but nothing adds the codex agent to the orchestrator's allowlist.
Namespaces differ, and matching is namespace-scoped.

### 5.3 Four more agents are mis-namespaced — same bug class

The allowlist declares `AIPowerUserCapabilities-multiagent:` for `gpu-coder`,
`gpu-reviewer`, `gpu-writer-critic`, `gpu-cr-guide-worker`. **None of them live there** —
the first three are in `autonomous-coding`, `writer-critic` is in `writing`.

MEASURED: probed all four exactly as written → **all four REJECTED**, `not found`. That is
the orchestrator's code-review *and* Claude-implementation arms both dead — in stock
`gpu-multiagent` too, not just my copy.

**Fixed in `gpu-orchestrator`** with correct namespaces. MEASURED that the corrected string
resolves (`autonomous-coding:gpu-reviewer` → replied "probe"). ⚠️ The allowlist change needs
**one session restart** to take effect; the codex route (§5.2) already works.

---

### 5.4 The package's own test suite cannot run — TWO bugs, both macOS-only — MEASURED

`bash test-codex-scoped-run.sh` dies on its first test with a Python `JSONDecodeError:
Expecting value: line 2 column 1`. That traceback is a red herring twice over. There are two
independent defects in the suite's own scaffolding, and **neither is in the harness**:

**Bug 1 — wrong harness path (line 12).**

```bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HARNESS="$SCRIPT_DIR/../codex-scoped-run.sh"        # ../ is wrong
```

Both files live in the **same** `scripts/` directory — in the installed plugin *and* in
mainline. `$HARNESS` points at nothing, the call emits nothing, `json.load()` chokes on empty
stdin. The suite's own header (line 6) still reads `Usage: bash tests/test-codex-scoped-run.sh`
— it used to live in a `tests/` subdir where `../` was correct, was moved into `scripts/`, and
the path never followed.

**Bug 2 — `mktemp` template with a suffix (line 90).**

```bash
pf=$(mktemp "${TMPDIR:-/tmp}/test-prompt-XXXXXX.txt")
```

macOS `mktemp` only substitutes `X`s at the **end** of the template. With `.txt` trailing, it
creates a file named literally `test-prompt-XXXXXX.txt`, and every later call fails
`mkstemp failed: File exists`. `$pf` is then empty, so the harness is invoked with no
`--prompt-file` and correctly refuses. Proven:

```
call 1 -> /tmp/t-XXXXXX.txt                              # literal name!
call 2 -> mktemp: mkstemp failed on /tmp/t-XXXXXX.txt: File exists
```

GNU `mktemp` accepts the suffix, so this passes on Linux — **the same macOS blind spot as the
bwrap gate (§5.1)**. Line 364 (`test-harness-XXXXXX.sh`) has the identical defect; it survives
only because it runs once per invocation. Latent, not fixed.

**With both corrected, the suite is sound: `13 passed, 0 failed`** (MEASURED — I fixed a
copy at `/tmp`, not the installed file). That matters: it **independently corroborates**
harness behaviour I had otherwise only measured myself — stall detection, `codexExitCode 137`
on watchdog kill, scope-revert firing even on the stalled path, the coding-profile config
generation, and the JSON field set.

One quirk: `test_bwrap_precondition` passes by `sed`-patching a copy of the harness to look
for a nonexistent binary, rather than manipulating `PATH`. So it never sees the §5.1 stub and
its result is unaffected by it.

Upstream CR ordering, if anyone writes one: fix these two first, or `test_bwrap_precondition`
cannot be updated for the §5.1 fix at all.

---

### 5.5 `gpu-multiagent-bi` has no data-platform tools — MEASURED

Dispatched it to do one lightweight Andes read. It reported the tools were **not in its
callable set** — and blamed a "session-level tool registration issue… launched without them
being bound." Its symptom was right, its diagnosis wrong. The real cause is the **same bug
class as §5.3**: a name that doesn't match what's registered.

| Declared in `gpu-multiagent-bi.md` | Actually registered as |
|---|---|
| `mcp__andes-mcp` | `mcp__plugin_AIPowerUserCapabilities-multiagent_andes-mcp__*` |
| `mcp__datanet-mcp` | `mcp__plugin_AIPowerUserCapabilities-multiagent_datanet-mcp__*` |
| `mcp__amazon-quick-mcp` | `mcp__plugin_AIPowerUserCapabilities-multiagent_amazon-quick-mcp__*` |

I confirmed the real names resolve by loading `SearchDatasets` / `ReadProviders` myself. The
MCP servers are running and authenticated — the agent just names them wrong, so it matches
nothing and silently gets zero data tools.

**Fixed and verified.** A local `~/.claude/agents/gpu-bi.md` with plugin-qualified prefixes,
and `gpu-orchestrator`'s allowlist re-pointed at `gpu-bi`. After the restart it registered and a
real `SearchDatasets` call returned **2,008 datasets** — MEASURED. Use `gpu-bi`, not
`gpu-multiagent-bi`.

⚠️ **The same bare-prefix pattern appears in 13 of the 14 agent files** (`mcp__slack-mcp`,
`mcp__playwright-proxy-mcp`, `mcp__venue-mcp`, `mcp__pippin-mcp`, `mcp__genai-power-users-mcp`,
…). Yet **comms and browser worked** in testing — comms listed real Slack unreads, browser
drove Playwright against NAS and returned a correct Greek screenshot. So the bare prefix is
tolerated in at least some cases; only the three BI servers demonstrably failed. I have not
established the rule that separates them. If another specialist reports "tool not available",
suspect this first and check the registered name with ToolSearch.

---

## 6. Using this on microrealestate

- **Public repo.** GPT doesn't know AGENTS.md unless you put it in the prompt. Fold in: no
  real data in fixtures/comments/docs, no hardcoded credentials, no `git add -A`.
- **Clean-tree gate will bite** — one untracked doc blocks it. Stage explicit paths or
  `git stash push -- <paths>`. **Never `add -A` here.**
- **Money surfaces are TIER-MONEY.** GPT's diff still needs the `refuter` pass and the Step
  5b live-NAS check. A green harness JSON is not verification — it isn't even a test run.
- **Claude owns the build.** `yarn workspace landlord build` catches what `next dev` doesn't.
  GPT must not attempt it.
- **Exact paths in `--allow`.** `services/**` authorises the whole backend (§3.2).

---

## 6a. The two workflows — new feature, and bug fix

These wire the agents to the repo's own gates. **The gates win every time.** Where
`fix-discipline-do-not-skip.md` and a nice-looking agent pipeline disagree, the document is
right and the pipeline is wrong — it exists because agents in this repo have a documented
record of skipping exactly these steps.

Two rules that apply to both workflows:

- **Every agent result is a CLAIM.** Re-read the cited `file:line` yourself before relaying it.
  A confident subagent that read the wrong file is still wrong. Measured this session: `lens`
  reported "no images" against 174 real files; `gpu-multiagent-bi` misdiagnosed its own missing
  tools as a session-binding problem when the cause was a wrong prefix (§5.5).
- **GPT never builds, never deploys, never commits.** You build (unsandboxed), the user
  authorises deploys.

---

### WORKFLOW 1 — Develop a new feature

Feature work has no fix-discipline Step 0 obligation, but `brainstorming` is required before
creative work, and Step 5b (run the feature) plus Step 7 (adversarial refute) still gate "done".

| Phase | Who | What you type / do | Gate |
|---|---|---|---|
| **1. Shape it** | you + user | `superpowers:brainstorming` — settle intent BEFORE any code | required for new features |
| **2. Is the ask even clear?** | `gpu-multiagent-triage` | `Use gpu-multiagent-triage — what does <feature> actually require, what's ambiguous?` | skip only if the spec is already exact |
| **3. Read the existing system** | `gpu-multiagent-explorer` (parallel: one per surface) | `Use gpu-multiagent-explorer — find every surface that consumes <data shape>: schema, routes, frontdata, UI consumers, tests` | **produces the file:line artifact** |
| **4. External facts** | `gpu-multiagent-librarian` | only for versions/APIs/docs you'd otherwise guess | — |
| **5. Design call** | `gpu-multiagent-advisor` | `Use gpu-multiagent-advisor — <A> or <B>, and why?` | if a real trade-off exists |
| **6. Plan** | `gpu-multiagent-planner` | `Use gpu-multiagent-planner — break this into tasks with success criteria` | — |
| **7. Write the test first** | you | `superpowers:test-driven-development` | before implementation |
| **8. Park WIP** | you | `git status --porcelain` must be empty. **Stage explicit paths — never `git add -A`** (public repo) | harness precondition |
| **9. Implement** | `gpu-codex-coder` (GPT) — or `gpu-multiagent-frontend` for UI | row 2 of THE LIST, exact allowlist, `Mode: inplace`, *apply-and-stop* | — |
| **10. Read the diff** | you | `git diff` **and** `git log` (§3.2a — a commit hides sprawl from the harness) | — |
| **11. Build** | you | `yarn workspace landlord build` — not `next dev`, which only compiles routes you visit | — |
| **12. Review** | `gpu-reviewer`, and `refuter` ×N for money | see Step 7 below | — |
| **13. RUN THE FEATURE** | `feature-verifier` | seed the **INPUT**, not the output; paste the app's own artifact | **Step 5b — non-negotiable** |
| **14. Greek UI review** | you | screenshot `/landlord/el/...`, read the image, open every dropdown | `ui-review-do-not-skip.md` |
| **15. Deploy** | **user only** | never unilateral | Step 5 |

---

### WORKFLOW 2 — Fix a bug

**Load [`fix-discipline-do-not-skip.md`](../.kiro/steering/fix-discipline-do-not-skip.md) first
— before this guide, before any agent.** Then:

**Step −1. Classify the tier, in writing.** `Tier: MONEY` or `Tier: UI`. MONEY covers money,
rent, payment, allocation, expense, owner-billing, balance, settlement, lifecycle, search,
filter, and **any** schema/validator/pipeline change. **When unsure it is MONEY.** If you never
wrote the tier down, you skipped this.

**Step 0-1. Read before proposing — the first response is a reading list, not a fix.**

Fan out `gpu-multiagent-explorer`, one per surface, in parallel:

> `Use gpu-multiagent-explorer` — for `<field>`, report with file:line: the Mongoose schema,
> every route handler producing/consuming it, the frontdata transform, every UI consumer, and
> every test asserting on it. Report only findings.

**Paste the reading with line refs.** Then phrase the fix in exactly this shape:

> "Surface X disagrees with surfaces Y, Z, W. The fix is to make X match the rest. It touches N lines."

Can't phrase it that way → you haven't read enough. **Proposing "Option A / B / C" is the
documented symptom of having skipped this step** — the design is almost never open; the other
surfaces already settled it.

⚠️ Before repeating any "blocked on <artifact>" line from a plan doc, **look on disk.**
`BILL_OCR_INBOX_PLAN.md` claimed "need sample bills" for five days while the bills sat
already-OCR'd in the tree.

**Step 2. Fix the leak, not the architecture.** >2-3 files, a rename, a new enum/constant/
bucket, or an edited test-to-pass → stop, re-read Step 0. Paste one-line-per-file justification.

**Step 3. Verify every surface** that consumes the shape — rent table, dashboard pie,
accounting page, tenant detail, payment dialog preview/allocation/saved-tile. Paste what you
**observed**, not "looks fine".

**Step 5b. If the user asked for verification, RUN THE FEATURE** — `feature-verifier`. Seed the
INPUT and let the app produce the output. Every branch fired individually; an unfired branch is
**NOT VERIFIED**, never covered-by-the-others.

**Step 7. Adversarially refute before the word "fixed".**

TIER-MONEY — dispatch `refuter` ×N **in parallel, independent** (never paste one's findings
into another's prompt), one lens each (correctness / money / lifecycle / i18n):

> Default verdict is **BROKEN**; HOLDS must be earned. Every claim needs `file:line` from a
> file you opened. Give a concrete failure scenario — inputs/state → wrong output — not a
> category. **Enumerate SIBLING shapes**, not just the reported one.

Idle timeout **180000 ms** — a silently-hung reviewer is indistinguishable from a clean HOLDS.
Each BROKEN gets an independent second opinion. **Paste the verdict table.** Any confirmed
BROKEN → fix and run Step 7 again.

TIER-UI — lighter self-refute, still pasted: enumerate 3-5 ways it could be wrong, drive the
changed surface **and two adjacent ones** in a browser, paste what you saw. If any enumeration
touches computed data, reclassify to MONEY.

**No "it was one line" exemption exists.** The duplicate-propertyId bug was a one-line
validator gap.

---

### Where GPT fits, and where it doesn't

| Give GPT | Keep on Claude |
|---|---|
| A fully-scoped diff: exact files, acceptance criteria, house rules | Finding the scope (it has no research tooling, by design) |
| Mechanical multi-file refactors, test additions | Reading the existing system (Step 0-1) |
| Repo-resident config | Review, build, verify, deploy |

`gpu-codex-coder` cannot find its own scope and is git-banned. The cross-model value is real —
Claude reviewing GPT catches classes of mistake GPT makes — but only if Claude did the scoping.

### The honest four-part test before typing "fixed"

Can you paste **(a)** the reading with line refs, **(b)** surface-verification observations,
**(c)** the Step-7 verdict table with every finding HOLDS, and **(d)** — if verification was
asked — the feature's **own** output for **every** branch? Missing any one → not finished, only
claimed. And (d) is never tests; it's the production log line, the HTTP 200 from the real
endpoint, the row the app wrote itself.

---

## 7. Quick reference

```bash
ls -l ~/.local/bin/bwrap && command -v bwrap          # macOS stub present?
codex --version
codex exec --skip-git-repo-check --model openai.gpt-5.6-sol "Reply with the single word: ok"
ls ~/.claude/plugins/cache/openai-codex/codex          # cache the harness needs
pkill -f app-server-broker.mjs                         # "no rollout found" → stale broker
```

| Symptom | Cause |
|---|---|
| `Unknown argument: --prompt` | It's `--prompt-file`. |
| `DIRTY TREE: stash/commit first` | Uncommitted/untracked files in `--repo`. |
| `bubblewrap (bwrap) is not installed` | Stub missing (§5.1). |
| `Agent type 'gpu-codex-coder' not found` | You used `gpu-multiagent` (§5.2). Use `gpu-orchestrator`. |
| `Agent type 'AIPowerUserCapabilities-multiagent:gpu-coder' not found` | §5.3 — restart needed. |
| `status: ok`, `inScopeChanged: []` | Allowlist matched nothing (or, on Linux, bwrap). |
| `outOfScopeReverted: []` but the repo changed anyway | Something committed mid-run — enforcement is blind to it (§3.2a). Check `git log`, not just `git diff`. |
| 404 `model does not exist` | `-codex` suffix, or wrong region for sol/5.5. |
| Killed as "stall" during a build | You told GPT to build. Don't (§3.5). |

---

## 8. Verification ledger

**Exercised end-to-end (MEASURED).** Orchestrated flow (§4.1) · direct `gpu-codex-coder`
(5 runs) · scope guard incl. out-of-scope revert **and** deletion-restore · `--mode inplace`
· worktree auto-detect · `--verify-cmd` · `--effort low` · `--idle-timeout` +
`--max-runtime` · `--mcp-profile full` · `--model openai.gpt-5.6-terra` · `--prompt-file`
(and that `--prompt` doesn't exist) · dirty-tree gate · model+effort resolution chain ·
allowlist fnmatch leak · the `git commit` enforcement bypass · bwrap contradiction ·
defects §5.2, §5.3 (before **and** after fix), §5.4.

**Specialists dispatched with real work — 8:** explorer, lens, advisor, planner, triage,
librarian, ops, worker. **Resolve-only (dispatch permitted, no real task) — 4:** gpu-coder,
gpu-reviewer, gpu-cr-guide-worker, gpu-writer-critic.

Also run: **the package's own suite, 13/13 green** once its two scaffolding bugs were fixed
(§5.4) — independent corroboration of stall detection, exit-137 kill, scope-revert-on-stall,
coding-profile generation, and the JSON field set.

**Still NOT verified — do not present these as known:**

- **4 specialists never dispatched at all**: frontend, browser, comms, bi. Their tool lists
  in §2 are frontmatter, not observed behaviour.
- All 6 `sop-*` modes.
- luna / gpt-5.5 (terra ✅, sol ✅), and the region table in §3.4 (package docs, 2026-07-13).
- Full worktree merge-back, and the ≤2-cycle review fix loop.
- The advisor's secondary findings: rename-leaves-original-deleted, unconstrained reads,
  outside-repo side effects, `.git/hooks` manipulation. Plausible from code; untested.
- Whether §5.1/§5.3/§5.4 are already fixed past mainline `6b0065c6` (HEAD when I read it).
- `claude --agent gpu-multiagent` from a terminal, vs the IDE-dispatched orchestrator.
- `--codex-companion` (the suite uses it for stubs; I never passed it).

**Where a specialist got it wrong.** `gpu-multiagent-lens` reported "no images found" in this
repo; `find` shows **174**. It has no `Bash`/`Glob` and cannot search — it guessed
directories. Treat its negatives as "didn't look there", never as absence.

**A negative that held up.** `gpu-multiagent-librarian` was asked what the Codex internal
docs say about macOS vs Linux sandboxing. It read all 8 user-guide pages, reported that the
docs say **nothing** on the topic, quoted the single oblique sentence that exists, listed
every URL it read, and explicitly separated an upstream-source claim it had *not* verified
from what it had. That is the shape a trustworthy negative takes — enumerate what you
checked. It also cost the most of any specialist (~70k tokens, 6.6 min).

**Found along the way, unrelated to this task:** `e2e-playwright/_ui_s/` contains six
byte-identical (119811-byte) PNGs, and the one I read (`12_accounting_owners.png`) is a
Next.js hydration-error overlay on the *sign-in* page in English — not the Greek accounting
surface its filename claims. Those July-26 screenshots are not evidence of a reviewed UI.
Flagged, not investigated.

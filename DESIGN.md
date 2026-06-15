# Mailward — Design

An email triage agent for cleaning up Gmail unread mail. AI proposes deletion / archival /
labelling against triage rules; you approve, amend, or reject; rules that prove themselves get
promoted to auto-apply. All actions are logged and reversible. A separate, smarter offline
process learns from your feedback and improves the rules.

## Philosophy

- **The app does; Claude Code thinks.** A standalone TypeScript/Bun web app runs the daily
  triage on a cheap-but-smart model (Haiku / Flash / mini). A Claude Code / Codex *skill*, run
  on demand with a capable model, analyses feedback and proposes rule improvements.
- **Automation only ever earns trust by proving itself while you watch.** Rules graduate
  `proposing → auto`; the analysis process graduates `interactive → semi-autonomous`. Nothing
  gains write-autonomy over your inbox without first being correct under your supervision.
- **Everything is reversible.** Delete = trash (never permanent). Every action stores the prior
  state it changed. Rollback at run / batch / individual granularity.
- **Don't rebuild Gmail.** The value is triage automation + rule learning, not mail reading.

## Architecture

- **Runtime:** TypeScript + Bun web app (`bun run dev` → browser UI). Rich UI, local SQLite DB
  alongside it. Single SQLite file = the whole system state (portable, mass-use friendly).
- **Gmail:** via the existing OAuth + Gmail API integration (reused from another repo).
- **Daily model:** one provider for now (choice deferred), called with a structured-output schema.
- **Offline brain:** a repo skill the user runs in Claude Code / Codex.

## Core concepts

### Rules (hybrid, versioned)
A rule has: `name`, `priority` (integer), structured `match` (prefilter: sender glob, subject
regex, label, age, calendar flags…), natural-language `intent`, `action`
(`trash | archive | label_todo`), `tier` (`deterministic | ai`), `needs_body` (default false),
and `status` (`proposing | auto | suspended`).

- **Deterministic tier:** pure structured match, executes in code, no model call.
- **AI tier:** structured prefilter narrows candidates; the model adjudicates semantics.
- A rule can be **hybrid** — e.g. "delete accepted/declined calendar mail *unless* there's a
  human note" matches structurally but escalates to AI to check for a note before trashing.

Rules are **versioned in SQLite** (not git): `rules` holds stable lineage + current status;
`rule_versions` holds immutable definition snapshots. Each action references the exact
`rule_version_id` that produced it → per-version performance lineage. A diff = comparing two
version rows (rendered in UI / surfaced to the skill via a text helper).

**Editing a rule creates a new version and demotes it to `proposing`** (must re-earn trust).
A manual UI override can force a version back to `auto`.

### The daily run (rule-centric, claim-and-remove)
1. Fetch **unread-in-inbox**, newest first, **cap 200** per run.
2. Process rules **in priority order** (lowest number first). For each rule, candidates =
   `(prefilter ∩ not-yet-claimed)`:
   - **Deterministic** → act (or queue proposal) and **claim & remove** matched threads.
   - **AI** → focused classifier over the candidate batch ("which of these match?"), batched
     ~10–20 threads/call with the rule prompt cached. Returns
     `{thread_id, rule_id, action, confidence (high/med/low), reason}`. Claim & remove matches.
3. **Precedence is by priority integer only — status never reorders it.** A high-priority
   `proposing` rule still claims (→ review) ahead of a low-priority `auto` rule.
4. **Leftovers** (matched no rule) → the uncovered bucket.

You call AI **per email** (within a rule's focused pass), never per rule × email. Cost at
Haiku/Flash prices for ~100–200 threads is single-digit cents.

### Confidence (coarse bands)
Self-reported confidence is poorly calibrated, so use **high / med / low** bands only, never
arithmetic, and never as the primary trust mechanism (that's trash + rollback + auto-demote).
- **Proposing rules:** colour-code lines; optionally drop sub-floor matches to uncovered.
- **Auto rules:** non-destructive (archive/label) low-confidence → **act, then flag** in the
  digest with band-count badges. Destructive (trash) low-confidence → **fall back to a
  proposal** (delete-is-special).

### Model payload (privacy + cost)
Default per thread: `from`, `to`, `subject`, snippet, date, labels, and cheap computed booleans
(`is_calendar_invite`, `has_unsubscribe`, `in_reply_to_me`, `age_days`). Body is fetched and
sent **only for rules that declare `needs_body`**. `local_only` sensitive-sender carve-out
deferred.

## Review UI

Proposals are grouped by rule (collapsible cards), but deterministic and AI rules use different
review controls.

### Deterministic rule review

Deterministic rules propose one action for every matching thread. Threads are pre-checked,
confidence is not needed, and the checkbox model stays natural. Three verbs:

| Verb | Applies | Metric effect | Note |
|------|---------|---------------|------|
| **Approve** | all checked | accepts | none |
| **Amend** | checked subset | unchecked = negatives | optional, prompted |
| **Reject** | nothing | whole batch counts against rule | **mandatory note** |

Optional single-tap **"save this one"** on an unchecked item = "right rule, not this instance"
→ excluded from the promotion metric in real time.

### AI router review

AI router rules produce per-thread disposition recommendations. The rule card is still the
container, but the review unit is the individual thread. Rows are sorted by suggested
disposition, then confidence, and stay in their original suggested section while editing so the
list does not jump.

Each row shows the available dispositions in one button group:

`Trash | Archive | TODO | Skip | Correct`

- The AI suggestion is preselected.
- The active choice uses filled/background styling.
- The original AI suggestion keeps a stronger border, so changed rows are easy to spot.
- AI reasons are hidden by default and shown on demand next to the row note field.
- Notes are optional for any row except **Correct**, which requires one.
- **Skip** means do nothing and learn nothing; it is excluded from promotion metrics.
- **Correct** means do nothing but learn from the mistake; it counts as corrective feedback.
- Changing `Archive → Trash`, `TODO → Archive`, etc. is automatically a correction: negative
  evidence for the suggested disposition and positive evidence for the chosen disposition.

AI router cards have top-level controls:

- **Apply reviewed** — submits the current reviewed set. Row edits are drafts until this is
  clicked; Gmail actions never fire while toggling row choices.
- **Reset suggestions** — restores every row to the AI's original recommendation; no Gmail
  action.
- **Reject...** — rejects the whole group without Gmail action. The dialog requires a reason
  and offers two final actions: **Send reason** or **Send reason and suspend rule**.

### Shared review behavior

- **Reject** / **Reject...** can suspend the rule until a new version revives it.
- Near-misses are **not** shown per card (97% noise). Instead the uncovered bucket offers
  "this should've been caught by rule X" to capture the valuable positive examples on demand.

### Leftover / uncovered area (a learning launchpad, NOT a mail client)
Lists unclaimed mail + your set-aside items. Affordances: the **same triage verbs as quick
buttons** (archive / trash / TODO) logged as `mode=manual` (**this is the training corpus** —
without it the skill is blind), a one-line **note for weekly analysis**, and a **"handle in
Gmail" deep link** for mail needing real reading/replying.

## Gmail action semantics & rollback

- **delete = trash** (recoverable ~30 days; never permanent). Reversible pairs:
  trash/untrash, read/unread, remove-INBOX/add-INBOX (archive/unarchive), add-TODO/remove-TODO.
- **Thread-level** actions; model sees the latest unread message(s) for classification.
- **Mark read on action**, except `label_todo` stays unread (still needs attention).
- Every action stores `prior_state` → exact undo.
- **Rollback granularity:** whole **run** / **batch** = `(run_id, rule_id)` / **individual**.
  Rolled-back rows stay in the log (`status=rolled_back`) and **count as a rejection signal**.

## Promotion to auto-apply

- **Simple gate:** X applied-in-a-row at ≥ Y% approval over a rolling window.
  **Delete demands a tighter bar (~99%)** than archive/label.
- **Suggest-and-confirm** — the app suggests eligibility; **you click to promote**. Never
  automatic.
- **Auto-demote** on post-promotion rejections (a couple flip it back to `proposing`).
- Gate inputs: applied = success; unchecked-**with-corrective-note** or batch-reject = failure;
  unchecked-**no-note** and "save this one" = **excluded**; `failed` (API error) = excluded.
  The gate never compares versions — only the current version's own recent window.

### Auto-applied review (act silently, review after)
Auto rules **act during the run** (no pre-confirm — that's the point), logged with `mode=auto`.
A top-of-run **digest** summarises ("Cold outreach: 5 deleted · ⚠ 2 low-confidence"); expand to
see threads and roll back. Notification = in-app digest (nothing happens while the app is
closed). A post-hoc rejection is a strong demotion signal.

## Analysis skill (the offline brain)

Run on demand in Claude Code / Codex with a capable model. Reads (via a text helper, not raw
SQLite): the actions log + your notes per rule version, per-version metrics, the uncovered-bucket
history + manual fates, current rule definitions.

Proposes (never silently applies): rule **edits** (new version + change note), **new rules**
(mostly mined from uncovered clusters), **merges/deletions**, and a short report.

**Invariants:**
- **The skill can only ever create `proposing` rules — never `auto`.** Promotion is solely via
  the daily gate + your confirm.
- **You approve diffs in-session before they're written.**
- **Never auto-rolls-back on version metrics.** Cross-version metrics are decision *support*
  (with sample-size/time caveats), not a control signal. A "regression" is often the rule doing
  something harder and more valuable; a human/agent-in-loop judges. Revert = a new version
  copying the old definition (lineage preserved).

**Two modes, a maturity progression (build interactive first):**
- **Interactive (v2):** agent generates the review report, then you refine via conversation.
  Rich, no UI to build, freer rein since you're in the loop. This is the weekly "autopilot off"
  checkpoint.
- **Semi-autonomous (later):** same report layer, but proposals surface in the app UI for async
  override; can run weekly unattended. Built once you trust the proposals.

## Failure handling & operational reality

- **Action lifecycle:** `proposed → approved → applying → applied | failed`. Row exists before
  the Gmail mutation, so a crash never loses intent.
- **Per-action isolation:** one thread's failure doesn't abort the batch ("11 applied, 1 failed
  ▸ retry"). Retry is idempotent (check current Gmail state first; already-done = done).
- **Model-call failures:** affected threads stay uncovered, reappear next run (no mutation).
- **`failed` never counts toward promotion metrics.**
- **OAuth weekly reauth:** experimental Google apps expire the refresh token every ~7 days
  (`invalid_grant`). Detect at **run start**, surface a **"Reauthorize"** action, then continue —
  never a mid-run death, never pollutes metrics. This lands naturally on the **weekly analysis
  checkpoint** (reauth → run skill → review proposals = one ritual).

## Cold start

System has zero rules on day one. Universal path: **accumulate an uncovered pool → run the
analysis skill over it → get your real starter rules.**
- Seed only a **couple of obvious deterministic rules** (calendar cleanup, an obvious
  newsletter archive) so run #1 isn't empty.
- First instruction for everyone: run the skill over the pool before expecting much.
- Personal bootstrap: point the agent at the old **mailnick** system + your data to author the
  first rules — a richer version of the same first step.
- The first week is intentionally a training-data accumulation phase (value compounds).

## Data model (SQLite, sketch)

```
rules         : rule_id (PK, lineage), name, status (proposing|auto|suspended), current_version_id
rule_versions : version_id (PK), rule_id, version_no, priority, match (JSON), intent,
                action, tier, needs_body, created_at, created_by (human|skill), change_note, is_current
runs          : run_id (PK), started_at, ended_at, scope, status
actions       : action_id (PK), run_id, rule_id, rule_version_id, thread_id, message_ids (JSON),
                action, prior_state (JSON), source (deterministic|ai), confidence (high|med|low),
                mode (proposed|auto|manual), status (applied|rolled_back|failed),
                verdict (approve|amend_skip|reject|save|none), reject_reason, note,
                created_at, applied_at, rolled_back_at, error
verdicts/dedup: keyed on (thread_id, rule_version_id) so resolved threads aren't re-surfaced
```

## Build sequence

### v1 — the manual spine (replicates mailnick + captures training data)
1. **Gmail auth + reauth flow + fetch unread-in-inbox** (cap 200).
2. **SQLite schema:** rules / rule_versions / actions / runs.
3. **Deterministic tier + rule-centric loop with claim-and-remove** (2–3 hand-written rules).
4. **Review screen:** rule-grouped cards, Approve/Amend/Reject, actions log, rollback at
   run/batch/individual.
5. **Leftover area** with manual-disposition capture (training data) + Gmail handoff.

v1 is a usable manual triage tool with rollback, and it *generates the corpus* the learning
features need — so manual-first is the dependency order, not a compromise.

### v2+ — AI + learning (design settled, deferred)
- AI tier + confidence bands.
- Promotion gate + auto-apply + digest.
- Analysis skill (interactive first), per-version metrics.
- Semi-autonomous UI surfacing.

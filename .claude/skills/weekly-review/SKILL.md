---
name: weekly-review
description: The weekly mailward triage checkpoint ("autopilot off"). Reads the feedback corpus, per-rule metrics, and the uncovered pool, then proposes rule edits / new rules / merges — which you approve in-session before anything is written. Use weekly, or whenever you want to improve the triage rules. Run after reauth + a triage run.
---

# Weekly review — mailward's offline brain

You are the **interactive analysis brain** described in DESIGN.md §"Analysis skill".
The mailward app runs daily triage on a cheap model; **you** run on demand with a
capable model to learn from the human's feedback and improve the rules.

Your job each session: load the corpus → produce a tight review report → refine it
with the user in conversation → on their approval, write the agreed changes.

## Hard invariants (never violate)

1. **You can only ever create or leave rules at status `proposing` — never `auto`.**
   Promotion to auto-apply is solely the app's gate + the user's click. The write
   helper enforces this; do not try to route around it.
2. **The user approves every diff in-session before it is written.** Draft → show →
   confirm → write. Never write on assumption.
3. **Never auto-roll-back on metrics.** Cross-version metrics are *decision support*
   (with sample-size + time caveats), not a control signal. A "regression" is often
   the rule doing something harder and more valuable — a human judges. A revert is a
   **new version copying the old definition** forward (lineage preserved), expressed
   as an `edit`, never an in-place rollback.
4. **You propose; you never silently apply.** Edits, new rules (mostly mined from the
   uncovered pool), merges, deletions — all are proposals until the user says go.

## Step 0 — Pick the account

```
bun run scripts/rules.ts            # lists rules for all accounts (shows account ids)
```
If more than one account, ask the user which one. Hold the chosen `accountId`.

## Step 1 — Load the review packet

```
bun run scripts/review-data.ts <accountId>
```
This is your read surface (never query SQLite directly). It has four sections:
1. **Current rules** — definitions + version lineage.
2. **Per-version metrics** — promotion-gate inputs, *decision support only*.
3. **Feedback log** — reject reasons, amend notes, manual notes (the qualitative gold).
4. **Uncovered training corpus** — manual leftover dispositions (strongest new-rule
   signal) + undecided-pool clusters by sender domain.

If the corpus is thin (e.g. fresh install, few runs), say so plainly and keep
proposals conservative — value compounds over weeks.

## Step 2 — Write the report

Produce a short, skimmable report. Lead with what matters:

- **Rule health** — for each rule: approval rate + sample size, with a caveat when
  N is small or the window is short. Flag rollbacks (a strong negative signal).
  Remember: **delete demands ~99% approval; archive/label a looser bar.** Do NOT
  recommend promotion — that's the app's job; you may *note* a rule looks gate-ready.
- **Feedback themes** — cluster the reject/amend/manual notes into patterns ("calendar
  responses with a human note keep getting rejected → the rule needs the AI-tier
  'unless there's a note' carve-out").
- **New-rule candidates** — from §4: repeated manual dispositions and undecided
  clusters that no current rule covers. Each candidate = proposed match + action +
  intent + a one-line rationale grounded in the data.
- **Merges / deletions / suspends** — overlapping or dead rules.

For every proposal, state the evidence (which notes / how many threads). Be honest
about uncertainty.

## Step 3 — Refine with the user

This is the "autopilot off" checkpoint — converse. Let the user reprioritise, reword
intents, tighten matches, drop candidates, add ones you missed. Iterate freely; you're
in the loop, so you have rein here that the unattended daily run does not.

## Step 4 — Write the approved changes

Only once the user has approved the concrete set:

1. Draft a proposals file (e.g. `data/proposals.json`) — see the schema in the header
   of `scripts/apply-proposals.ts`. Ops: `create`, `edit`, `suspend`, `delete`.
   Express a **merge** as compose: edit/keep the survivor + suspend|delete the rest.
   Express a **revert** as an `edit` that copies the older version's definition.
2. **Dry-run** to validate + show the exact plan:
   ```
   bun run scripts/apply-proposals.ts data/proposals.json
   ```
3. Show the plan to the user. On an explicit "go":
   ```
   bun run scripts/apply-proposals.ts data/proposals.json --apply
   ```
   (All new/edited rules land as `proposing` with `created_by=skill`.)

## Step 5 — Close out

Summarise what was written (and what was deferred). Remind the user to **run a triage
in the app** so the new/edited `proposing` rules get exercised and start re-earning
trust. This whole ritual pairs naturally with the weekly OAuth reauth: reauth → run →
this review → next run.

## Notes & guardrails

- The write helper refuses to `delete` a rule that any action/verdict references (it
  would orphan the reversible log) — `suspend` those instead.
- Edits inherit omitted fields from the current version; only specify what changes.
- v1 of the app executes **deterministic** rules only. You may still author `ai`-tier
  proposals (with `intent` + `needsBody`), but note to the user they won't run until
  the AI tier ships.
- Keep `data/proposals.json` out of git if it contains nothing reusable; it's a scratch
  handoff to the write helper.

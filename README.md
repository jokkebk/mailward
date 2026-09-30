# Mailward

An email triage agent for unread Gmail. V3 assesses each thread once and lays
the results out on one review page. You decide what to do; Gmail changes are
logged and reversible.

See [DESIGN.md](DESIGN.md) for the full design and roadmap.

The [v3 architecture and implementation plan](V3.md) records the design. Git tag
`v2` preserves the rule-centric baseline, still available at `/v2` for comparison.

## V3 workflow

Open `/`, select your Gmail account, and choose **Check unread mail**. V3 fetches full
unread message content for new snapshots, prepares a bounded plain-text record,
and asks Jev six typed questions per thread in batches: category, attention,
retention, urgency, relevance, and evidence gap. A compact versioned policy is
shared once per batch. Up to four batches run concurrently. Missing or malformed
evidence stays unresolved. Existing snapshots are reused when the message,
policy, rubric, model, and relevant date context match.

The review page lists **Needs action**, **Worth checking out**, **Needs a
decision**, **Show before clearing**, **Archive** and **Trash**, then what was
applied. Rows sort by urgency (relevance for worthwhile reading) and carry a 0–3
importance signal; Archive and Trash are grouped by Jev's category. Each row's
toggle shows TODO, Archive, Trash, Leave and Done at once: a ring marks Jev's
proposal, a dashed ring its unconfirmed leaning on undecided rows, and a fill your
choice. Section buttons accept every remaining proposal at once. Done asks what
to do afterwards. Feedback chips and notes are optional. Keyboard: `j`/`k` move,
`y` accepts the suggestion, `t` `e` `#` `l` `d` choose, `o` opens, `?` lists keys.
**Apply** is the only Gmail mutation step; unapplied decisions survive a reload.
Choosing Trash on a visible show-before-clearing row records that you saw it.
Rows offer the exact representation Jev saw and an on-demand sanitized view of
the full conversation. Individual applied actions can be undone. V3 imports no
automation trust from legacy rules, and a new policy revision stays review-first.

For a fixture-only preview, run `bun run scripts/v3-fixture.ts /tmp/mailward-v3-fixture.db`
and start the app with `DATABASE_PATH=/tmp/mailward-v3-fixture.db` and dummy OAuth
environment values. The fixture cannot mutate live Gmail. For offline learning,
`DATABASE_PATH=... bun run v3-report <accountId>` prints policy lineage, assessment
mix, corrections, completion, execution, undo, and usage. Keep examples in a
separate local evaluation corpus and validate revisions against held-out cases.

V3 currently has no auto-apply or policy-promotion workflow. Explicit larger-
representation reassessment, richer calibration studies, and CLI/MCP adapters
remain follow-up work. Do not use the legacy v2 auto-apply mode as a substitute
for v3 review.

## Legacy v2 workflow

Mailward combines deterministic and AI rules, with a review step for proposals:

- Connect Gmail (OAuth) with weekly-reauth handling.
- **Run triage**: syncs unread-in-inbox (cap 300), evaluates rules in priority order
  with claim-and-remove, and presents proposals grouped by rule.
- **Approve / Amend / Reject** each group (Reject can also suspend the rule). "Save this
  one" excludes an item from future metrics.
- **Uncovered launchpad**: manually Archive / Trash / → TODO leftover threads (logged as
  training data), or open them in Gmail.
- **History + rollback** at run / batch / individual granularity (delete = trash, so undo
  = untrash).
- **Jev trial**: when `OPENROUTER_API_KEY` is configured, the run switch appears
  and defaults on. Switch it off to use the classifier selected by `AI_PROVIDER`.
  Jev trash suggestions always wait for review during the trial.

See DESIGN.md for the rule and promotion model.

## Setup

Requires [Bun](https://bun.sh).

```bash
bun install
cp .env.example .env   # then fill in (see below)
bun run dev            # http://localhost:4873
```

### Google OAuth

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com), enable the Gmail API.
2. Configure the OAuth consent screen. If audience is **External** / status **Testing**,
   add your account under **Test users**. (Testing-status apps expire the refresh token
   ~weekly — Mailward detects this and shows a **Reauthorize** button.)
3. Create OAuth 2.0 **Web application** credentials.
4. Add redirect URI `http://localhost:4873/auth/callback`.
5. Put the Client ID / Secret in `.env`.

You can reuse the same Google project as mailnick — just add the `:4873` redirect URI.

Set `OPENROUTER_API_KEY` in `.env` to show the Jev switch. Without it, the
existing `AI_PROVIDER` / model settings are used automatically.

## Tech stack

- **Runtime**: Bun · **Framework**: SvelteKit (Svelte 5 runes)
- **DB**: SQLite (`bun:sqlite`) + Drizzle ORM — one file, the whole system state
- **Gmail**: `googleapis` (thread-level actions)

## Layout

- `src/lib/server/gmail/` — OAuth, token refresh, reauth detection, thread-level actions, sync
- `src/lib/server/db/` — Drizzle schema (versioned rules, runs, actions, verdicts, AI cache)
- `src/lib/server/triage/` — rule resolution + seed, the rule-centric run loop, apply/undo
- `src/routes/api/` — run · decisions · leftover · undo · actions · rules
- `scripts/rules.ts` — text dump of current rules (`bun run rules <accountId>`)

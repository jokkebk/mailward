# Mailward 3.0

An email triage agent for unread Gmail. V3 assesses each thread once and lays
the results out on one review page. You decide what to do; Gmail changes are
logged and reversible.

See [DESIGN.md](DESIGN.md) for the current architecture and
[CONTEXT.md](CONTEXT.md) for domain language. V2 is retired to Git history;
the `v2` tag preserves the rule-centric baseline.

## Workflow

Open `/`, select your Gmail account, and choose **Check unread mail**. V3 fetches full
unread message content for new snapshots, prepares a bounded plain-text record,
and asks Jev six typed questions per thread: category, attention,
retention, urgency, relevance, and evidence gap. A compact versioned policy is
included once per request. Each request assesses one thread; up to four requests
run concurrently. Missing or malformed
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

V3 currently has no auto-apply or policy-promotion workflow. Explicit larger
representations, richer calibration studies, and CLI/MCP adapters remain
follow-up work.

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

Set `OPENROUTER_API_KEY` in `.env` to assess mail with Jev through OpenRouter.
It is the only assessment provider used by the app.

## Fixture preview and verification

```bash
bun run scripts/v3-fixture.ts /tmp/mailward-v3-fixture.db
DATABASE_PATH=/tmp/mailward-v3-fixture.db GOOGLE_CLIENT_ID=fixture GOOGLE_CLIENT_SECRET=fixture GOOGLE_REDIRECT_URI=http://localhost:4873/auth/callback bun run dev
```

The fixture supports reviewing the UI without usable Gmail credentials. Do not
apply fixture decisions or check new mail. Never test against the live database.
Run `bun test` and `bun run check`; use the same fixture environment for
`bun run build`, since the build initializes the server.

## Weekly policy review

Invoke `$weekly-review` in this repository, or ask for a weekly v3 review. The
[skill](.agents/skills/weekly-review/SKILL.md) reads feedback, investigates cases,
and proposes compact policy changes for approval. It is also available to Claude
through the repository's `.claude/skills/weekly-review/` entry.

```bash
bun run v3-report <accountId> --days 7
bun run v3-report <accountId> --days 30 --json
bun run v3-report <accountId> --case <assessmentId>
```

Reports separate agreement by policy, rubric, model and source. Done, Leave and
unresolved decisions do not count as classifier corrections; undo and execution
failures are separate signals. Exact stored email evidence is available on demand.
The report is read-only and makes no Gmail or Jev calls.

`bun run v3-policy data/proposal.json` previews a replacement; adding `--apply`
appends the approved policy revision and rejects stale proposals. Keep private
proposals and evaluation corpora outside Git. Validate revisions on held-out cases;
reviewed-choice agreement is not an inbox-wide accuracy measure.

Existing accounts reuse their stored v3 policies. New accounts receive a generic
starter policy; normal app startup and runs never consult v2 rules or verdicts.
See [DESIGN.md](DESIGN.md) for the historical snapshot evaluation/replay tools.

## Tech stack

- **Runtime**: Bun · **Framework**: SvelteKit (Svelte 5 runes)
- **DB**: SQLite (`bun:sqlite`) + Drizzle ORM — one file, the whole system state
- **Gmail**: `googleapis` (thread-level actions)

## Layout

- `src/lib/server/v3/` — policy, representation, assessment, deterministic calendar rule, review service
- `src/lib/v3/review.ts` — review sections, grouping, ranking, decision helpers
- `src/lib/components/` — review rows, action controls, icons
- `src/lib/server/gmail/` — OAuth, reauth, thread operations, action ledger and undo, content sanitization
- `src/lib/server/db/` — active and historical schema; migrations remain in `drizzle/`
- `src/routes/api/v3/` — run, review, conversation content, undo
- `scripts/v3-*.ts` — fixtures, reports, private snapshot evaluation and replay

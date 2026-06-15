# Mailward

An email triage agent for cleaning up Gmail unread mail. You run it; it proposes
deletion / archival / labelling against triage rules; you approve, amend, or reject.
Proven rules later graduate to auto-apply. Everything is logged and reversible.

See [DESIGN.md](DESIGN.md) for the full design and roadmap.

## Status: v1 — manual spine

v1 is a usable manual triage tool that also captures the training corpus the later
AI/learning features need:

- Connect Gmail (OAuth) with weekly-reauth handling.
- **Run triage**: syncs unread-in-inbox (cap 200), evaluates deterministic rules in
  priority order with claim-and-remove, and presents proposals grouped by rule.
- **Approve / Amend / Reject** each group (Reject can also suspend the rule). "Save this
  one" excludes an item from future metrics.
- **Uncovered launchpad**: manually Archive / Trash / → TODO leftover threads (logged as
  training data), or open them in Gmail.
- **History + rollback** at run / batch / individual granularity (delete = trash, so undo
  = untrash).

Deferred to v2+ (designed, not built): AI tier + confidence bands, promotion gate +
auto-apply digest, the analysis skill, per-version metrics. See DESIGN.md.

## Setup

Requires [Bun](https://bun.sh).

```bash
bun install
cp .env.example .env   # then fill in (see below)
bun run dev            # http://localhost:5173
```

### Google OAuth

1. Create a project at [console.cloud.google.com](https://console.cloud.google.com), enable the Gmail API.
2. Configure the OAuth consent screen. If audience is **External** / status **Testing**,
   add your account under **Test users**. (Testing-status apps expire the refresh token
   ~weekly — Mailward detects this and shows a **Reauthorize** button.)
3. Create OAuth 2.0 **Web application** credentials.
4. Add redirect URI `http://localhost:5173/auth/callback`.
5. Put the Client ID / Secret in `.env`.

You can reuse the same Google project as mailnick — just add the `:5173` redirect URI.

`GEMINI_API_KEY` is unused in v1 (no AI tier yet).

## Tech stack

- **Runtime**: Bun · **Framework**: SvelteKit (Svelte 5 runes)
- **DB**: SQLite (`bun:sqlite`) + Drizzle ORM — one file, the whole system state
- **Gmail**: `googleapis` (thread-level actions)

## Layout

- `src/lib/server/gmail/` — OAuth, token refresh, reauth detection, thread-level actions, sync
- `src/lib/server/db/` — Drizzle schema (versioned rules, runs, actions, verdicts)
- `src/lib/server/triage/` — rule resolution + seed, the rule-centric run loop, apply/undo
- `src/routes/api/` — run · decisions · leftover · undo · actions · rules
- `scripts/rules.ts` — text dump of current rules (`bun run rules <accountId>`)

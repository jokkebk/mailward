## Project: mailward

Email triage agent (the agentic successor to mailnick). You run it; it proposes
trash/archive/TODO actions against versioned rules; you approve/amend/reject; proven
rules graduate to auto-apply. All actions logged + reversible. See DESIGN.md.

- **Dev server**: `bun run dev` (port 4873)
- **Database**: `./data/emails.db` (SQLite). One file = whole system state.
- **Schema**: `src/lib/server/db/schema.ts` — snake_case columns. Key tables:
  `rules` (lineage + status), `rule_versions` (immutable defs), `runs`, `actions`
  (reversible log; `prior_state` is the undo payload; batch = `(run_id, rule_id)`),
  `verdicts` (dedup/training, keyed on `(thread_id, rule_version_id)`),
  `ai_classifications` (AI outcome cache, keyed on `(account_id, rule_version_id, thread_id)`).
- **Triage loop**: `src/lib/server/triage/run.ts` — rule-centric, priority order,
  claim-and-remove. v1 is deterministic-only + propose-only.
- **Gmail**: thread-level actions in `src/lib/server/gmail/thread-actions.ts`;
  reauth detection in `gmail/errors.ts` (`invalid_grant` → 401 `reauth_required`).
- **Rules text helper**: `bun run rules <accountId>`.
- **Conventions**: delete = trash (never permanent); archive/delete mark read;
  `label_todo` stays unread. Editing a rule appends a version + demotes to `proposing`.

## Project: mailward

Email triage agent (the agentic successor to mailnick). You run it; it proposes
trash/archive/TODO actions against versioned rules; you approve/amend/reject; proven
rules graduate to auto-apply. All actions logged + reversible. See DESIGN.md.

- **V3 review**: `/` is the default review-first app; `/v3` redirects there.
  `/v2` is the legacy rule view and can auto-apply promoted rules during triage.
  V3 assesses unread threads once with a compact policy and Jev; Review,
  Briefing, and Needs a decision share a reviewed set. A narrow versioned calendar-response rule produces the same reviewable verdicts
  without a Jev call; only rule verdicts show a source pill. Initial v3 never
  auto-applies. `src/lib/server/v3/service.ts` is the service boundary.
- **V3 tables**: `v3_policies`, `v3_assessments`, `v3_run_items`, `v3_reviews`,
  `v3_call_logs`; additive migrations `drizzle/0007_v3.sql` and `0008_v3_sources.sql`.
- **V3 fixture**: `bun run scripts/v3-fixture.ts /tmp/mailward-v3-fixture.db`.
  Never run implementation tests against the original live database.

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

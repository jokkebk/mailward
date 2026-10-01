## Project: mailward

Mailward 3.0 is a review-first email triage app. It assesses unread Gmail threads
against a compact versioned policy, proposes handling, and applies only explicit
review decisions. Actions are logged and reversible. See DESIGN.md and CONTEXT.md.

- **Review UI**: `/` is the app; `/v3` redirects there. V2 is retired to Git history.
  Grouping/ordering lives in `src/lib/v3/review.ts`; shared rows and controls in
  `src/lib/components/`. Preserve the current visual design when changing behavior.
- **Service boundary**: `src/lib/server/v3/service.ts` owns assessment runs, cached
  snapshots, inspection, review validation, execution, and undo. `/api/v3/` routes
  are adapters. Jev assesses one thread per request, with four concurrent requests.
- **Deterministic rule**: `src/lib/server/v3/deterministic.ts` handles bare calendar
  responses. Its versioned verdicts require review and form a collapsed group.
  There is no auto-apply or promotion workflow.
- **Dev server**: `bun run dev` (port 4873). Checks: `bun test`, `bun run check`,
  `bun run build`.
- **Database**: `DATABASE_PATH` defaults to `./data/emails.db` (SQLite). Schema:
  `src/lib/server/db/schema.ts`, snake_case columns. Active tables include tokens,
  threads, runs, run_steps, actions, v3_policies, v3_assessments, v3_run_items,
  v3_reviews, and v3_call_logs. Legacy tables and all migrations remain for stored
  history and snapshot comparisons; do not drop historical data.
- **Fixture**: `bun run scripts/v3-fixture.ts /tmp/mailward-v3-fixture.db`.
  Never run implementation tests against the original live database. Use a
  separate DATABASE_PATH for fixture previews and builds that initialize the app.
- **Gmail execution**: `src/lib/server/gmail/execution.ts` is the reversible ledger;
  `gmail/thread-actions.ts` supplies thread operations. Delete means trash, never
  permanent deletion. Archive marks read; Trash preserves Gmail message read state;
  TODO stays unread. `prior_state` is the undo payload.
- **Reauth**: `gmail/errors.ts` maps invalid_grant to reauth_required; token cleanup
  and OAuth handling remain in gmail/.
- **Weekly review**: `.agents/skills/weekly-review/SKILL.md` (Claude entry links
  to the same file). Invoke `$weekly-review` to analyze feedback and propose a
  policy diff; `bun run v3-policy proposal.json` previews it, `--apply` appends an
  approved revision with a stale-policy check. Do not tune live policy merely
  because the skill or helper is being implemented.
- **Policy selection**: Existing v3 policies are reused; new accounts receive a
  generic starter. Daily runtime never reads v2 rules or verdicts.
- **Offline report**: `DATABASE_PATH=... bun run v3-report <accountId> --days 7` is read-only;
  `--case` retrieves exact stored evidence.
  Policy edits append revisions; completion and correction are distinct feedback.
  Keep private evaluation corpora/results outside Git.

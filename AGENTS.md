# Mailward developer guide

Mailward is a review-first email triage app. It assesses unread Gmail threads
against a compact versioned policy, proposes handling, and applies only explicit
review decisions. Actions are logged and reversible. [README.md](README.md) is the
user guide; [DESIGN.md](DESIGN.md) describes the architecture and
[CONTEXT.md](CONTEXT.md) defines the domain language.

## Commands

- `bun run dev`: dev server on port 4873.
- `bun run demo`: rebuilds the sample inbox in `/tmp/mailward-demo.db` and
  serves it. Gmail is not called.
- Checks: `bun test`, `bun run check`, `bun run build`. The build initializes the
  server, so run it with a fixture `DATABASE_PATH`.
- Fixture at any path: `bun run scripts/v3-fixture.ts /tmp/mailward-v3-fixture.db`.
  The fixture is also the demo data, so keep it realistic and free of personal details.

## Safety

- Never run implementation tests, builds or previews against the live database
  (`./data/emails.db`). Use a separate `DATABASE_PATH`.
- Do not apply fixture decisions or check new mail from a fixture preview.
- Delete means Gmail trash, never permanent deletion.
- Do not drop historical tables or rewrite old migrations.
- Do not tune the live policy merely because the weekly-review skill or a helper
  is being implemented.
- Keep private evaluation corpora, proposals and results outside Git.

## Map

- **Review UI**: `/` is the app; `/v3` redirects there. Grouping and ordering live in
  `src/lib/v3/review.ts`; rows and controls are in `src/lib/components/`. Preserve
  the current visual design when changing behavior.
- **Service boundary**: `src/lib/server/v3/service.ts` owns assessment runs, cached
  snapshots, inspection, review validation, execution, and undo. `/api/v3/` routes
  are adapters. Jev assesses one thread per request, with four concurrent requests.
- **Assessment**: `v3/representation.ts` builds the bounded record Jev sees;
  `v3/assessment.ts` holds the six questions, the OpenRouter call, and
  `resolveHandling`, which maps answers to a section and proposal.
- **Recipes**: JSON metadata filters in `v3_recipes`, matched by the generic handler in
  `src/lib/server/v3/recipes.ts`; the first active match skips Jev and proposes Trash,
  Archive or TODO for review. The shipped catalogue is `src/lib/server/v3/recipes/*.json`
  (adopting copies a recipe into the account). There is no auto-apply or promotion workflow.
- **Settings**: `/settings` edits guidance cards (the policy), recipes and history, and
  runs first-time setup for new accounts. `src/lib/server/v3/settings.ts` owns it;
  `/api/v3/settings` is the adapter. Jev's questions are shown read-only.
- **Policy selection**: Existing policies are reused. New accounts go through setup
  (or get the starter guidance and recommended recipes if a run starts first). The
  policy is stored as guidance cards; only enabled card bodies reach Jev, titles never.
  Title-only edits update the current version in place so cached assessments stay valid.
- **Gmail execution**: `src/lib/server/gmail/execution.ts` is the reversible ledger;
  `gmail/thread-actions.ts` supplies thread operations. Archive marks read; Trash
  preserves Gmail message read state; TODO stays unread. `prior_state` is the undo payload.
- **Reauth**: `gmail/errors.ts` maps invalid_grant to reauth_required; token
  handling and OAuth remain in `gmail/`.
- **Database**: `DATABASE_PATH` defaults to `./data/emails.db` (SQLite). Schema:
  `src/lib/server/db/schema.ts`, snake_case columns. Active tables are tokens,
  threads, runs, run_steps, actions, v3_policies, v3_recipes, v3_assessments,
  v3_run_items, v3_reviews and v3_call_logs. Legacy tables and all migrations remain
  for stored history and snapshot comparisons. The daily runtime never reads legacy rules or verdicts.

## Making changes

Start with the closest existing test in `tests/` and keep tests next to the
behavior they cover (`v3.test.ts` for assessment, representation and execution;
`v3-review.test.ts` for review flow; `v3-ui.test.ts` for display helpers;
`v3-settings.test.ts` for settings and recipes).

- **A new recipe** is data, not code. Write a JSON spec, then dry-run and adopt it
  with `bun run v3-recipe <accountId> recipe.json [--apply]`. To ship it to new
  accounts, add it to `src/lib/server/v3/recipes/`.
- **A recipe field or operator**: add a field to `RECIPE_FIELDS`, with its
  value in `facts()`, or add an operator to `OPERATORS` and `test()` in
  `recipes.ts`. Add one only when a recipe cannot be expressed otherwise.
- **Jev's questions or options** (`assessment.ts`): bump `RUBRIC_VERSION`. The
  cache key includes it, so the next run reassesses. Update `parseAssessment`,
  `resolveHandling` and the fixture's answer options to match.
- **What Jev sees** (`representation.ts`): bump `REPRESENTATION_VERSION` so
  stored representations are rebuilt instead of reused.
- **Starter guidance and setup** live in `v3/policy.ts` and `v3/settings.ts`.
  The starter guidance must stay generic: no names, companies or personal rules.
- **Sections, ordering and grouping**: change `src/lib/v3/review.ts`. The resolver
  decides the section, and `review.ts` decides placement and the suggested
  choice (`suggestionOf`).
- **A Gmail action**: add the operation and its inverse to `gmail/thread-actions.ts`,
  then handle both in `applyThreadAction` and `undoAction` (`execution.ts`). Every
  action must be reversible from its stored `prior_state`.
- **Schema**: edit `db/schema.ts`, then `bunx drizzle-kit generate`. Migrations apply
  at startup; never edit an existing migration.
- **UI**: verify against the demo (`bun run demo`). `docs/demo.png` is a recording
  of that data, so re-record it if the review page changes visibly.

## Weekly review and offline tools

The weekly-review skill is in `.agents/skills/weekly-review/SKILL.md`; the
Claude entry links to the same file. Invoke `$weekly-review` to analyze
feedback and propose a policy diff.

- `DATABASE_PATH=... bun run v3-report <accountId> --days 7` is read-only. It
  reports agreement by policy, rubric, model and source, plus corrections, usage
  and undo. `--case <assessmentId>` retrieves exact stored evidence.
- `bun run v3-policy proposal.json` previews a replacement policy (full `text`
  or `cards`). `--apply` appends an approved revision after a stale-policy check.
- Policy edits append revisions. Completion (Done) and correction are distinct
  feedback, and Done, Leave and unresolved rows stay out of agreement denominators.
- `scripts/v3-evaluate.ts`, `v3-publish-replay.ts` and `v3-rule-replay.ts`
  replay private corpora; see DESIGN.md.

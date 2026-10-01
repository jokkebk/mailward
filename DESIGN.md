# Mailward 3.0

Mailward assesses unread Gmail threads, proposes handling, and waits for explicit
review before changing Gmail. The daily flow is fetch → bounded representation →
assessment → handling proposal → review → reversible execution.

## Assessment

`src/lib/server/v3/service.ts` owns runs, cached assessments, content inspection,
review validation, execution, and undo. SvelteKit's `/api/v3/` handlers adapt that
service for the review page at `/`; `/v3` redirects to `/`.

A run scans unread inbox messages from the last 30 days, with a default limit of
100 threads and a maximum of 200. New snapshots fetch full content for up to four
unread messages per thread. The deterministic representation keeps headers,
bounded body text, meaningful links, calendar details, and explicit flags for
clipping, omitted unread messages, unread attachments, and unavailable content.
It does not fetch conversation history for assessment. Human inspection can load
the full conversation on demand, with sanitized HTML in a sandboxed frame.

A narrow, versioned deterministic rule handles bare calendar responses. Human
notes, missing content, ordinary invitations, documents, and mixed-message
threads fall through to Jev. Deterministic verdicts remain reviewable and form
a collapsed group on the review page.

Jev answers six typed questions: category, attention, retention, urgency,
relevance, and evidence gap. Each request assesses one thread with all six
questions and the compact policy; up to four requests run concurrently. Thread
isolation avoids the cross-thread interference observed in the September audit.
See [the quality audit](docs/v3-quality-audit-2026-09-30.md) for its evidence and
limitations.

Assessments preserve distributions and the exact representation. Cache identity
includes input, policy, rubric, model, and relevant date context. Representation
reuse avoids repeated body fetches. Missing or malformed answers stay unresolved
and can be retried. Failed calls do not erase successful rows.

## Handling and review

The deterministic resolver separates current attention from eventual retention:

- Action or reply becomes **Needs action**, proposed as TODO.
- Worthwhile reading becomes **Worth checking out**, also proposed as TODO.
- A glance before disposal becomes **Show before clearing**.
- No attention plus retention becomes **Archive**; disposable mail becomes **Trash**.
- Conflicting evidence or material uncertainty becomes **Needs a decision**.

`src/lib/v3/review.ts` assigns every live row to one section and orders/groups
it. Obligations sort by urgency, worthwhile reading by relevance. Archive and
Trash group by category. Rows stay in place while draft decisions change.
Applied, failed, and undone receipts reflect the execution ledger.

Rows offer TODO, Archive, Trash, Leave, and Done. Done records satisfied attention
and requires explicit final handling. A different disposition is instance
feedback; optional chips and notes add context. Completion is distinct from a
classifier correction. Leave records review without a fabricated Gmail action.

Draft choices persist locally across reloads. **Apply** submits the reviewed set.
The service validates account/run membership, duplicate decisions, prior reviews,
current unread message IDs, and show-before-clearing acknowledgement before
execution. Gmail failures are isolated per action; OAuth failures surface as
`reauth_required`. Show-before-clearing requires human acknowledgement, not merely
an assessment by the model.

There is no auto-apply or policy-promotion workflow. Existing automation trust is
never inherited by a policy revision.

## Gmail and persistence

SQLite is the whole durable system state. `DATABASE_PATH` defaults to
`./data/emails.db`. Drizzle migrations are applied at startup, and stale running
sessions older than two hours are marked failed. Migration history is retained
so both existing installations and empty fixture databases remain supported.

Active records are `tokens`, `threads`, `runs`, `run_steps`, `actions`, plus
`v3_policies`, `v3_assessments`, `v3_run_items`, `v3_reviews`, and `v3_call_logs`.
Assessment, review, and Gmail execution are separate records. Policies are
versioned; reviews retain actor/provenance and link to action receipts.

`src/lib/server/gmail/execution.ts` applies thread-level actions and records
`prior_state` for undo. Archive clears INBOX and UNREAD; Trash uses Gmail trash,
never permanent deletion; TODO adds the label and preserves unread state. Undo
uses the stored payload and Gmail inverses. Trash/untrash preserves Gmail's
message read states. OAuth refresh and reauthorization live in `gmail/`.

V2's rule engine, UI, APIs, classifiers, and maintenance scripts are retired to
Git history (the `v2` tag records the baseline). Legacy rule, proposal, verdict,
classification, and telemetry tables remain for historical records and snapshot
comparisons. Existing accounts reuse their stored v3 policy; new accounts receive
a generic starter policy. The daily app never reads legacy rules or verdicts.
Schema cleanup must not drop historical records or rewrite old migrations.

## Offline learning and tooling

`bun run v3-report <accountId> --days 7` reads current policy text, lineage,
assessment mix, reviewed-choice agreement by policy/rubric/model/source,
corrections, completion, usage, execution, and undo. `--case` retrieves the exact
stored evidence without Gmail calls. The repository weekly-review skill uses
these helpers to propose compact improvements for approval. Done, Skip and
unresolved reviews stay outside agreement denominators; deterministic verdicts
are separate from Jev. A capable agent can propose bounded policy revisions
using this evidence. `createPolicyRevision` appends a
new review-first version; `v3-policy` previews a full replacement, then atomically
checks the expected policy ID before applying an approved revision. No scheduled
learner modifies production prompts.

Evaluation scripts capture/replay private corpora, publish evaluated snapshots
as new review-only runs, or replay deterministic rules. Keep corpora/results
outside Git. Historical v2 suggestions are comparisons, not ground truth.
Replayed snapshots remain subject to current-message validation when applied.

Explicit reassessment with a larger representation, calibration on held-out
cases, and CLI/MCP adapters remain follow-up work.

## Development verification

Run `bun test`, `bun run check`, and `bun run build`. Tests cover representation
safety, missing evidence, calendar handling, resolver mappings, migration/policy
bootstrap, cached retries, stale/duplicate reviews, completion, acknowledgement,
undo, and section/group ordering.

Never run implementation tests against the original live database. Preview with
`scripts/v3-fixture.ts` and a separate `DATABASE_PATH`; fixtures contain no usable
Gmail credentials. See [README](README.md) for setup and preview commands.

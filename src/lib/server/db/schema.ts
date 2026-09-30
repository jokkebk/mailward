import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

/**
 * Mailward schema.
 *
 * Design (see DESIGN.md):
 * - Rules are VERSIONED: `rules` holds stable lineage + operational status,
 *   `ruleVersions` holds immutable definition snapshots. Every action records
 *   the exact `ruleVersionId` that produced it -> per-version performance lineage.
 * - A `run` is one launch-to-close triage session.
 * - `actions` is the unified, reversible log; each row stores `priorState` so
 *   undo is exact at run / batch / individual granularity.
 * - `verdicts` capture the dedup + training signal keyed on (thread, ruleVersion),
 *   including decisions that produced no Gmail mutation (reject / save-this-one).
 *
 * Column names are snake_case in SQLite.
 */

export const tokens = sqliteTable('tokens', {
	id: text('id').primaryKey(), // account email
	accessToken: text('access_token').notNull(),
	refreshToken: text('refresh_token').notNull(),
	expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull()
});

/** One row per Gmail thread we have seen in a triage run. */
export const threads = sqliteTable('threads', {
	id: text('id').primaryKey(), // Gmail thread id
	accountId: text('account_id')
		.notNull()
		.references(() => tokens.id),
	from: text('from').notNull(),
	fromDomain: text('from_domain').notNull(),
	to: text('to'),
	subject: text('subject'),
	snippet: text('snippet'),
	receivedAt: integer('received_at', { mode: 'timestamp' }).notNull(),
	isUnread: integer('is_unread', { mode: 'boolean' }).default(true),
	labelIds: text('label_ids'), // JSON array of the thread's current labels
	messageIds: text('message_ids'), // JSON array of message ids in the thread
	rawHeaders: text('raw_headers'), // JSON, latest message headers (debugging)
	// Cheap computed signals (DESIGN.md §"Model payload"): prefilter inputs + AI payload.
	hasUnsubscribe: integer('has_unsubscribe', { mode: 'boolean' }).default(false),
	isCalendarInvite: integer('is_calendar_invite', { mode: 'boolean' }).default(false),
	syncedAt: integer('synced_at', { mode: 'timestamp' }).notNull()
});

/** Stable rule lineage + operational state. Definition lives in ruleVersions. */
export const rules = sqliteTable('rules', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	accountId: text('account_id')
		.notNull()
		.references(() => tokens.id),
	name: text('name').notNull(),
	status: text('status').notNull().default('proposing'), // 'proposing' | 'auto' | 'suspended'
	currentVersionId: text('current_version_id'),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: integer('updated_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

/** Immutable definition snapshots. Editing a rule appends a new version. */
export const ruleVersions = sqliteTable('rule_versions', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	ruleId: text('rule_id')
		.notNull()
		.references(() => rules.id),
	versionNo: integer('version_no').notNull(),
	priority: integer('priority').notNull(), // lowest number wins
	matchCriteria: text('match_criteria').notNull(), // JSON (structured prefilter)
	intent: text('intent'), // natural-language intent (used by AI tier later)
	// Deterministic rules: a single action string ('archive'|'trash'|'label_todo').
	// AI router rules: a JSON array of the dispositions the model may assign, e.g.
	// '["trash","label_todo"]'. 'leave' (don't claim) is always implicit, never stored.
	action: text('action').notNull(),
	tier: text('tier').notNull().default('deterministic'), // 'deterministic' | 'ai'
	needsBody: integer('needs_body', { mode: 'boolean' }).default(false),
	createdBy: text('created_by').notNull().default('human'), // 'human' | 'skill'
	changeNote: text('change_note'),
	isCurrent: integer('is_current', { mode: 'boolean' }).default(true),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
}, (t) => ({
	ruleIdx: index('idx_rule_versions_rule').on(t.ruleId)
}));

/** One triage session. */
export const runs = sqliteTable('runs', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	accountId: text('account_id')
		.notNull()
		.references(() => tokens.id),
	startedAt: integer('started_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),
	endedAt: integer('ended_at', { mode: 'timestamp' }),
	scope: text('scope'), // e.g. 'unread-in-inbox cap 200'
	status: text('status').notNull().default('running') // 'running' | 'completed' | 'failed' | 'reauth_required'
});

/** Progress + profiling events emitted while a run is executing. */
export const runSteps = sqliteTable('run_steps', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	runId: text('run_id')
		.notNull()
		.references(() => runs.id),
	accountId: text('account_id')
		.notNull()
		.references(() => tokens.id),
	stage: text('stage').notNull(),
	status: text('status').notNull().default('running'), // 'running' | 'completed' | 'failed'
	ruleId: text('rule_id'),
	ruleVersionId: text('rule_version_id'),
	ruleName: text('rule_name'),
	batchIndex: integer('batch_index'),
	batchTotal: integer('batch_total'),
	current: integer('current').default(0),
	total: integer('total'),
	matchedCount: integer('matched_count'),
	claimedCount: integer('claimed_count'),
	bodyFetchCount: integer('body_fetch_count'),
	aiBatchCount: integer('ai_batch_count'),
	durationMs: integer('duration_ms'),
	error: text('error'),
	metadata: text('metadata'), // JSON; counters and diagnostics only, no message bodies/prompts
	startedAt: integer('started_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: integer('updated_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),
	endedAt: integer('ended_at', { mode: 'timestamp' })
}, (t) => ({
	runIdx: index('idx_run_steps_run').on(t.runId),
	runStatusIdx: index('idx_run_steps_run_status').on(t.runId, t.status),
	runRuleIdx: index('idx_run_steps_run_rule').on(t.runId, t.ruleId)
}));

/** Per-provider AI call usage. Stores usage/cost signals, never prompts or responses. */
export const aiCallLogs = sqliteTable('ai_call_logs', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	runId: text('run_id')
		.notNull()
		.references(() => runs.id),
	accountId: text('account_id')
		.notNull()
		.references(() => tokens.id),
	ruleId: text('rule_id').notNull(),
	ruleVersionId: text('rule_version_id').notNull(),
	ruleName: text('rule_name').notNull(),
	provider: text('provider').notNull(),
	model: text('model').notNull(),
	batchIndex: integer('batch_index').notNull(),
	batchTotal: integer('batch_total').notNull(),
	threadCount: integer('thread_count').notNull(),
	promptChars: integer('prompt_chars').notNull().default(0),
	responseChars: integer('response_chars').notNull().default(0),
	promptTokens: integer('prompt_tokens'),
	responseTokens: integer('response_tokens'),
	totalTokens: integer('total_tokens'),
	durationMs: integer('duration_ms').notNull(),
	status: text('status').notNull(), // 'completed' | 'failed'
	error: text('error'),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
}, (t) => ({
	runIdx: index('idx_ai_call_logs_run').on(t.runId),
	runRuleIdx: index('idx_ai_call_logs_run_rule').on(t.runId, t.ruleId)
}));

/**
 * Stable per-thread AI classification cache keyed by the exact rule version.
 * This is separate from proposals: proposals are the current review surface for
 * one run, while this table prevents re-paying the model for the same
 * (thread, rule version, classifier) outcome across later runs. Stores `leave` too.
 */
export const aiClassifications = sqliteTable('ai_classifications', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	accountId: text('account_id')
		.notNull()
		.references(() => tokens.id),
	ruleId: text('rule_id').notNull(),
	ruleVersionId: text('rule_version_id').notNull(),
	threadId: text('thread_id').notNull(),
	cacheKey: text('cache_key').notNull().default('legacy'),
	messageIds: text('message_ids'),
	action: text('action').notNull(), // 'archive' | 'trash' | 'label_todo' | 'leave'
	confidence: text('confidence').notNull(), // 'high' | 'med' | 'low'
	reason: text('reason'),
	sourceRunId: text('source_run_id').references(() => runs.id),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: integer('updated_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
}, (t) => ({
	accountRuleThreadUniq: uniqueIndex('idx_ai_classifications_account_rule_thread_model').on(
		t.accountId,
		t.ruleVersionId,
		t.threadId,
		t.cacheKey
	),
	ruleVersionIdx: index('idx_ai_classifications_rule_version').on(t.ruleVersionId)
}));

/** Unified, reversible action log. Batch = (runId, ruleId). */
export const actions = sqliteTable('actions', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	runId: text('run_id').references(() => runs.id),
	accountId: text('account_id')
		.notNull()
		.references(() => tokens.id),
	ruleId: text('rule_id'), // null for manual leftover dispositions
	ruleVersionId: text('rule_version_id'),
	threadId: text('thread_id').notNull(),
	messageIds: text('message_ids'), // JSON
	action: text('action').notNull(), // 'archive' | 'trash' | 'label_todo' | 'mark_read'
	priorState: text('prior_state').notNull(), // JSON undo payload: {isUnread, labelIds}
	source: text('source').notNull(), // 'deterministic' | 'ai' | 'manual'
	confidence: text('confidence'), // 'high' | 'med' | 'low' | null
	mode: text('mode').notNull(), // 'proposed' | 'auto' | 'manual'
	status: text('status').notNull().default('applied'), // 'applied' | 'rolled_back' | 'failed'
	verdict: text('verdict'), // 'approve' | 'correct' | 'amend_skip' | 'reject' | 'save' | 'manual'
	note: text('note'),
	error: text('error'),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),
	appliedAt: integer('applied_at', { mode: 'timestamp' }),
	rolledBackAt: integer('rolled_back_at', { mode: 'timestamp' })
}, (t) => ({
	runIdx: index('idx_actions_run').on(t.runId),
	runRuleIdx: index('idx_actions_run_rule').on(t.runId, t.ruleId)
}));

/**
 * Dedup + training signal keyed on (thread, ruleVersion). Records decisions
 * even when no Gmail mutation happened (reject / correct / save-this-one / amend-skip),
 * so resolved threads are not re-proposed for the same rule version.
 */
export const verdicts = sqliteTable('verdicts', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	accountId: text('account_id')
		.notNull()
		.references(() => tokens.id),
	threadId: text('thread_id').notNull(),
	ruleVersionId: text('rule_version_id').notNull(),
	ruleId: text('rule_id').notNull(),
	runId: text('run_id'),
	verdict: text('verdict').notNull(), // 'approve' | 'correct' | 'amend_skip' | 'reject' | 'save'
	excludeFromMetric: integer('exclude_from_metric', { mode: 'boolean' }).default(false),
	note: text('note'),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
}, (t) => ({
	threadVersionIdx: index('idx_verdicts_thread_version').on(t.threadId, t.ruleVersionId)
}));

/**
 * Per-thread classification produced AT RUN TIME, before any decision. Unlike
 * deterministic matches (recomputable for free), an AI verdict is expensive and
 * non-deterministic, so it must be persisted: the review UI + apply read it here,
 * reloads rehydrate from it, and a crash never loses intent (DESIGN.md lifecycle).
 * One row per (run, rule, thread). A `leave` disposition produces NO row — the
 * thread simply isn't claimed and falls through to lower-priority rules / uncovered.
 */
export const proposals = sqliteTable('proposals', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	runId: text('run_id').references(() => runs.id),
	accountId: text('account_id')
		.notNull()
		.references(() => tokens.id),
	ruleId: text('rule_id').notNull(),
	ruleVersionId: text('rule_version_id').notNull(),
	threadId: text('thread_id').notNull(),
	messageIds: text('message_ids'), // JSON
	action: text('action').notNull(), // disposition: 'archive' | 'trash' | 'label_todo'
	source: text('source').notNull(), // 'deterministic' | 'ai'
	confidence: text('confidence'), // 'high' | 'med' | 'low' | null (deterministic)
	reason: text('reason'), // model rationale (null for deterministic)
	status: text('status').notNull().default('proposed'), // 'proposed'|'applied'|'skipped'|'rejected'|'superseded'
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),
	decidedAt: integer('decided_at', { mode: 'timestamp' })
}, (t) => ({
	runIdx: index('idx_proposals_run').on(t.runId),
	runRuleThreadIdx: index('idx_proposals_run_rule_thread').on(t.runId, t.ruleId, t.threadId)
}));

/**
 * Per-(rule, disposition) promotion state. A router rule emits several dispositions;
 * each graduates independently with its own bar (trash ~99%, archive/label looser).
 * Reset to 'proposing' whenever a new rule version is created (must re-earn trust);
 * the gate computes its window from `actions`/`verdicts` of the CURRENT version only.
 */
export const ruleDispositions = sqliteTable('rule_dispositions', {
	id: text('id').primaryKey().$defaultFn(() => crypto.randomUUID()),
	ruleId: text('rule_id')
		.notNull()
		.references(() => rules.id),
	action: text('action').notNull(), // 'archive' | 'trash' | 'label_todo'
	status: text('status').notNull().default('proposing'), // 'proposing' | 'auto' | 'suspended'
	// Pinned to propose-only: never auto-apply, however good the metrics look.
	// For dispositions the human always wants to approve before they happen.
	manualOnly: integer('manual_only', { mode: 'boolean' }).notNull().default(false),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),
	updatedAt: integer('updated_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
}, (t) => ({
	ruleActionIdx: index('idx_rule_dispositions_rule_action').on(t.ruleId, t.action)
}));

/** V3 uses a compact policy and assessment snapshots without inventing rules. */
export const v3Policies = sqliteTable('v3_policies', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => tokens.id),
  versionNo: integer('version_no').notNull(),
  text: text('text').notNull(),
  rubricVersion: integer('rubric_version').notNull().default(1),
  status: text('status').notNull().default('proposed'),
  importReport: text('import_report'),
  createdBy: text('created_by').notNull().default('human'),
  createdAt: integer('created_at').notNull()
}, (t) => ({ accountVersion: uniqueIndex('idx_v3_policy_account_version').on(t.accountId, t.versionNo) }));

export const v3Assessments = sqliteTable('v3_assessments', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => tokens.id),
  threadId: text('thread_id').notNull(),
  inputKey: text('input_key').notNull(),
  policyId: text('policy_id').notNull().references(() => v3Policies.id),
  rubricVersion: integer('rubric_version').notNull(),
  model: text('model').notNull(),
  actualModel: text('actual_model'),
  representation: text('representation').notNull(),
  answers: text('answers'),
  proposedAction: text('proposed_action').notNull(),
  finalAction: text('final_action').notNull(),
  lane: text('lane').notNull(),
  reason: text('reason').notNull(),
  priority: real('priority').notNull().default(0),
  status: text('status').notNull(),
  error: text('error'),
  createdAt: integer('created_at').notNull()
}, (t) => ({ cache: index('idx_v3_assessment_cache').on(t.accountId, t.threadId, t.inputKey, t.policyId, t.rubricVersion, t.model) }));

export const v3RunItems = sqliteTable('v3_run_items', {
  runId: text('run_id').notNull().references(() => runs.id),
  assessmentId: text('assessment_id').notNull().references(() => v3Assessments.id)
}, (t) => ({ pk: primaryKey({ columns: [t.runId, t.assessmentId] }) }));

export const v3Reviews = sqliteTable('v3_reviews', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull().references(() => tokens.id),
  assessmentId: text('assessment_id').notNull().unique().references(() => v3Assessments.id),
  runId: text('run_id').notNull().references(() => runs.id),
  actor: text('actor').notNull(),
  kind: text('kind').notNull(),
  disposition: text('disposition').notNull(),
  finalDisposition: text('final_disposition'),
  acknowledged: integer('acknowledged').notNull().default(0),
  chip: text('chip'), note: text('note'),
  actionId: text('action_id').references(() => actions.id),
  executionStatus: text('execution_status').notNull(),
  error: text('error'),
  createdAt: integer('created_at').notNull()
}, (t) => ({ runIdx: index('idx_v3_reviews_run').on(t.runId) }));

export const v3CallLogs = sqliteTable('v3_call_logs', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  accountId: text('account_id').notNull().references(() => tokens.id),
  model: text('model').notNull(),
  threadCount: integer('thread_count').notNull(),
  promptChars: integer('prompt_chars').notNull(),
  inputTokens: integer('input_tokens'), outputTokens: integer('output_tokens'),
  durationMs: integer('duration_ms').notNull(),
  status: text('status').notNull(), error: text('error'),
  createdAt: integer('created_at').notNull()
});

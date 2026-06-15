import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

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
	action: text('action').notNull(), // 'archive' | 'trash' | 'label_todo'
	tier: text('tier').notNull().default('deterministic'), // 'deterministic' | 'ai'
	needsBody: integer('needs_body', { mode: 'boolean' }).default(false),
	createdBy: text('created_by').notNull().default('human'), // 'human' | 'skill'
	changeNote: text('change_note'),
	isCurrent: integer('is_current', { mode: 'boolean' }).default(true),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

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
	verdict: text('verdict'), // 'approve' | 'amend_skip' | 'reject' | 'save' | 'manual'
	note: text('note'),
	error: text('error'),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date()),
	appliedAt: integer('applied_at', { mode: 'timestamp' }),
	rolledBackAt: integer('rolled_back_at', { mode: 'timestamp' })
});

/**
 * Dedup + training signal keyed on (thread, ruleVersion). Records decisions
 * even when no Gmail mutation happened (reject / save-this-one / amend-skip),
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
	verdict: text('verdict').notNull(), // 'approve' | 'amend_skip' | 'reject' | 'save'
	excludeFromMetric: integer('exclude_from_metric', { mode: 'boolean' }).default(false),
	note: text('note'),
	createdAt: integer('created_at', { mode: 'timestamp' })
		.notNull()
		.$defaultFn(() => new Date())
});

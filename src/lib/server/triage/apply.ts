import { db } from '../db';
import { actions, rules, threads, verdicts } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import {
	archiveThread,
	labelThreadTodo,
	markThreadRead,
	modifyThreadLabels,
	trashThread,
	untrashThread
} from '../gmail/thread-actions';
import type { Confidence, RuleAction } from '$lib/types/rules';

type ActionVerb = RuleAction | 'mark_read';
type Mode = 'proposed' | 'auto' | 'manual';
type Source = 'deterministic' | 'ai' | 'manual';

interface ApplyOpts {
	accountId: string;
	runId: string | null;
	ruleId: string | null;
	ruleVersionId: string | null;
	threadId: string;
	action: ActionVerb;
	mode: Mode;
	source: Source;
	verdict: string;
	confidence?: Confidence | null;
	note?: string | null;
}

export interface ApplyOutcome {
	threadId: string;
	status: 'applied' | 'failed';
	actionId?: string;
	error?: string;
}

/** Apply one thread-level action, recording an exact undo payload. */
export async function applyThreadAction(opts: ApplyOpts): Promise<ApplyOutcome> {
	const row = await db
		.select()
		.from(threads)
		.where(and(eq(threads.id, opts.threadId), eq(threads.accountId, opts.accountId)))
		.get();
	if (!row) return { threadId: opts.threadId, status: 'failed', error: 'thread not found' };

	const priorLabels: string[] = row.labelIds ? JSON.parse(row.labelIds) : [];
	const priorState = { isUnread: row.isUnread, labelIds: priorLabels, addedLabelId: null as string | null };

	try {
		let nextUnread = row.isUnread ?? true;
		let nextLabels = [...priorLabels];

		switch (opts.action) {
			case 'archive':
				await archiveThread(opts.accountId, opts.threadId);
				nextUnread = false;
				nextLabels = nextLabels.filter((l) => l !== 'INBOX' && l !== 'UNREAD');
				break;
			case 'trash':
				await trashThread(opts.accountId, opts.threadId);
				nextUnread = false;
				break;
			case 'label_todo': {
				const labelId = await labelThreadTodo(opts.accountId, opts.threadId);
				priorState.addedLabelId = labelId;
				if (!nextLabels.includes(labelId)) nextLabels.push(labelId);
				if (!nextLabels.includes('TODO')) nextLabels.push('TODO');
				break; // stays unread by design
			}
			case 'mark_read':
				await markThreadRead(opts.accountId, opts.threadId);
				nextUnread = false;
				nextLabels = nextLabels.filter((l) => l !== 'UNREAD');
				break;
		}

		const inserted = await db
			.insert(actions)
			.values({
				runId: opts.runId,
				accountId: opts.accountId,
				ruleId: opts.ruleId,
				ruleVersionId: opts.ruleVersionId,
				threadId: opts.threadId,
				messageIds: row.messageIds,
				action: opts.action,
				priorState: JSON.stringify(priorState),
				source: opts.source,
				confidence: opts.confidence ?? null,
				mode: opts.mode,
				status: 'applied',
				verdict: opts.verdict,
				note: opts.note ?? null,
				createdAt: new Date(),
				appliedAt: new Date()
			})
			.returning({ id: actions.id })
			.get();

		await db
			.update(threads)
			.set({ isUnread: nextUnread, labelIds: JSON.stringify(nextLabels) })
			.where(eq(threads.id, opts.threadId));

		return { threadId: opts.threadId, status: 'applied', actionId: inserted.id };
	} catch (error) {
		// Re-throw reauth so the route can surface a 401; isolate other failures.
		if ((error as { code?: string })?.code === 'reauth_required') throw error;
		const msg = error instanceof Error ? error.message : String(error);
		const failed = await db.insert(actions).values({
			runId: opts.runId,
			accountId: opts.accountId,
			ruleId: opts.ruleId,
			ruleVersionId: opts.ruleVersionId,
			threadId: opts.threadId,
			messageIds: row.messageIds,
			action: opts.action,
			priorState: JSON.stringify(priorState),
			source: opts.source,
			confidence: opts.confidence ?? null,
			mode: opts.mode,
			status: 'failed',
			verdict: opts.verdict,
			error: msg,
			createdAt: new Date()
		}).returning({ id: actions.id }).get();
		return { threadId: opts.threadId, status: 'failed', actionId: failed.id, error: msg };
	}
}

/** Record a decision that produced no Gmail mutation (skip / save / reject). */
export async function recordVerdict(opts: {
	accountId: string;
	runId: string | null;
	ruleId: string;
	ruleVersionId: string;
	threadId: string;
	verdict: 'amend_skip' | 'save' | 'reject' | 'correct';
	note?: string | null;
}): Promise<void> {
	await db.insert(verdicts).values({
		accountId: opts.accountId,
		threadId: opts.threadId,
		ruleVersionId: opts.ruleVersionId,
		ruleId: opts.ruleId,
		runId: opts.runId,
		verdict: opts.verdict,
		excludeFromMetric: opts.verdict === 'save',
		note: opts.note ?? null,
		createdAt: new Date()
	});
}

/** Also record an "approve" verdict alongside an applied action, for dedup. */
export async function recordApproveVerdict(opts: {
	accountId: string;
	runId: string | null;
	ruleId: string;
	ruleVersionId: string;
	threadId: string;
	note?: string | null;
}): Promise<void> {
	await db.insert(verdicts).values({
		accountId: opts.accountId,
		threadId: opts.threadId,
		ruleVersionId: opts.ruleVersionId,
		ruleId: opts.ruleId,
		runId: opts.runId,
		verdict: 'approve',
		note: opts.note ?? null,
		createdAt: new Date()
	});
}

export async function suspendRule(accountId: string, ruleId: string): Promise<void> {
	await db
		.update(rules)
		.set({ status: 'suspended', updatedAt: new Date() })
		.where(and(eq(rules.id, ruleId), eq(rules.accountId, accountId)));
}

/**
 * Undo a suspension. Back to 'proposing', never straight to 'auto' — a rule that
 * was switched off has to earn auto-apply through the gate again.
 */
export async function resumeRule(accountId: string, ruleId: string): Promise<void> {
	const rule = await db
		.select({ id: rules.id })
		.from(rules)
		.where(and(eq(rules.id, ruleId), eq(rules.accountId, accountId)))
		.get();
	if (!rule) throw new Error('Rule not found for this account.');
	await db
		.update(rules)
		.set({ status: 'proposing', updatedAt: new Date() })
		.where(and(eq(rules.id, ruleId), eq(rules.accountId, accountId)));
}

/** Reverse a single applied action using its stored prior state. */
export async function undoAction(accountId: string, actionId: string): Promise<ApplyOutcome> {
	const action = await db
		.select()
		.from(actions)
		.where(and(eq(actions.id, actionId), eq(actions.accountId, accountId)))
		.get();
	if (!action) return { threadId: '', status: 'failed', error: 'action not found' };
	if (action.status !== 'applied') {
		return { threadId: action.threadId, status: 'failed', error: `not undoable (${action.status})` };
	}

	const prior = JSON.parse(action.priorState) as {
		isUnread: boolean;
		labelIds: string[];
		addedLabelId: string | null;
	};

	try {
		switch (action.action) {
			case 'archive': {
				const add = ['INBOX', ...(prior.isUnread ? ['UNREAD'] : [])];
				await modifyThreadLabels(accountId, action.threadId, add, []);
				break;
			}
			case 'trash':
				await untrashThread(accountId, action.threadId);
				break;
			case 'label_todo': {
				const remove = prior.addedLabelId ? [prior.addedLabelId] : [];
				if (remove.length) await modifyThreadLabels(accountId, action.threadId, [], remove);
				break;
			}
			case 'mark_read':
				if (prior.isUnread) await modifyThreadLabels(accountId, action.threadId, ['UNREAD'], []);
				break;
		}

		await db
			.update(actions)
			.set({ status: 'rolled_back', rolledBackAt: new Date() })
			.where(eq(actions.id, actionId));
		await db
			.update(threads)
			.set({ isUnread: prior.isUnread, labelIds: JSON.stringify(prior.labelIds) })
			.where(eq(threads.id, action.threadId));

		// Undoing an AUTO action puts the thread back in the unread pool, where the
		// same promoted rule would match and re-apply it on the next run — an undo
		// the user can never win. Record a metric-excluded verdict so the run loop's
		// dedup treats this (thread, version) as decided. The rollback itself is
		// already the gate's failure signal, so this must not double-count as one.
		if (action.mode === 'auto' && action.ruleId && action.ruleVersionId) {
			await db.insert(verdicts).values({
				accountId,
				threadId: action.threadId,
				ruleVersionId: action.ruleVersionId,
				ruleId: action.ruleId,
				runId: action.runId,
				verdict: 'save',
				excludeFromMetric: true,
				note: 'undone by hand after auto-apply',
				createdAt: new Date()
			});
		}

		return { threadId: action.threadId, status: 'applied', actionId };
	} catch (error) {
		if ((error as { code?: string })?.code === 'reauth_required') throw error;
		const msg = error instanceof Error ? error.message : String(error);
		return { threadId: action.threadId, status: 'failed', error: msg };
	}
}

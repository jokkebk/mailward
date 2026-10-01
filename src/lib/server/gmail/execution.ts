import { db } from '../db';
import { actions, threads } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import {
	archiveThread,
	labelThreadTodo,
	modifyThreadLabels,
	trashThread,
	untrashThread
} from '../gmail/thread-actions';
import type { Handling } from '$lib/types/v3';

type ActionVerb = Exclude<Handling, 'leave'>;

interface ApplyOpts {
	accountId: string;
	runId: string | null;
	threadId: string;
	action: ActionVerb;
	verdict: string;
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
		}

		const inserted = await db
			.insert(actions)
			.values({
				runId: opts.runId,
				accountId: opts.accountId,
				ruleId: null,
				ruleVersionId: null,
				threadId: opts.threadId,
				messageIds: row.messageIds,
				action: opts.action,
				priorState: JSON.stringify(priorState),
				source: 'manual',
				confidence: null,
				mode: 'manual',
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
			ruleId: null,
			ruleVersionId: null,
			threadId: opts.threadId,
			messageIds: row.messageIds,
			action: opts.action,
			priorState: JSON.stringify(priorState),
			source: 'manual',
			confidence: null,
			mode: 'manual',
			status: 'failed',
			verdict: opts.verdict,
			error: msg,
			createdAt: new Date()
		}).returning({ id: actions.id }).get();
		return { threadId: opts.threadId, status: 'failed', actionId: failed.id, error: msg };
	}
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
			case 'trash': {
				await untrashThread(accountId, action.threadId);
				// Gmail untrash removes TRASH but does not put the thread back in INBOX.
				// Trashing preserves each message's read state; avoid marking the whole
				// conversation unread when only some messages were unread before.
				if (prior.labelIds.includes('INBOX')) {
					await modifyThreadLabels(accountId, action.threadId, ['INBOX'], []);
				}
				break;
			}
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

		return { threadId: action.threadId, status: 'applied', actionId };
	} catch (error) {
		if ((error as { code?: string })?.code === 'reauth_required') throw error;
		const msg = error instanceof Error ? error.message : String(error);
		return { threadId: action.threadId, status: 'failed', error: msg };
	}
}

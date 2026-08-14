import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { and, eq } from 'drizzle-orm';

mock.module('$env/dynamic/private', () => ({ env: process.env }));

const dbPath = `/tmp/mailward-auto-apply-${process.pid}-${Date.now()}.db`;
process.env.DATABASE_PATH = dbPath;

/** Gmail calls the run would make, recorded instead of sent. */
const gmailCalls: string[] = [];
mock.module('../src/lib/server/gmail/thread-actions', () => ({
	async markThreadRead(_a: string, t: string) {
		gmailCalls.push(`read:${t}`);
	},
	async archiveThread(_a: string, t: string) {
		gmailCalls.push(`archive:${t}`);
	},
	async trashThread(_a: string, t: string) {
		gmailCalls.push(`trash:${t}`);
	},
	async untrashThread(_a: string, t: string) {
		gmailCalls.push(`untrash:${t}`);
	},
	async labelThreadTodo(_a: string, t: string) {
		gmailCalls.push(`todo:${t}`);
		return 'Label_TODO';
	},
	async modifyThreadLabels(_a: string, t: string) {
		gmailCalls.push(`labels:${t}`);
	}
}));

const { db } = await import('../src/lib/server/db');
const { actions, ruleDispositions, threads, tokens } = await import('../src/lib/server/db/schema');
const { createRule } = await import('../src/lib/server/triage/rules');
const { runTriage } = await import('../src/lib/server/triage/run');
const { undoAction } = await import('../src/lib/server/triage/apply');
const { loadAutoDigest } = await import('../src/lib/server/triage/auto');
const { setDispositionManualOnly, setDispositionStatus, dispositionMetrics } = await import(
	'../src/lib/server/triage/promotion'
);

const ACCOUNT = 'auto@example.com';

beforeAll(async () => {
	const sqlite = new Database(dbPath, { create: true });
	try {
		migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });
	} finally {
		sqlite.close();
	}
	await db.insert(tokens).values({
		id: ACCOUNT,
		accessToken: 'token',
		refreshToken: 'refresh',
		expiresAt: new Date(Date.now() + 60_000)
	});
});

// No afterAll unlink: `$lib/server/db` is a process-wide singleton bound to whichever
// test file resolved it first, so deleting this file's DB pulls the rug out from under
// any later test file sharing that connection. The temp file is left for the OS to
// reap; test isolation comes from using a dedicated accountId instead.

function threadRow(id: string) {
	return {
		id,
		accountId: ACCOUNT,
		from: 'noreply@ohdear.app',
		fromDomain: 'ohdear.app',
		to: 'me@example.com',
		subject: `Alert ${id}`,
		snippet: 'site is down',
		receivedAt: new Date('2026-08-01'),
		isUnread: true,
		labelIds: JSON.stringify(['INBOX', 'UNREAD']),
		messageIds: JSON.stringify([`msg-${id}`]),
		rawHeaders: JSON.stringify([]),
		hasUnsubscribe: false,
		isCalendarInvite: false,
		syncedAt: new Date('2026-08-01')
	};
}

/** Simulate the human's confirm click without having to earn 20 approvals first. */
async function forceAuto(ruleId: string) {
	await db
		.update(ruleDispositions)
		.set({ status: 'auto' })
		.where(and(eq(ruleDispositions.ruleId, ruleId), eq(ruleDispositions.action, 'trash')));
}

describe('auto-apply', () => {
	let alertRuleId = '';

	test('proposes while proposing, acts once promoted, and reports in the digest', async () => {
		const ruleId = (alertRuleId = await createRule(ACCOUNT, {
			name: 'OhDear alerts',
			priority: 10,
			action: 'trash',
			intent: 'Uptime alert noise.',
			matchCriteria: {
				type: 'all',
				conditions: [{ field: 'fromDomain', operator: 'contains', value: 'ohdear.app' }]
			}
		}));

		// A proposing disposition never acts on its own.
		await db.insert(threads).values(threadRow('t1'));
		const first = await runTriage(ACCOUNT, { sync: false });
		expect(first.proposals[0].threads.map((t) => t.id)).toEqual(['t1']);
		expect(first.autoDigest).toEqual([]);
		expect(gmailCalls).toEqual([]);

		// The gate refuses promotion until the record earns it.
		await expect(setDispositionStatus(ACCOUNT, ruleId, 'trash', 'auto')).rejects.toThrow(
			/Not eligible/
		);

		// Promoted: the next run acts instead of asking. t1's proposal was never decided,
		// and each run supersedes prior open proposals — so promotion also sweeps up the
		// pending backlog of that category rather than leaving it stranded in review.
		await forceAuto(ruleId);
		await db.insert(threads).values(threadRow('t2'));
		const second = await runTriage(ACCOUNT, { sync: false });
		expect([...gmailCalls].sort()).toEqual(['trash:t1', 'trash:t2']);
		expect(second.proposals).toEqual([]);
		expect(second.autoDigest).toHaveLength(1);
		expect(second.autoDigest[0].ruleName).toBe('OhDear alerts');
		expect(second.autoDigest[0].action).toBe('trash');
		expect(second.autoDigest[0].applied).toBe(2);
		expect(second.autoDigest[0].items.map((i) => i.threadId).sort()).toEqual(['t1', 't2']);

		// The action is logged as auto and is undoable.
		const row = await db
			.select()
			.from(actions)
			.where(and(eq(actions.threadId, 't2'), eq(actions.mode, 'auto')))
			.get();
		expect(row?.status).toBe('applied');
	});

	test('an auto action, once undone, is not re-applied on the next run', async () => {
		const row = await db
			.select()
			.from(actions)
			.where(and(eq(actions.threadId, 't2'), eq(actions.mode, 'auto')))
			.get();
		gmailCalls.length = 0;

		const outcome = await undoAction(ACCOUNT, row!.id);
		expect(outcome.status).toBe('applied');
		expect(gmailCalls).toEqual(['untrash:t2']);

		// The thread is back in the unread pool, and the rule still matches it — but the
		// run must not silently re-trash what the human just rescued.
		gmailCalls.length = 0;
		const third = await runTriage(ACCOUNT, { sync: false });
		expect(gmailCalls).toEqual([]);
		expect(third.proposals).toEqual([]);
		expect(third.autoDigest).toEqual([]);

		// The digest keeps the undone row, marked as such, rather than hiding it.
		const digest = await loadAutoDigest(ACCOUNT, row!.runId!);
		expect(digest[0].applied).toBe(1); // t1 still trashed
		expect(digest[0].rolledBack).toBe(1); // t2 rescued
		expect(digest[0].items.find((i) => i.threadId === 't2')?.status).toBe('rolled_back');

		// The rollback is the gate's single failure signal: the dedup verdict written by
		// the undo is metric-excluded, so one undo must not count as two failures.
		const metrics = await dispositionMetrics(ACCOUNT, alertRuleId, 'trash');
		expect(metrics.rolledBack).toBe(1);
		expect(metrics.failure).toBe(1);
		// The auto-applied actions are not evidence for their own promotion.
		expect(metrics.success).toBe(0);
	});

	test('a pinned disposition never auto-applies, even when promoted', async () => {
		const ruleId = await createRule(ACCOUNT, {
			name: 'Calendar invitations',
			priority: 20,
			action: 'trash',
			intent: 'Invitations need a human yes.',
			matchCriteria: {
				type: 'all',
				conditions: [{ field: 'subject', operator: 'startsWith', value: 'Invitation: ' }]
			}
		});
		await forceAuto(ruleId);
		await setDispositionManualOnly(ruleId, 'trash', true);

		// Pinning demotes it out of auto immediately...
		const metrics = await dispositionMetrics(ACCOUNT, ruleId, 'trash');
		expect(metrics.status).toBe('proposing');
		expect(metrics.manualOnly).toBe(true);
		expect(metrics.eligible).toBe(false);

		// ...and it cannot be promoted back while pinned.
		await expect(setDispositionStatus(ACCOUNT, ruleId, 'trash', 'auto')).rejects.toThrow(/pinned/);

		// A matching thread is proposed, never acted on. Sender is off-domain so the
		// higher-priority (and promoted) OhDear rule doesn't claim it first.
		await db.insert(threads).values({
			...threadRow('t3'),
			from: 'calendar-notification@google.com',
			fromDomain: 'google.com',
			subject: 'Invitation: standup'
		});
		gmailCalls.length = 0;
		const run = await runTriage(ACCOUNT, { sync: false });
		expect(gmailCalls).toEqual([]);
		const group = run.proposals.find((g) => g.name === 'Calendar invitations');
		expect(group?.threads.map((t) => t.id)).toEqual(['t3']);
	});

	test('a missing legacy disposition is not reported as ready or promoted successfully', async () => {
		const ruleId = await createRule(ACCOUNT, {
			name: 'Legacy rule without disposition row',
			priority: 30,
			action: 'trash',
			matchCriteria: {
				type: 'all',
				conditions: [{ field: 'fromDomain', operator: 'contains', value: 'legacy.example' }]
			}
		});
		await db
			.delete(ruleDispositions)
			.where(and(eq(ruleDispositions.ruleId, ruleId), eq(ruleDispositions.action, 'trash')));

		const metrics = await dispositionMetrics(ACCOUNT, ruleId, 'trash');
		expect(metrics.eligible).toBe(false);
		await expect(setDispositionStatus(ACCOUNT, ruleId, 'trash', 'auto')).rejects.toThrow(
			/Disposition not found/
		);
	});
});

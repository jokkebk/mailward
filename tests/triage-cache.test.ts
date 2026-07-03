import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { eq } from 'drizzle-orm';
import { unlinkSync } from 'fs';

mock.module('$env/dynamic/private', () => ({ env: process.env }));

const dbPath = `/tmp/mailward-ai-cache-${process.pid}-${Date.now()}.db`;
process.env.DATABASE_PATH = dbPath;
process.env.AI_PROVIDER = 'gemini';

const { db } = await import('../src/lib/server/db');
const { tokens, threads, aiClassifications } = await import('../src/lib/server/db/schema');
const { createRule } = await import('../src/lib/server/triage/rules');
const { runTriage } = await import('../src/lib/server/triage/run');
const { setClassifier } = await import('../src/lib/server/ai');

beforeAll(() => {
	const sqlite = new Database(dbPath, { create: true });
	try {
		migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });
	} finally {
		sqlite.close();
	}
});

afterAll(() => {
	setClassifier(null);
	try {
		unlinkSync(dbPath);
	} catch {
		/* best effort */
	}
});

function threadRow(id: string, receivedAt: Date) {
	return {
		id,
		accountId: 'cache@example.com',
		from: 'sales@example.org',
		fromDomain: 'example.org',
		to: 'me@example.com',
		subject: `Cold outreach ${id}`,
		snippet: 'Can we talk?',
		receivedAt,
		isUnread: true,
		labelIds: JSON.stringify(['INBOX', 'UNREAD']),
		messageIds: JSON.stringify([`msg-${id}`]),
		rawHeaders: JSON.stringify([]),
		hasUnsubscribe: true,
		isCalendarInvite: false,
		syncedAt: receivedAt
	};
}

describe('AI classification cache', () => {
	test('reruns classify only newly matched AI candidates while resurfacing cached proposals', async () => {
		await db.insert(tokens).values({
			id: 'cache@example.com',
			accessToken: 'token',
			refreshToken: 'refresh',
			expiresAt: new Date(Date.now() + 60_000)
		});
		await createRule('cache@example.com', {
			name: 'Cold outreach',
			priority: 10,
			matchCriteria: {
				type: 'all',
				conditions: [{ field: 'hasUnsubscribe', operator: 'is', value: true }]
			},
			intent: 'Cold sales outreach should be trashed.',
			action: ['trash'],
			tier: 'ai'
		});
		await db
			.insert(threads)
			.values([threadRow('thread-a', new Date('2026-07-01')), threadRow('thread-b', new Date('2026-07-02'))]);

		const calls: string[][] = [];
		setClassifier({
			async classify(req) {
				calls.push(req.threads.map((t) => t.threadId).sort());
				return {
					verdicts: req.threads.map((t) => ({
						threadId: t.threadId,
						action: 'trash',
						confidence: 'high',
						reason: 'cold outreach'
					})),
					usage: { provider: 'test', model: 'stub', promptChars: 0, responseChars: 0 }
				};
			}
		});

		const first = await runTriage('cache@example.com', { sync: false });
		expect(calls).toEqual([['thread-a', 'thread-b']]);
		expect(first.proposals[0].threads.map((t) => t.id).sort()).toEqual(['thread-a', 'thread-b']);

		await db.insert(threads).values(threadRow('thread-c', new Date('2026-07-03')));

		const second = await runTriage('cache@example.com', { sync: false });
		expect(calls).toEqual([['thread-a', 'thread-b'], ['thread-c']]);
		expect(second.proposals[0].threads.map((t) => t.id).sort()).toEqual([
			'thread-a',
			'thread-b',
			'thread-c'
		]);

		const cached = await db.select().from(aiClassifications).all();
		expect(cached).toHaveLength(3);

		await db
			.update(threads)
			.set({ messageIds: JSON.stringify(['msg-thread-a-new']) })
			.where(eq(threads.id, 'thread-a'));

		const third = await runTriage('cache@example.com', { sync: false });
		expect(calls).toEqual([['thread-a', 'thread-b'], ['thread-c'], ['thread-a']]);
		expect(third.proposals[0].threads.map((t) => t.id).sort()).toEqual([
			'thread-a',
			'thread-b',
			'thread-c'
		]);
	});
});

import { getGmailClient } from './client';
import { db } from '../db';
import { threads } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { MAX_THREADS_PER_RUN, SYNC_WINDOW_DAYS } from '$lib/constants';

function extractDomain(email: string): string {
	const match = email.match(/<(.+@(.+))>/);
	if (match) return match[2];
	const parts = email.split('@');
	return (parts.length > 1 ? parts[1] : email).trim().toLowerCase();
}

interface SyncResult {
	syncedCount: number;
	totalThreads: number;
}

/**
 * Sync unread-in-inbox threads (newest first, capped). One row per thread,
 * holding the latest message's metadata and the unread message ids.
 */
export async function syncUnreadInbox(accountId: string): Promise<SyncResult> {
	const gmail = await getGmailClient(accountId);

	const query = `is:unread in:inbox newer_than:${SYNC_WINDOW_DAYS}d`;
	const list = await gmail.users.messages.list({
		userId: 'me',
		q: query,
		maxResults: MAX_THREADS_PER_RUN
	});

	const messages = list.data.messages || [];

	// Group message ids by thread, preserving list order (newest first).
	const byThread = new Map<string, string[]>();
	const threadOrder: string[] = [];
	for (const m of messages) {
		if (!m.id || !m.threadId) continue;
		if (!byThread.has(m.threadId)) {
			byThread.set(m.threadId, []);
			threadOrder.push(m.threadId);
		}
		byThread.get(m.threadId)!.push(m.id);
	}

	let syncedCount = 0;
	for (const threadId of threadOrder.slice(0, MAX_THREADS_PER_RUN)) {
		const messageIds = byThread.get(threadId)!;
		// Representative = first (newest) unread message in the thread.
		const repId = messageIds[0];
		const full = await gmail.users.messages.get({
			userId: 'me',
			id: repId,
			format: 'metadata',
			metadataHeaders: ['From', 'To', 'Subject', 'Date']
		});

		const headers = full.data.payload?.headers || [];
		const get = (n: string) => headers.find((h) => h.name === n)?.value || '';
		const from = get('From');
		const dateHeader = get('Date');
		const receivedAt = dateHeader ? new Date(dateHeader) : new Date(Number(full.data.internalDate));
		const labelIds = JSON.stringify(full.data.labelIds || []);

		const row = {
			accountId,
			from,
			fromDomain: extractDomain(from),
			to: get('To'),
			subject: get('Subject'),
			snippet: full.data.snippet || '',
			receivedAt,
			isUnread: true,
			labelIds,
			messageIds: JSON.stringify(messageIds),
			rawHeaders: JSON.stringify(headers),
			syncedAt: new Date()
		};

		const existing = await db
			.select({ id: threads.id })
			.from(threads)
			.where(and(eq(threads.id, threadId), eq(threads.accountId, accountId)))
			.get();

		if (existing) {
			await db.update(threads).set(row).where(eq(threads.id, threadId));
		} else {
			await db.insert(threads).values({ id: threadId, ...row });
		}
		syncedCount++;
	}

	return { syncedCount, totalThreads: byThread.size };
}

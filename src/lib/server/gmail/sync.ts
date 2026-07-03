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

// Calendar invites/responses carry these subject prefixes (localised variants
// exist, but English covers the bulk; the AI tier reads the body for the rest).
const CALENDAR_SUBJECT_RE =
	/^(invitation|updated invitation|accepted|declined|tentative|cancell?ed|canceled event):/i;

/** Cheap calendar signal: a text/calendar part on the message, or a tell-tale subject. */
function detectCalendarInvite(contentType: string, subject: string): boolean {
	if (/text\/calendar/i.test(contentType)) return true;
	return CALENDAR_SUBJECT_RE.test(subject.trim());
}

interface SyncResult {
	syncedCount: number;
	staleCount: number;
	selectedThreadIds: string[];
	totalThreads: number;
}

interface SyncProgress {
	current: number;
	total: number;
}

export interface SyncOptions {
	onList?: (totalThreads: number) => void | Promise<void>;
	onMetadata?: (progress: SyncProgress) => void | Promise<void>;
}

async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			out[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return out;
}

/**
 * Sync unread-in-inbox threads (newest first, capped). One row per thread,
 * holding the latest message's metadata and the unread message ids.
 */
export async function syncUnreadInbox(accountId: string, options: SyncOptions = {}): Promise<SyncResult> {
	const gmail = await getGmailClient(accountId);

	const query = `is:unread in:inbox newer_than:${SYNC_WINDOW_DAYS}d`;
	const messages: { id?: string | null; threadId?: string | null }[] = [];
	let pageToken: string | undefined;
	do {
		const list = await gmail.users.messages.list({
			userId: 'me',
			q: query,
			maxResults: 500,
			pageToken
		});
		messages.push(...(list.data.messages || []));
		pageToken = list.data.nextPageToken ?? undefined;
	} while (pageToken);

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

	await options.onList?.(byThread.size);

	const selectedThreadIds = threadOrder.slice(0, MAX_THREADS_PER_RUN);
	const currentThreadIds = new Set(threadOrder);
	let metadataDone = 0;
	const rows = await mapLimit(selectedThreadIds, 6, async (threadId) => {
		const messageIds = byThread.get(threadId)!;
		// Representative = first (newest) unread message in the thread.
		const repId = messageIds[0];
		const full = await gmail.users.messages.get({
			userId: 'me',
			id: repId,
			format: 'metadata',
			metadataHeaders: ['From', 'To', 'Subject', 'Date', 'List-Unsubscribe', 'Content-Type']
		});

		const headers = full.data.payload?.headers || [];
		const get = (n: string) => headers.find((h) => h.name?.toLowerCase() === n.toLowerCase())?.value || '';
		const from = get('From');
		const subject = get('Subject');
		const dateHeader = get('Date');
		const receivedAt = dateHeader ? new Date(dateHeader) : new Date(Number(full.data.internalDate));
		const labelIds = JSON.stringify(full.data.labelIds || []);

		const row = {
			accountId,
			from,
			fromDomain: extractDomain(from),
			to: get('To'),
			subject,
			snippet: full.data.snippet || '',
			receivedAt,
			isUnread: true,
			labelIds,
			messageIds: JSON.stringify(messageIds),
			rawHeaders: JSON.stringify(headers),
			hasUnsubscribe: Boolean(get('List-Unsubscribe').trim()),
			isCalendarInvite: detectCalendarInvite(get('Content-Type'), subject),
			syncedAt: new Date()
		};

		metadataDone++;
		await options.onMetadata?.({ current: metadataDone, total: selectedThreadIds.length });
		return { threadId, row };
	});

	let syncedCount = 0;
	for (const { threadId, row } of rows) {
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

	const now = new Date();
	const staleRows = await db
		.select({ id: threads.id })
		.from(threads)
		.where(and(eq(threads.accountId, accountId), eq(threads.isUnread, true)))
		.all();
	let staleCount = 0;
	for (const row of staleRows) {
		if (currentThreadIds.has(row.id)) continue;
		await db
			.update(threads)
			.set({ isUnread: false, syncedAt: now })
			.where(and(eq(threads.id, row.id), eq(threads.accountId, accountId)));
		staleCount++;
	}

	return { syncedCount, staleCount, selectedThreadIds, totalThreads: byThread.size };
}

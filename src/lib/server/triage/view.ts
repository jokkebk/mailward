import type { threads } from '../db/schema';
import { ageDays } from '../utils';
import type { ThreadView } from '$lib/types/rules';

/** Map a stored threads row to the client-facing ThreadView (the model payload base). */
export function toThreadView(row: typeof threads.$inferSelect): ThreadView {
	const labelIds: string[] = row.labelIds ? JSON.parse(row.labelIds) : [];
	const messageIds: string[] = row.messageIds ? JSON.parse(row.messageIds) : [];
	const receivedMs =
		row.receivedAt instanceof Date ? row.receivedAt.getTime() : Number(row.receivedAt);
	return {
		id: row.id,
		from: row.from,
		to: row.to ?? '',
		fromDomain: row.fromDomain,
		subject: row.subject,
		snippet: row.snippet,
		receivedAt: receivedMs,
		ageDays: ageDays(receivedMs),
		labelIds,
		messageIds,
		hasUnsubscribe: Boolean(row.hasUnsubscribe),
		isCalendarInvite: Boolean(row.isCalendarInvite)
	};
}

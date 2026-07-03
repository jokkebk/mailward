import type { threads } from '../db/schema';
import { ageDays } from '../utils';
import type { ThreadView } from '$lib/types/rules';

interface HeaderLike {
	name?: string | null;
	value?: string | null;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const GOOGLE_GROUP_RE = /groups\.google\.com\/a\/([^/\s>]+)\/group\/([^/\s>]+)/gi;
const ROUTING_HEADER_NAMES = new Set([
	'from',
	'to',
	'cc',
	'bcc',
	'delivered-to',
	'x-delivered-to',
	'envelope-to',
	'list-id',
	'list-post',
	'list-unsubscribe',
	'x-original-to'
]);

function parseHeaders(rawHeaders: string | null): HeaderLike[] {
	if (!rawHeaders) return [];
	try {
		const parsed = JSON.parse(rawHeaders);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function addEmails(out: Set<string>, value: string): void {
	for (const match of value.matchAll(EMAIL_RE)) out.add(match[0].toLowerCase());
}

function addGoogleGroupAliases(out: Set<string>, value: string): void {
	for (const match of value.matchAll(GOOGLE_GROUP_RE)) {
		const domain = decodeURIComponent(match[1]).toLowerCase();
		const group = decodeURIComponent(match[2]).toLowerCase();
		if (domain && group) out.add(`${group}@${domain}`);
	}
}

export function routingRecipientsForThread(row: Pick<typeof threads.$inferSelect, 'from' | 'to' | 'rawHeaders'>): string {
	const recipients = new Set<string>();
	const values = [row.from, row.to ?? ''];

	for (const header of parseHeaders(row.rawHeaders)) {
		const name = String(header.name ?? '').toLowerCase();
		if (ROUTING_HEADER_NAMES.has(name)) values.push(String(header.value ?? ''));
	}

	for (const value of values) {
		addEmails(recipients, value);
		addGoogleGroupAliases(recipients, value);
	}

	return [...recipients].sort().join(' ');
}

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
		routingRecipients: routingRecipientsForThread(row),
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

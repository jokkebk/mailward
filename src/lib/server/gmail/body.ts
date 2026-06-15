import { getGmailClient } from './client';
import sanitizeHtml from 'sanitize-html';

const MAX_BODY_CHARS = 4000; // plenty for triage; keeps token cost bounded

function decode(data: string): string {
	// Gmail uses base64url for body parts.
	return Buffer.from(data, 'base64url').toString('utf8');
}

/** Recursively collect the best text we can find from a message payload tree. */
function extractText(payload: any): string {
	if (!payload) return '';

	// Prefer text/plain anywhere in the tree.
	const plain = findPart(payload, 'text/plain');
	if (plain?.body?.data) return decode(plain.body.data);

	const html = findPart(payload, 'text/html');
	if (html?.body?.data) {
		return sanitizeHtml(decode(html.body.data), { allowedTags: [], allowedAttributes: {} });
	}

	if (payload.body?.data) return decode(payload.body.data);
	return '';
}

function findPart(payload: any, mime: string): any {
	if (payload.mimeType === mime && payload.body?.data) return payload;
	for (const p of payload.parts ?? []) {
		const found = findPart(p, mime);
		if (found) return found;
	}
	return null;
}

/**
 * Fetch and flatten a message body to plain text, for rules that declare
 * `needs_body`. Capped + whitespace-collapsed. Returns '' on any failure so a
 * single unreadable body never aborts a classification batch.
 */
export async function fetchMessageBody(accountId: string, messageId: string): Promise<string> {
	try {
		const gmail = await getGmailClient(accountId);
		const res = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
		const text = extractText(res.data.payload).replace(/\s+/g, ' ').trim();
		return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) + '…' : text;
	} catch {
		return '';
	}
}

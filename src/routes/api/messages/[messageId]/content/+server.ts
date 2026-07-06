import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import { fetchEmailContent, sanitizeHtml } from '$lib/server/gmail/content';
import { handleReauthCleanup, reauthResponse } from '$lib/server/gmail/reauth';
import type { RequestHandler } from './$types';

/**
 * Full (sanitized) body for a single message, fetched from Gmail on demand.
 * Not cached — mailward's DB doesn't mirror email bodies.
 */
export const GET: RequestHandler = async ({ params, url }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;

	try {
		const content = await fetchEmailContent(accountId, params.messageId);
		return json({
			html: content.html ? sanitizeHtml(content.html) : null,
			text: content.text
		});
	} catch (error) {
		if (await handleReauthCleanup(error, accountId)) {
			return json(reauthResponse(), { status: 401 });
		}
		console.error('Fetch email content error:', error);
		return json({ error: 'Failed to fetch email content' }, { status: 500 });
	}
};

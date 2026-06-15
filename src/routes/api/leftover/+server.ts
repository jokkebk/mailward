import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import { applyThreadAction } from '$lib/server/triage/apply';
import { handleReauthCleanup, reauthResponse } from '$lib/server/gmail/reauth';
import type { RequestHandler } from './$types';

interface Body {
	threadId: string;
	action: 'archive' | 'trash' | 'label_todo' | 'mark_read';
	runId?: string;
	note?: string;
}

/**
 * Manual disposition of a leftover/uncovered thread. Logged as mode=manual —
 * this is the training corpus the analysis skill mines for new rules.
 */
export const POST: RequestHandler = async ({ url, request }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;

	const body = (await request.json()) as Body;
	try {
		const outcome = await applyThreadAction({
			accountId,
			runId: body.runId ?? null,
			ruleId: null,
			ruleVersionId: null,
			threadId: body.threadId,
			action: body.action,
			mode: 'manual',
			source: 'manual',
			verdict: 'manual',
			note: body.note ?? null
		});
		return json({ ok: outcome.status === 'applied', outcome });
	} catch (error) {
		if (await handleReauthCleanup(error, accountId)) {
			return json(reauthResponse(), { status: 401 });
		}
		console.error('Leftover action error:', error);
		return json({ error: 'Failed to apply action' }, { status: 500 });
	}
};

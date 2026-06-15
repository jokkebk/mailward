import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import { runTriage } from '$lib/server/triage/run';
import { handleReauthCleanup, reauthResponse } from '$lib/server/gmail/reauth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ url }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;

	try {
		const result = await runTriage(accountId);
		return json(result);
	} catch (error) {
		if (await handleReauthCleanup(error, accountId)) {
			return json(reauthResponse(), { status: 401 });
		}
		console.error('Run error:', error);
		return json({ error: 'Failed to run triage' }, { status: 500 });
	}
};

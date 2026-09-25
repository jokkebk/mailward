import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import { startOrAttachRun } from '$lib/server/triage/jobs';
import { hasOpenRouterKey } from '$lib/server/ai/availability';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ url }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;

	const sync = url.searchParams.get('sync') !== 'false';
	const useJev = hasOpenRouterKey() && url.searchParams.get('jev') !== 'false';

	try {
		const runId = await startOrAttachRun(accountId, sync, useJev);
		return json({ runId });
	} catch (error) {
		console.error('Run error:', error);
		return json({ error: 'Failed to start triage' }, { status: 500 });
	}
};

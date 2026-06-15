import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import { getRunProgress } from '$lib/server/triage/telemetry';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;

	const runId = url.searchParams.get('runId');
	if (!runId) return json({ error: 'runId required' }, { status: 400 });

	const progress = await getRunProgress(runId, accountId);
	if (!progress) return json({ error: 'Run not found' }, { status: 404 });
	return json(progress);
};

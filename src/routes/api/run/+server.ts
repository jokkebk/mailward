import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import { startOrAttachRun } from '$lib/server/triage/jobs';
import { hasOpenRouterKey } from '$lib/server/ai/availability';
import type { RequestHandler } from './$types';
import { openV3Database } from '$lib/server/v3/service';

export const POST: RequestHandler = async ({ url }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;

	const sync = url.searchParams.get('sync') !== 'false';
	const useJev = hasOpenRouterKey() && url.searchParams.get('jev') !== 'false';

	try {
		const sqlite = openV3Database();
		const v3Running = sqlite.query("SELECT id FROM runs WHERE account_id = ? AND scope = 'v3' AND status = 'running' AND started_at > ? LIMIT 1").get(accountId, Date.now() - 30 * 60_000);
		sqlite.close();
		if (v3Running) return json({ error: 'A v3 assessment is active for this account' }, { status: 409 });
		const runId = await startOrAttachRun(accountId, sync, useJev);
		return json({ runId });
	} catch (error) {
		console.error('Run error:', error);
		return json({ error: 'Failed to start triage' }, { status: 500 });
	}
};

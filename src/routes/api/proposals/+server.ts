import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import { loadRehydration } from '$lib/server/triage/proposals';
import type { RequestHandler } from './$types';

/**
 * Rehydrate the latest run's open proposals + uncovered list, so a page reload
 * restores the review screen without re-running triage (and without re-paying
 * for AI classification).
 */
export const GET: RequestHandler = async ({ url }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;

	const { runId, proposals, leftovers } = await loadRehydration(accountId);
	return json({ runId, proposals, leftovers });
};

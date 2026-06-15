import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { actions, rules } from '$lib/server/db/schema';
import { desc, eq } from 'drizzle-orm';
import { getRequiredAccountId } from '$lib/server/utils';
import type { RequestHandler } from './$types';

/** Recent action log (newest first), with rule name, for the history + rollback UI. */
export const GET: RequestHandler = async ({ url }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;

	const rows = await db
		.select({
			id: actions.id,
			runId: actions.runId,
			ruleId: actions.ruleId,
			ruleName: rules.name,
			threadId: actions.threadId,
			action: actions.action,
			mode: actions.mode,
			source: actions.source,
			status: actions.status,
			confidence: actions.confidence,
			note: actions.note,
			error: actions.error,
			appliedAt: actions.appliedAt,
			createdAt: actions.createdAt
		})
		.from(actions)
		.leftJoin(rules, eq(actions.ruleId, rules.id))
		.where(eq(actions.accountId, accountId))
		.orderBy(desc(actions.createdAt))
		.limit(200)
		.all();

	return json({ actions: rows });
};

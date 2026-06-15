import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { actions } from '$lib/server/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { getRequiredAccountId } from '$lib/server/utils';
import { undoAction } from '$lib/server/triage/apply';
import { handleReauthCleanup, reauthResponse } from '$lib/server/gmail/reauth';
import type { RequestHandler } from './$types';

interface Body {
	scope: 'run' | 'batch' | 'action';
	runId?: string;
	ruleId?: string;
	actionId?: string;
}

export const POST: RequestHandler = async ({ url, request }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;

	const body = (await request.json()) as Body;

	try {
		// Resolve the set of applied actions to reverse (newest first).
		const where = [eq(actions.accountId, accountId), eq(actions.status, 'applied')];
		if (body.scope === 'action') {
			if (!body.actionId) return json({ error: 'actionId required' }, { status: 400 });
			where.push(eq(actions.id, body.actionId));
		} else if (body.scope === 'batch') {
			if (!body.runId || !body.ruleId)
				return json({ error: 'runId and ruleId required' }, { status: 400 });
			where.push(eq(actions.runId, body.runId), eq(actions.ruleId, body.ruleId));
		} else if (body.scope === 'run') {
			if (!body.runId) return json({ error: 'runId required' }, { status: 400 });
			where.push(eq(actions.runId, body.runId));
		} else {
			return json({ error: 'invalid scope' }, { status: 400 });
		}

		const targets = await db
			.select({ id: actions.id })
			.from(actions)
			.where(and(...where))
			.orderBy(desc(actions.appliedAt))
			.all();

		let undone = 0;
		let failed = 0;
		for (const t of targets) {
			const outcome = await undoAction(accountId, t.id);
			if (outcome.status === 'applied') undone++;
			else failed++;
		}

		return json({ ok: true, undone, failed });
	} catch (error) {
		if (await handleReauthCleanup(error, accountId)) {
			return json(reauthResponse(), { status: 401 });
		}
		console.error('Undo error:', error);
		return json({ error: 'Failed to undo' }, { status: 500 });
	}
};

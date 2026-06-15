import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import { createRule, getResolvedRules } from '$lib/server/triage/rules';
import type { MatchCriteria, RuleAction } from '$lib/types/rules';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;
	return json({ rules: await getResolvedRules(accountId) });
};

interface CreateBody {
	name: string;
	priority: number;
	action: RuleAction;
	matchCriteria: MatchCriteria;
	intent?: string;
}

export const POST: RequestHandler = async ({ url, request }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;

	const body = (await request.json()) as CreateBody;
	if (!body.name?.trim() || !body.action || !body.matchCriteria?.conditions?.length) {
		return json({ error: 'name, action and at least one condition are required' }, { status: 400 });
	}

	const ruleId = await createRule(accountId, {
		name: body.name.trim(),
		priority: body.priority ?? 100,
		action: body.action,
		matchCriteria: body.matchCriteria,
		intent: body.intent ?? null
	});
	return json({ ok: true, ruleId });
};

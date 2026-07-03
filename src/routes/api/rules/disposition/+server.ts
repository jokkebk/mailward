import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import { changeDeterministicRuleDisposition } from '$lib/server/triage/rules';
import type { RuleAction } from '$lib/types/rules';
import type { RequestHandler } from './$types';

interface ChangeDispositionBody {
	runId: string;
	ruleId: string;
	versionId: string;
	action: RuleAction;
	note?: string | null;
}

const VALID_ACTIONS = new Set<RuleAction>(['archive', 'trash', 'label_todo']);

export const POST: RequestHandler = async ({ url, request }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;

	const body = (await request.json()) as ChangeDispositionBody;
	if (!body.runId || !body.ruleId || !body.versionId || !VALID_ACTIONS.has(body.action)) {
		return json({ error: 'runId, ruleId, versionId and a valid action are required' }, { status: 400 });
	}

	try {
		const changed = await changeDeterministicRuleDisposition({
			accountId,
			runId: body.runId,
			ruleId: body.ruleId,
			versionId: body.versionId,
			action: body.action,
			note: body.note
		});
		return json({ ok: true, ...changed });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to change rule disposition';
		const status = /not found/i.test(message) ? 404 : 400;
		return json({ error: message }, { status });
	}
};

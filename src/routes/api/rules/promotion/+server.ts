import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import {
	listDispositionMetrics,
	setDispositionManualOnly,
	setDispositionStatus
} from '$lib/server/triage/promotion';
import { resumeRule } from '$lib/server/triage/apply';
import type { RuleAction } from '$lib/types/rules';
import type { RequestHandler } from './$types';

/**
 * The promotion gate's surface. GET reports every (rule, disposition)'s record and
 * whether it has earned auto-apply; POST is the human's confirm click — the only
 * path to status='auto' (DESIGN.md: the skill can never promote a rule itself).
 */

const VALID_ACTIONS = new Set<RuleAction>(['archive', 'trash', 'label_todo']);
const VALID_OPS = new Set(['promote', 'demote', 'pin', 'unpin', 'resume']);

interface Body {
	ruleId: string;
	action: RuleAction;
	/** 'resume' lifts a rule-level suspension; the rest act on one disposition. */
	op: 'promote' | 'demote' | 'pin' | 'unpin' | 'resume';
}

export const GET: RequestHandler = async ({ url }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;
	return json({ dispositions: await listDispositionMetrics(accountId) });
};

export const POST: RequestHandler = async ({ url, request }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;

	const body = (await request.json()) as Body;
	if (!body.ruleId || !VALID_ACTIONS.has(body.action) || !VALID_OPS.has(body.op)) {
		return json({ error: 'ruleId, a valid action and a valid op are required' }, { status: 400 });
	}

	try {
		if (body.op === 'resume') {
			await resumeRule(accountId, body.ruleId);
		} else if (body.op === 'promote') {
			await setDispositionStatus(accountId, body.ruleId, body.action, 'auto');
		} else if (body.op === 'demote') {
			await setDispositionStatus(accountId, body.ruleId, body.action, 'proposing');
		} else {
			await setDispositionManualOnly(body.ruleId, body.action, body.op === 'pin');
		}
		return json({ ok: true, dispositions: await listDispositionMetrics(accountId) });
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Failed to change promotion status';
		return json({ error: message }, { status: 400 });
	}
};

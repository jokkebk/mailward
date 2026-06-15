import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import {
	applyThreadAction,
	recordApproveVerdict,
	recordVerdict,
	suspendRule
} from '$lib/server/triage/apply';
import { handleReauthCleanup, reauthResponse } from '$lib/server/gmail/reauth';
import type { RuleAction } from '$lib/types/rules';
import type { RequestHandler } from './$types';

interface DecisionBody {
	runId: string;
	ruleId: string;
	versionId: string;
	action: RuleAction;
	verb: 'approve' | 'amend' | 'reject';
	apply?: string[]; // thread ids to act on
	save?: string[]; // unchecked, "save this one" (metric-excluded)
	skip?: string[]; // unchecked, plain negative
	allThreadIds?: string[]; // full group (used by reject)
	note?: string;
	suspend?: boolean;
}

export const POST: RequestHandler = async ({ url, request }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;

	const body = (await request.json()) as DecisionBody;
	const { runId, ruleId, versionId, action, verb } = body;

	if (verb === 'reject' && !body.note?.trim()) {
		return json({ error: 'A note is required when rejecting a batch.' }, { status: 400 });
	}

	const common = { accountId, runId, ruleId, ruleVersionId: versionId };
	const applied: { threadId: string; status: string; error?: string }[] = [];

	try {
		if (verb === 'reject') {
			for (const threadId of body.allThreadIds ?? []) {
				await recordVerdict({ ...common, threadId, verdict: 'reject', note: body.note });
			}
			if (body.suspend) await suspendRule(accountId, ruleId);
			return json({ ok: true, applied, suspended: Boolean(body.suspend) });
		}

		// approve / amend
		for (const threadId of body.apply ?? []) {
			const outcome = await applyThreadAction({
				...common,
				threadId,
				action,
				mode: 'proposed',
				source: 'deterministic',
				verdict: verb,
				note: body.note ?? null
			});
			applied.push(outcome);
			if (outcome.status === 'applied') {
				await recordApproveVerdict({ ...common, threadId });
			}
		}
		for (const threadId of body.save ?? []) {
			await recordVerdict({ ...common, threadId, verdict: 'save' });
		}
		for (const threadId of body.skip ?? []) {
			await recordVerdict({ ...common, threadId, verdict: 'amend_skip', note: body.note });
		}

		const failed = applied.filter((a) => a.status === 'failed').length;
		return json({ ok: true, applied, appliedCount: applied.length - failed, failed });
	} catch (error) {
		if (await handleReauthCleanup(error, accountId)) {
			return json(reauthResponse(), { status: 401 });
		}
		console.error('Decision error:', error);
		return json({ error: 'Failed to apply decision' }, { status: 500 });
	}
};

import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import {
	applyThreadAction,
	recordApproveVerdict,
	recordVerdict,
	suspendRule
} from '$lib/server/triage/apply';
import { getOpenProposal, rejectBatch, setProposalStatus } from '$lib/server/triage/proposals';
import { handleReauthCleanup, reauthResponse } from '$lib/server/gmail/reauth';
import type { Confidence, RuleAction } from '$lib/types/rules';
import type { RequestHandler } from './$types';

interface DecisionBody {
	runId: string;
	ruleId: string;
	versionId: string;
	verb: 'approve' | 'amend' | 'reject' | 'review';
	apply?: string[]; // thread ids to act on
	save?: string[]; // unchecked, "save this one" (metric-excluded)
	skip?: string[]; // unchecked, plain negative
	allThreadIds?: string[]; // full group (used by reject)
	reviews?: {
		threadId: string;
		disposition: RuleAction | 'skip' | 'correct';
		note?: string | null;
	}[];
	note?: string;
	suspend?: boolean;
}

export const POST: RequestHandler = async ({ url, request }) => {
	const accountId = getRequiredAccountId(url);
	if (accountId instanceof Response) return accountId;

	const body = (await request.json()) as DecisionBody;
	const { runId, ruleId, versionId, verb } = body;

	if (verb === 'reject' && !body.note?.trim()) {
		return json({ error: 'A note is required when rejecting a batch.' }, { status: 400 });
	}
	if (verb === 'review') {
		const valid = new Set(['archive', 'trash', 'label_todo', 'skip', 'correct']);
		for (const row of body.reviews ?? []) {
			if (!valid.has(row.disposition)) {
				return json({ error: `Unknown disposition: ${row.disposition}` }, { status: 400 });
			}
			if (row.disposition === 'correct' && !row.note?.trim()) {
				return json({ error: 'A note is required for Correct rows.' }, { status: 400 });
			}
		}
	}

	const common = { accountId, runId, ruleId, ruleVersionId: versionId };
	const applied: { threadId: string; status: string; error?: string }[] = [];

	try {
		if (verb === 'reject') {
			for (const threadId of body.allThreadIds ?? []) {
				await recordVerdict({ ...common, threadId, verdict: 'reject', note: body.note });
			}
			await rejectBatch({ accountId, runId, ruleId });
			if (body.suspend) await suspendRule(accountId, ruleId);
			return json({ ok: true, applied, suspended: Boolean(body.suspend) });
		}

		if (verb === 'review') {
			for (const row of body.reviews ?? []) {
				const prop = await getOpenProposal({ accountId, runId, ruleId, threadId: row.threadId });
				if (!prop) {
					applied.push({ threadId: row.threadId, status: 'failed', error: 'no open proposal' });
					continue;
				}
				const suggested = prop.action as RuleAction;
				const note = row.note?.trim() ? row.note : null;

				if (row.disposition === 'skip') {
					await recordVerdict({ ...common, threadId: row.threadId, verdict: 'save', note });
					await setProposalStatus(prop.id, 'skipped');
					continue;
				}
				if (row.disposition === 'correct') {
					await recordVerdict({ ...common, threadId: row.threadId, verdict: 'correct', note });
					await setProposalStatus(prop.id, 'skipped');
					continue;
				}

				const outcome = await applyThreadAction({
					...common,
					threadId: row.threadId,
					action: row.disposition,
					mode: 'proposed',
					source: prop.source as 'deterministic' | 'ai',
					confidence: (prop.confidence as Confidence | null) ?? null,
					verdict: row.disposition === suggested ? 'approve' : 'correct',
					note
				});
				applied.push(outcome);
				if (outcome.status === 'applied') {
					if (row.disposition !== suggested) {
						await recordVerdict({ ...common, threadId: row.threadId, verdict: 'correct', note });
					}
					await recordApproveVerdict({
						...common,
						threadId: row.threadId,
						note: row.disposition === suggested ? note : null
					});
					await setProposalStatus(prop.id, 'applied');
				}
			}

			const failed = applied.filter((a) => a.status === 'failed').length;
			return json({ ok: true, applied, appliedCount: applied.length - failed, failed });
		}

		// approve / amend — each thread's disposition comes from its persisted proposal,
		// since a router rule's threads can carry different actions.
		for (const threadId of body.apply ?? []) {
			const prop = await getOpenProposal({ accountId, runId, ruleId, threadId });
			if (!prop) {
				applied.push({ threadId, status: 'failed', error: 'no open proposal' });
				continue;
			}
			const outcome = await applyThreadAction({
				...common,
				threadId,
				action: prop.action as RuleAction,
				mode: 'proposed',
				source: prop.source as 'deterministic' | 'ai',
				confidence: (prop.confidence as Confidence | null) ?? null,
				verdict: verb,
				note: body.note ?? null
			});
			applied.push(outcome);
			if (outcome.status === 'applied') {
				await recordApproveVerdict({ ...common, threadId });
				await setProposalStatus(prop.id, 'applied');
			}
		}
		for (const threadId of body.save ?? []) {
			const prop = await getOpenProposal({ accountId, runId, ruleId, threadId });
			await recordVerdict({ ...common, threadId, verdict: 'save' });
			if (prop) await setProposalStatus(prop.id, 'skipped');
		}
		for (const threadId of body.skip ?? []) {
			const prop = await getOpenProposal({ accountId, runId, ruleId, threadId });
			await recordVerdict({ ...common, threadId, verdict: 'amend_skip', note: body.note });
			if (prop) await setProposalStatus(prop.id, 'skipped');
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

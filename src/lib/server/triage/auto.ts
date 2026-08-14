import { db } from '../db';
import { actions, proposals, rules, threads } from '../db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { applyThreadAction } from './apply';
import { autoDecision, loadAutoDispositions } from './promotion';
import { writeProposals, type NewProposal } from './proposals';
import type { AutoDigestGroup, AutoDigestItem, Confidence, RuleAction } from '$lib/types/rules';

/**
 * The auto-apply half of a run: dispositions a human has promoted act immediately
 * and report afterwards ("this was done — expand to review, undo if wrong"),
 * instead of queueing for approval. Everything else still proposes.
 *
 * The safety valve is `autoDecision` (DESIGN.md §"Confidence"): a low-confidence
 * destructive call falls back to a proposal even on a promoted disposition, and a
 * low-confidence non-destructive one acts but is flagged in the digest.
 */

export interface AutoPartition {
	/** Rows to act on now, paired with whether they need flagging in the digest. */
	auto: { row: NewProposal; flagged: boolean }[];
	/** Rows that still go through review as normal. */
	propose: NewProposal[];
}

/**
 * Split a run's collected classifications into act-now and propose, by consulting
 * each (rule, disposition)'s promoted status. Pure decision-making — no writes.
 */
export async function partitionAutoApply(
	accountId: string,
	collected: NewProposal[]
): Promise<AutoPartition> {
	const autoSet = await loadAutoDispositions(accountId);
	const out: AutoPartition = { auto: [], propose: [] };

	for (const row of collected) {
		const promoted = autoSet.has(`${row.ruleId}::${row.action}`);
		const decision = autoDecision(
			row.action,
			(row.confidence ?? null) as Confidence | null,
			promoted ? 'auto' : 'proposing'
		);
		if (decision === 'propose') out.propose.push(row);
		else out.auto.push({ row, flagged: decision === 'act_flag' });
	}

	return out;
}

/**
 * Execute the act-now rows against Gmail, recording a reversible action per thread
 * plus an 'applied' proposal row (audit trail + the model's reason for the digest).
 *
 * A failure here is isolated per thread by `applyThreadAction`, except reauth, which
 * propagates so the run can surface a 401 rather than silently half-finishing.
 */
export async function applyAutoActions(
	accountId: string,
	runId: string,
	partition: AutoPartition
): Promise<{ applied: number; failed: number }> {
	if (partition.auto.length === 0) return { applied: 0, failed: 0 };

	await writeProposals(
		partition.auto.map((a) => a.row),
		'applied'
	);

	let applied = 0;
	let failed = 0;
	for (const { row, flagged } of partition.auto) {
		const outcome = await applyThreadAction({
			accountId,
			runId,
			ruleId: row.ruleId,
			ruleVersionId: row.ruleVersionId,
			threadId: row.threadId,
			action: row.action,
			mode: 'auto',
			source: row.source,
			verdict: 'auto',
			confidence: (row.confidence ?? null) as Confidence | null,
			note: flagged ? 'auto-applied with low confidence — flagged for review' : null
		});
		if (outcome.status === 'applied') applied++;
		else failed++;
	}

	return { applied, failed };
}

/**
 * Load the "this was done" digest for a run: what auto-apply did, grouped by
 * (rule, disposition), newest first, each row undoable via its actionId.
 */
export async function loadAutoDigest(
	accountId: string,
	runId: string
): Promise<AutoDigestGroup[]> {
	const rows = await db
		.select({
			a: actions,
			ruleName: rules.name,
			subject: threads.subject,
			from: threads.from,
			snippet: threads.snippet,
			receivedAt: threads.receivedAt,
			reason: proposals.reason
		})
		.from(actions)
		.innerJoin(rules, eq(actions.ruleId, rules.id))
		.leftJoin(threads, eq(actions.threadId, threads.id))
		.leftJoin(
			proposals,
			and(
				eq(proposals.threadId, actions.threadId),
				eq(proposals.runId, actions.runId),
				eq(proposals.ruleId, actions.ruleId)
			)
		)
		.where(
			and(eq(actions.accountId, accountId), eq(actions.runId, runId), eq(actions.mode, 'auto'))
		)
		.orderBy(asc(rules.name))
		.all();

	const groups = new Map<string, AutoDigestGroup>();
	for (const r of rows) {
		const action = r.a.action as RuleAction;
		const key = `${r.a.ruleId}::${action}`;
		let g = groups.get(key);
		if (!g) {
			g = {
				ruleId: r.a.ruleId ?? '',
				ruleName: r.ruleName,
				action,
				applied: 0,
				flagged: 0,
				rolledBack: 0,
				failed: 0,
				items: []
			};
			groups.set(key, g);
		}

		const status = r.a.status as AutoDigestItem['status'];
		// `act_flag` is exactly "auto-applied at low confidence" — derive it from the
		// recorded confidence rather than parsing the note text.
		const flagged = r.a.confidence === 'low';
		if (status === 'applied') g.applied++;
		else if (status === 'rolled_back') g.rolledBack++;
		else g.failed++;
		if (flagged && status === 'applied') g.flagged++;

		const receivedMs =
			r.receivedAt instanceof Date ? r.receivedAt.getTime() : Number(r.receivedAt ?? 0);

		g.items.push({
			actionId: r.a.id,
			threadId: r.a.threadId,
			from: r.from ?? '',
			subject: r.subject,
			snippet: r.snippet,
			receivedAt: receivedMs,
			action,
			confidence: (r.a.confidence as Confidence | null) ?? null,
			reason: r.reason,
			status,
			flagged,
			error: r.a.error
		});
	}

	const out = [...groups.values()];
	for (const g of out) {
		// Flagged and failed rows first — they are the ones worth a human's eyes.
		g.items.sort((a, b) => {
			const rank = (i: AutoDigestItem) => (i.status === 'failed' ? 0 : i.flagged ? 1 : 2);
			return rank(a) - rank(b) || b.receivedAt - a.receivedAt;
		});
	}
	out.sort((a, b) => b.applied - a.applied || a.ruleName.localeCompare(b.ruleName));
	return out;
}

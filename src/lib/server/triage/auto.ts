import { db } from '../db';
import { actions, proposals, rules, threads } from '../db/schema';
import { and, asc, eq } from 'drizzle-orm';
import { applyThreadAction } from './apply';
import { autoDecision, loadAutoDispositions } from './promotion';
import { writeProposals, type NewProposal } from './proposals';
import { emptyGroup, push, sortDigest, toMillis } from './digest';
import type { Confidence, DigestGroup, DigestItem, RuleAction } from '$lib/types/rules';

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
	collected: NewProposal[],
	options: { proposeAiTrash?: boolean } = {}
): Promise<AutoPartition> {
	const autoSet = await loadAutoDispositions(accountId);
	const out: AutoPartition = { auto: [], propose: [] };

	for (const row of collected) {
		if (options.proposeAiTrash && row.source === 'ai' && row.action === 'trash') {
			out.propose.push(row);
			continue;
		}
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
 * Load the autopilot receipt for a run: what auto-apply did without asking, grouped
 * by (rule, disposition), each row undoable via its actionId. The mirror of this is
 * `loadReviewedDigest` in ./digest, for what you decided yourself.
 */
export async function loadAutoDigest(accountId: string, runId: string): Promise<DigestGroup[]> {
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

	const groups = new Map<string, DigestGroup>();
	for (const r of rows) {
		const action = r.a.action as RuleAction;
		const key = `${r.a.ruleId}::${action}`;
		let g = groups.get(key);
		if (!g) {
			g = emptyGroup(r.a.ruleId ?? '', r.ruleName, action);
			groups.set(key, g);
		}

		push(g, {
			actionId: r.a.id,
			threadId: r.a.threadId,
			from: r.from ?? '',
			subject: r.subject,
			snippet: r.snippet,
			receivedAt: toMillis(r.receivedAt),
			action,
			confidence: (r.a.confidence as Confidence | null) ?? null,
			reason: r.reason,
			status: r.a.status as DigestItem['status'],
			// `act_flag` is exactly "auto-applied at low confidence" — derive it from the
			// recorded confidence rather than parsing the note text.
			flagged: r.a.confidence === 'low',
			error: r.a.error
		});
	}

	return sortDigest([...groups.values()]);
}

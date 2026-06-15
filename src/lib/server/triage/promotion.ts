import { db } from '../db';
import { actions, proposals, ruleDispositions, rules, verdicts } from '../db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { PROMOTION_GATE } from '$lib/constants';
import type { Confidence, RuleAction, RuleStatus } from '$lib/types/rules';

/**
 * Per-(rule, disposition) promotion — the data model + helpers. The propose-only
 * tier ships first; this is the substrate the auto-apply path (separate phase)
 * builds on. Promotion is always suggest-and-confirm (DESIGN.md): these helpers
 * compute eligibility; only a human click sets status='auto'.
 */

export type AutoDecision = 'act' | 'act_flag' | 'propose';

/**
 * What an AUTO disposition should do for a given thread at run time (designed now,
 * wired later). DESIGN.md §"Confidence": destructive low-confidence falls back to a
 * proposal; non-destructive low-confidence acts then flags; otherwise act silently.
 * A disposition that hasn't graduated to 'auto' always proposes.
 */
export function autoDecision(
	action: RuleAction,
	confidence: Confidence | null,
	dispositionStatus: RuleStatus
): AutoDecision {
	if (dispositionStatus !== 'auto') return 'propose';
	if (confidence === 'low') return action === 'trash' ? 'propose' : 'act_flag';
	return 'act';
}

export interface DispositionMetrics {
	ruleId: string;
	action: RuleAction;
	status: RuleStatus;
	success: number;
	failure: number;
	excluded: number;
	approvalPct: number | null;
	applied: number;
	rolledBack: number;
	scored: number;
	eligible: boolean;
}

/**
 * Compute the promotion-gate window for one (rule, disposition) over the CURRENT
 * version only. Verdicts are attributed to a disposition by joining through the
 * proposal that produced them (a router rule's version spans several dispositions).
 *
 * Gate mapping (DESIGN.md): applied action=success for the chosen disposition;
 * reject / correct / amend_skip-with-note=failure for the suggested disposition;
 * amend_skip-no-note / save=excluded. A post-hoc rollback is a strong failure.
 */
export async function dispositionMetrics(
	accountId: string,
	ruleId: string,
	action: RuleAction
): Promise<DispositionMetrics> {
	const rule = await db.select().from(rules).where(eq(rules.id, ruleId)).get();
	const versionId = rule?.currentVersionId ?? '';
	const dispRow = await db
		.select()
		.from(ruleDispositions)
		.where(and(eq(ruleDispositions.ruleId, ruleId), eq(ruleDispositions.action, action)))
		.get();
	const status = (dispRow?.status as RuleStatus) ?? 'proposing';

	const gate = PROMOTION_GATE[action];
	const empty: DispositionMetrics = {
		ruleId,
		action,
		status,
		success: 0,
		failure: 0,
		excluded: 0,
		approvalPct: null,
		applied: 0,
		rolledBack: 0,
		scored: 0,
		eligible: false
	};
	if (!versionId) return empty;

	// Original suggestions for this version. Failures/exclusions are attributed
	// to the suggested disposition; applied successes are attributed below to
	// the action the user actually chose.
	const suggested = await db
		.select({ threadId: proposals.threadId, action: proposals.action })
		.from(proposals)
		.where(eq(proposals.ruleVersionId, versionId))
		.all();
	const suggestedActionByThread = new Map(suggested.map((p) => [p.threadId, p.action]));

	// Verdicts for this version. `approve` is kept for dedup/history, but the
	// promotion success signal comes from the applied action rows so corrected
	// actions count toward the disposition the user chose.
	const vrows = await db
		.select({
			threadId: verdicts.threadId,
			verdict: verdicts.verdict,
			note: verdicts.note,
			createdAt: verdicts.createdAt
		})
		.from(verdicts)
		.where(eq(verdicts.ruleVersionId, versionId))
		.orderBy(desc(verdicts.createdAt))
		.all();

	const appliedRows = await db
		.select({ id: actions.id, createdAt: actions.createdAt })
		.from(actions)
		.where(
			and(
				eq(actions.ruleVersionId, versionId),
				eq(actions.action, action),
				eq(actions.status, 'applied')
			)
		)
		.all();

	const events: { outcome: 'success' | 'failure' | 'excluded'; createdAt: Date }[] = appliedRows.map(
		(a) => ({
			outcome: 'success',
			createdAt: a.createdAt
		})
	);

	for (const v of vrows) {
		if (suggestedActionByThread.get(v.threadId) !== action) continue;
		const hasNote = Boolean(v.note && String(v.note).trim());
		let outcome: 'success' | 'failure' | 'excluded' | null = null;
		if (v.verdict === 'reject' || v.verdict === 'correct') outcome = 'failure';
		else if (v.verdict === 'amend_skip') outcome = hasNote ? 'failure' : 'excluded';
		else if (v.verdict === 'save') outcome = 'excluded';
		if (outcome) events.push({ outcome, createdAt: v.createdAt });
	}
	events.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

	let success = 0;
	let failure = 0;
	let excluded = 0;
	let scored = 0;
	let leadingSuccessRun = 0;
	let runBroken = false;
	for (const event of events.slice(0, gate.minRun * 3)) {
		if (event.outcome === 'success') success++;
		else if (event.outcome === 'failure') failure++;
		else excluded++;
		if (event.outcome !== 'excluded') {
			scored++;
			if (!runBroken) {
				if (event.outcome === 'success') leadingSuccessRun++;
				else runBroken = true;
			}
		}
	}

	// Rollbacks of this version+action are a strong failure signal.
	const rb = await db
		.select({ id: actions.id })
		.from(actions)
		.where(
			and(
				eq(actions.ruleVersionId, versionId),
				eq(actions.action, action),
				eq(actions.status, 'rolled_back')
			)
		)
		.all();
	const rolledBack = rb.length;
	failure += rolledBack;

	const approvalPct = success + failure > 0 ? Math.round((success / (success + failure)) * 100) : null;
	const eligible =
		status === 'proposing' &&
		rolledBack === 0 &&
		leadingSuccessRun >= gate.minRun &&
		approvalPct !== null &&
		approvalPct >= gate.minApprovalPct;

	return {
		ruleId,
		action,
		status,
		success,
		failure,
		excluded,
		approvalPct,
		applied: appliedRows.length,
		rolledBack,
		scored,
		eligible
	};
}

export async function getDispositionStatus(ruleId: string, action: RuleAction): Promise<RuleStatus> {
	const row = await db
		.select({ status: ruleDispositions.status })
		.from(ruleDispositions)
		.where(and(eq(ruleDispositions.ruleId, ruleId), eq(ruleDispositions.action, action)))
		.get();
	return (row?.status as RuleStatus) ?? 'proposing';
}

/** Suggest-and-confirm: a human click sets a disposition to 'auto' (or back). */
export async function setDispositionStatus(
	ruleId: string,
	action: RuleAction,
	status: RuleStatus
): Promise<void> {
	await db
		.update(ruleDispositions)
		.set({ status, updatedAt: new Date() })
		.where(and(eq(ruleDispositions.ruleId, ruleId), eq(ruleDispositions.action, action)));
}

/** Demote every disposition of a rule back to 'proposing' (on a new version). */
export async function resetDispositions(ruleId: string): Promise<void> {
	await db
		.update(ruleDispositions)
		.set({ status: 'proposing', updatedAt: new Date() })
		.where(eq(ruleDispositions.ruleId, ruleId));
}

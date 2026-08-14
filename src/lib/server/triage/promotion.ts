import { db } from '../db';
import { actions, proposals, ruleDispositions, ruleVersions, rules, verdicts } from '../db/schema';
import { and, asc, desc, eq, ne } from 'drizzle-orm';
import { PROMOTION_GATE } from '$lib/constants';
import { parseAllowedActions } from './rules';
import type {
	Confidence,
	DispositionMetrics,
	RuleAction,
	RuleDispositionMetrics,
	RuleStatus,
	RuleTier
} from '$lib/types/rules';

/**
 * Per-(rule, disposition) promotion. Promotion is always suggest-and-confirm
 * (DESIGN.md): these helpers compute eligibility, the run loop reads the status,
 * and only a human click sets status='auto'. A disposition can additionally be
 * pinned `manual_only` — propose-only forever, whatever the metrics say — for
 * actions the human always wants to approve *before* they happen.
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

// The gate's data shapes live in $lib/types/rules so the review UI can read them
// without importing a server-only module.
export type { DispositionMetrics, RuleDispositionMetrics } from '$lib/types/rules';

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
	const rule = await db
		.select()
		.from(rules)
		.where(and(eq(rules.id, ruleId), eq(rules.accountId, accountId)))
		.get();
	const versionId = rule?.currentVersionId ?? '';
	const dispRow = await db
		.select()
		.from(ruleDispositions)
		.where(and(eq(ruleDispositions.ruleId, ruleId), eq(ruleDispositions.action, action)))
		.get();
	const status = (dispRow?.status as RuleStatus) ?? 'proposing';
	const manualOnly = Boolean(dispRow?.manualOnly);

	const gate = PROMOTION_GATE[action];
	const empty: DispositionMetrics = {
		ruleId,
		action,
		status,
		manualOnly,
		success: 0,
		failure: 0,
		excluded: 0,
		approvalPct: null,
		applied: 0,
		rolledBack: 0,
		scored: 0,
		leadingSuccessRun: 0,
		minRun: gate.minRun,
		minApprovalPct: gate.minApprovalPct,
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

	// Only HUMAN-approved actions count as gate successes: an auto-applied action
	// is the gate's output, not evidence for it, so counting it would let a
	// promoted disposition keep re-earning its own promotion. Auto rows still show
	// in `applied` (what actually happened) and their rollbacks still count against.
	const appliedRows = await db
		.select({ id: actions.id, createdAt: actions.createdAt, mode: actions.mode })
		.from(actions)
		.where(
			and(
				eq(actions.ruleVersionId, versionId),
				eq(actions.action, action),
				eq(actions.status, 'applied')
			)
		)
		.all();

	const events: { outcome: 'success' | 'failure' | 'excluded'; createdAt: Date }[] = appliedRows
		.filter((a) => a.mode !== 'auto')
		.map((a) => ({
			outcome: 'success',
			createdAt: a.createdAt
		}));

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
		Boolean(dispRow) &&
		status === 'proposing' &&
		!manualOnly &&
		rolledBack === 0 &&
		leadingSuccessRun >= gate.minRun &&
		approvalPct !== null &&
		approvalPct >= gate.minApprovalPct;

	return {
		ruleId,
		action,
		status,
		manualOnly,
		success,
		failure,
		excluded,
		approvalPct,
		applied: appliedRows.length,
		rolledBack,
		scored,
		leadingSuccessRun,
		minRun: gate.minRun,
		minApprovalPct: gate.minApprovalPct,
		eligible
	};
}

/**
 * Gate status for every (rule, disposition) of an account, in rule priority order.
 * The promotion panel's read surface: which dispositions are auto, which are
 * eligible to be turned on, and how far off the rest are.
 */
export async function listDispositionMetrics(accountId: string): Promise<RuleDispositionMetrics[]> {
	const rows = await db
		.select({
			ruleId: rules.id,
			ruleName: rules.name,
			ruleStatus: rules.status,
			action: ruleVersions.action,
			tier: ruleVersions.tier,
			priority: ruleVersions.priority
		})
		.from(rules)
		.innerJoin(ruleVersions, eq(rules.currentVersionId, ruleVersions.id))
		.where(eq(rules.accountId, accountId))
		.orderBy(asc(ruleVersions.priority))
		.all();

	const out: RuleDispositionMetrics[] = [];
	for (const r of rows) {
		const tier = r.tier as RuleTier;
		for (const action of parseAllowedActions(tier, r.action)) {
			const metrics = await dispositionMetrics(accountId, r.ruleId, action);
			out.push({
				...metrics,
				ruleName: r.ruleName,
				ruleStatus: r.ruleStatus as RuleStatus,
				tier,
				priority: r.priority
			});
		}
	}
	return out;
}

/**
 * The run loop's lookup: which (rule, disposition) pairs are live on auto.
 * Keyed `${ruleId}::${action}`. A pinned or suspended rule never appears.
 */
export async function loadAutoDispositions(accountId: string): Promise<Set<string>> {
	const rows = await db
		.select({ ruleId: ruleDispositions.ruleId, action: ruleDispositions.action })
		.from(ruleDispositions)
		.innerJoin(rules, eq(ruleDispositions.ruleId, rules.id))
		.where(
			and(
				eq(rules.accountId, accountId),
				ne(rules.status, 'suspended'),
				eq(ruleDispositions.status, 'auto'),
				eq(ruleDispositions.manualOnly, false)
			)
		)
		.all();
	return new Set(rows.map((r) => `${r.ruleId}::${r.action}`));
}

export async function getDispositionStatus(ruleId: string, action: RuleAction): Promise<RuleStatus> {
	const row = await db
		.select({ status: ruleDispositions.status })
		.from(ruleDispositions)
		.where(and(eq(ruleDispositions.ruleId, ruleId), eq(ruleDispositions.action, action)))
		.get();
	return (row?.status as RuleStatus) ?? 'proposing';
}

/**
 * Suggest-and-confirm: a human click sets a disposition to 'auto' (or back).
 * Refuses to promote a pinned disposition, and re-checks the gate on the way up
 * so the only path to 'auto' is one that actually earned it.
 */
export async function setDispositionStatus(
	accountId: string,
	ruleId: string,
	action: RuleAction,
	status: RuleStatus
): Promise<void> {
	const rule = await db
		.select({ id: rules.id })
		.from(rules)
		.where(and(eq(rules.id, ruleId), eq(rules.accountId, accountId)))
		.get();
	if (!rule) throw new Error('Rule not found for this account.');

	const disposition = await db
		.select({ id: ruleDispositions.id })
		.from(ruleDispositions)
		.where(and(eq(ruleDispositions.ruleId, ruleId), eq(ruleDispositions.action, action)))
		.get();
	if (!disposition) {
		throw new Error('Disposition not found; apply the rule-disposition database migration first.');
	}

	if (status === 'auto') {
		const metrics = await dispositionMetrics(accountId, ruleId, action);
		if (metrics.manualOnly) {
			throw new Error('This disposition is pinned to manual review and cannot auto-apply.');
		}
		if (!metrics.eligible) {
			throw new Error(
				`Not eligible for auto-apply yet: ${metrics.leadingSuccessRun}/${metrics.minRun} consecutive approvals at ${metrics.approvalPct ?? 0}% (needs ${metrics.minApprovalPct}%).`
			);
		}
	}
	await db
		.update(ruleDispositions)
		.set({ status, updatedAt: new Date() })
		.where(and(eq(ruleDispositions.ruleId, ruleId), eq(ruleDispositions.action, action)));
}

/**
 * Pin/unpin a disposition to propose-only. Pinning also demotes it out of 'auto'
 * immediately — the point of the pin is "never act on this without asking me".
 */
export async function setDispositionManualOnly(
	ruleId: string,
	action: RuleAction,
	manualOnly: boolean
): Promise<void> {
	await db
		.update(ruleDispositions)
		.set({
			manualOnly,
			...(manualOnly ? { status: 'proposing' as const } : {}),
			updatedAt: new Date()
		})
		.where(and(eq(ruleDispositions.ruleId, ruleId), eq(ruleDispositions.action, action)));
}

/** Demote every disposition of a rule back to 'proposing' (on a new version). */
export async function resetDispositions(ruleId: string): Promise<void> {
	await db
		.update(ruleDispositions)
		.set({ status: 'proposing', updatedAt: new Date() })
		.where(eq(ruleDispositions.ruleId, ruleId));
}

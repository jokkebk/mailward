import { db } from '../db';
import { proposals, rules, ruleVersions, threads } from '../db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { toThreadView } from './view';
import type {
	Confidence,
	ProposalGroup,
	ProposalItem,
	RuleAction,
	RuleStatus,
	RuleTier,
	ThreadView
} from '$lib/types/rules';

export interface NewProposal {
	runId: string;
	accountId: string;
	ruleId: string;
	ruleVersionId: string;
	threadId: string;
	messageIds: string[];
	action: RuleAction; // disposition
	source: 'deterministic' | 'ai';
	confidence?: Confidence | null;
	reason?: string | null;
}

/** Persist proposed classifications produced during a run (status='proposed'). */
export async function writeProposals(rows: NewProposal[]): Promise<void> {
	if (rows.length === 0) return;
	await db.insert(proposals).values(
		rows.map((r) => ({
			runId: r.runId,
			accountId: r.accountId,
			ruleId: r.ruleId,
			ruleVersionId: r.ruleVersionId,
			threadId: r.threadId,
			messageIds: JSON.stringify(r.messageIds),
			action: r.action,
			source: r.source,
			confidence: r.confidence ?? null,
			reason: r.reason ?? null,
			status: 'proposed' as const,
			createdAt: new Date()
		}))
	);
}

/** The most recent run for an account (for reload rehydration). */
export async function latestRunId(accountId: string): Promise<string | null> {
	const row = await db
		.select({ id: proposals.runId })
		.from(proposals)
		.where(and(eq(proposals.accountId, accountId), eq(proposals.status, 'proposed')))
		.orderBy(desc(proposals.createdAt))
		.get();
	return row?.id ?? null;
}

/**
 * Build the rule-grouped proposal view from persisted rows (status='proposed'),
 * joined to their threads + current rule metadata, in priority order. Used both
 * by runTriage's return and by reload rehydration.
 */
export async function loadOpenProposals(
	accountId: string,
	runId: string
): Promise<ProposalGroup[]> {
	const rows = await db
		.select({
			p: proposals,
			t: threads,
			ruleName: rules.name,
			ruleStatus: rules.status,
			priority: ruleVersions.priority,
			intent: ruleVersions.intent,
			ruleAction: ruleVersions.action,
			tier: ruleVersions.tier
		})
		.from(proposals)
		.innerJoin(threads, eq(proposals.threadId, threads.id))
		.innerJoin(ruleVersions, eq(proposals.ruleVersionId, ruleVersions.id))
		.innerJoin(rules, eq(proposals.ruleId, rules.id))
		.where(
			and(
				eq(proposals.accountId, accountId),
				eq(proposals.runId, runId),
				eq(proposals.status, 'proposed')
			)
		)
		.all();

	const groups = new Map<string, ProposalGroup>();
	for (const r of rows) {
		const key = r.p.ruleVersionId;
		let g = groups.get(key);
		if (!g) {
			const tier = r.tier as RuleTier;
			// Representative action: deterministic = the scalar; AI = per-thread (placeholder).
			const representative: RuleAction =
				tier === 'ai' ? (r.p.action as RuleAction) : (r.ruleAction as RuleAction);
			g = {
				ruleId: r.p.ruleId,
				versionId: r.p.ruleVersionId,
				name: r.ruleName,
				intent: r.intent,
				action: representative,
				tier,
				status: r.ruleStatus as RuleStatus,
				priority: r.priority,
				threads: []
			};
			groups.set(key, g);
		}
		const item: ProposalItem = {
			...toThreadView(r.t),
			proposalId: r.p.id,
			action: r.p.action as RuleAction,
			source: r.p.source as 'deterministic' | 'ai',
			confidence: (r.p.confidence as Confidence | null) ?? null,
			reason: r.p.reason
		};
		g.threads.push(item);
	}

	const out = [...groups.values()];
	for (const g of out) g.threads.sort((a, b) => b.receivedAt - a.receivedAt);
	out.sort((a, b) => a.priority - b.priority);
	return out;
}

/**
 * Rehydrate the latest run's open proposals + a best-effort uncovered list, so a
 * page reload restores the review screen without re-running (and re-paying AI).
 * Leftovers aren't persisted, so they're recomputed as unread/not-TODO threads
 * not claimed by an open proposal.
 */
export async function loadRehydration(accountId: string): Promise<{
	runId: string | null;
	proposals: ProposalGroup[];
	leftovers: ThreadView[];
}> {
	const runId = await latestRunId(accountId);
	if (!runId) return { runId: null, proposals: [], leftovers: [] };

	const groups = await loadOpenProposals(accountId, runId);
	const claimed = new Set(groups.flatMap((g) => g.threads.map((t) => t.id)));

	const rows = await db
		.select()
		.from(threads)
		.where(and(eq(threads.accountId, accountId), eq(threads.isUnread, true)))
		.all();
	const leftovers = rows
		.map(toThreadView)
		.filter((v) => !v.labelIds.includes('TODO') && !claimed.has(v.id))
		.sort((a, b) => b.receivedAt - a.receivedAt);

	return { runId, proposals: groups, leftovers };
}

/** Look up the open proposal for a thread within a batch (apply reads disposition here). */
export async function getOpenProposal(opts: {
	accountId: string;
	runId: string;
	ruleId: string;
	threadId: string;
}) {
	return db
		.select()
		.from(proposals)
		.where(
			and(
				eq(proposals.accountId, opts.accountId),
				eq(proposals.runId, opts.runId),
				eq(proposals.ruleId, opts.ruleId),
				eq(proposals.threadId, opts.threadId),
				eq(proposals.status, 'proposed')
			)
		)
		.get();
}

/** Flip one proposal's lifecycle status (proposed → applied/skipped). */
export async function setProposalStatus(
	proposalId: string,
	status: 'applied' | 'skipped' | 'rejected' | 'superseded'
): Promise<void> {
	await db
		.update(proposals)
		.set({ status, decidedAt: new Date() })
		.where(eq(proposals.id, proposalId));
}

/** Mark all open proposals in a batch as rejected (whole-batch reject). */
export async function rejectBatch(opts: {
	accountId: string;
	runId: string;
	ruleId: string;
}): Promise<void> {
	await db
		.update(proposals)
		.set({ status: 'rejected', decidedAt: new Date() })
		.where(
			and(
				eq(proposals.accountId, opts.accountId),
				eq(proposals.runId, opts.runId),
				eq(proposals.ruleId, opts.ruleId),
				eq(proposals.status, 'proposed')
			)
		);
}

/**
 * Supersede every still-open proposal for an account. Called at the start of a
 * run (before it writes its own) so only the latest run's proposals are live —
 * a reload always rehydrates the most recent run, never a stale mix.
 */
export async function supersedeOpenProposals(accountId: string): Promise<void> {
	await db
		.update(proposals)
		.set({ status: 'superseded', decidedAt: new Date() })
		.where(and(eq(proposals.accountId, accountId), eq(proposals.status, 'proposed')));
}

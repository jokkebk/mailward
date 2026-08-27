import { db } from '../db';
import { actions, proposals, rules, threads } from '../db/schema';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Confidence, DigestGroup, DigestItem, RuleAction } from '$lib/types/rules';

/**
 * Receipts: what a run did, per (rule, disposition), after the fact. Two kinds share
 * this shape — what autopilot did without asking (see `loadAutoDigest`) and what your
 * review decided (`loadReviewedDigest`) — so a reviewed rule can shrink to the same
 * one-line summary instead of vanishing from the queue.
 */

export function emptyGroup(ruleId: string, ruleName: string, action: RuleAction): DigestGroup {
	return {
		ruleId,
		ruleName,
		action,
		applied: 0,
		flagged: 0,
		rolledBack: 0,
		failed: 0,
		skipped: 0,
		rejected: 0,
		items: []
	};
}

/** Add an item to its group and count it into the group's tallies. */
export function push(g: DigestGroup, item: DigestItem): void {
	if (item.status === 'applied') g.applied++;
	else if (item.status === 'rolled_back') g.rolledBack++;
	else if (item.status === 'skipped') g.skipped++;
	else if (item.status === 'rejected') g.rejected++;
	else g.failed++;
	if (item.flagged && item.status === 'applied') g.flagged++;
	g.items.push(item);
}

/** Failed and flagged rows first — they are the ones worth a human's eyes. */
export function sortDigest(groups: DigestGroup[]): DigestGroup[] {
	for (const g of groups) {
		g.items.sort((a, b) => {
			const rank = (i: DigestItem) =>
				i.status === 'failed' ? 0 : i.flagged ? 1 : i.status === 'applied' ? 2 : 3;
			return rank(a) - rank(b) || b.receivedAt - a.receivedAt;
		});
	}
	groups.sort(
		(a, b) => b.applied - a.applied || b.items.length - a.items.length || a.ruleName.localeCompare(b.ruleName)
	);
	return groups;
}

export function toMillis(receivedAt: unknown): number {
	return receivedAt instanceof Date ? receivedAt.getTime() : Number(receivedAt ?? 0);
}

/**
 * The "you decided this" receipt for a run: every proposal the review screen showed
 * and what became of it — applied, left alone in an amend, or declined with the batch.
 *
 * Driven by `proposals` rather than `actions` precisely so the declined ones survive:
 * a reject writes verdicts and no action, and would otherwise disappear without trace.
 * Auto-applied rows also land in `proposals`, so they are excluded by their action's
 * mode — they belong to the autopilot receipt.
 */
export async function loadReviewedDigest(
	accountId: string,
	runId: string
): Promise<DigestGroup[]> {
	const rows = await db
		.select({
			p: proposals,
			ruleName: rules.name,
			subject: threads.subject,
			from: threads.from,
			snippet: threads.snippet,
			receivedAt: threads.receivedAt,
			actionId: actions.id,
			actionStatus: actions.status,
			actionMode: actions.mode,
			actionError: actions.error
		})
		.from(proposals)
		.innerJoin(rules, eq(proposals.ruleId, rules.id))
		.leftJoin(threads, eq(proposals.threadId, threads.id))
		.leftJoin(
			actions,
			and(
				eq(actions.runId, proposals.runId),
				eq(actions.ruleId, proposals.ruleId),
				eq(actions.threadId, proposals.threadId)
			)
		)
		.where(
			and(
				eq(proposals.accountId, accountId),
				eq(proposals.runId, runId),
				inArray(proposals.status, ['applied', 'skipped', 'rejected'])
			)
		)
		.orderBy(asc(rules.name))
		.all();

	// A thread that failed and was retried has more than one action row, so the join
	// can return a proposal twice. Collapse to its real outcome first — otherwise the
	// same email is counted (and listed) twice.
	const rank = (status: string | null) =>
		status === 'applied' ? 0 : status === 'rolled_back' ? 1 : status === 'failed' ? 2 : 3;
	const best = new Map<string, (typeof rows)[number]>();
	for (const r of rows) {
		if (r.actionMode === 'auto') continue;
		const prev = best.get(r.p.id);
		if (!prev || rank(r.actionStatus) < rank(prev.actionStatus)) best.set(r.p.id, r);
	}

	const groups = new Map<string, DigestGroup>();
	for (const r of best.values()) {
		const action = r.p.action as RuleAction;
		const key = `${r.p.ruleId}::${action}`;
		let g = groups.get(key);
		if (!g) {
			g = emptyGroup(r.p.ruleId, r.ruleName, action);
			groups.set(key, g);
		}

		// An applied proposal takes its outcome from the action row (which is what an
		// undo flips); the other two statuses never produced one.
		const status = (
			r.p.status === 'applied' ? (r.actionStatus ?? 'applied') : r.p.status
		) as DigestItem['status'];

		push(g, {
			actionId: r.actionId ?? null,
			threadId: r.p.threadId,
			from: r.from ?? '',
			subject: r.subject,
			snippet: r.snippet,
			receivedAt: toMillis(r.receivedAt),
			action,
			confidence: (r.p.confidence as Confidence | null) ?? null,
			reason: r.p.reason,
			status,
			flagged: r.p.confidence === 'low',
			error: r.actionError
		});
	}

	return sortDigest([...groups.values()]);
}

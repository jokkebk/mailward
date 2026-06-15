import { db } from '../db';
import { runs, threads, verdicts } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { syncUnreadInbox } from '../gmail/sync';
import { getResolvedRules, seedDefaultRulesIfEmpty } from './rules';
import { matchesRule } from '$lib/utils/matcher';
import { ageDays } from '../utils';
import { MAX_THREADS_PER_RUN } from '$lib/constants';
import type { ProposalGroup, ThreadView } from '$lib/types/rules';

export interface RunResult {
	runId: string;
	synced: number;
	autoDigest: unknown[]; // empty in v1 (no auto-apply yet)
	proposals: ProposalGroup[];
	leftovers: ThreadView[];
}

function toView(row: typeof threads.$inferSelect): ThreadView {
	const labelIds: string[] = row.labelIds ? JSON.parse(row.labelIds) : [];
	const messageIds: string[] = row.messageIds ? JSON.parse(row.messageIds) : [];
	const receivedMs = row.receivedAt instanceof Date ? row.receivedAt.getTime() : Number(row.receivedAt);
	return {
		id: row.id,
		from: row.from,
		fromDomain: row.fromDomain,
		subject: row.subject,
		snippet: row.snippet,
		receivedAt: receivedMs,
		ageDays: ageDays(receivedMs),
		labelIds,
		messageIds
	};
}

/**
 * Run a triage session: sync, then evaluate deterministic rules in priority
 * order with claim-and-remove. Returns proposals grouped by rule + the
 * uncovered leftover pile. v1 is propose-only (no auto-apply).
 */
export async function runTriage(accountId: string): Promise<RunResult> {
	await seedDefaultRulesIfEmpty(accountId);

	const run = await db
		.insert(runs)
		.values({
			accountId,
			scope: `unread-in-inbox cap ${MAX_THREADS_PER_RUN}`,
			status: 'running',
			startedAt: new Date()
		})
		.returning({ id: runs.id })
		.get();

	const { syncedCount } = await syncUnreadInbox(accountId);

	// Candidate pool: unread threads for this account, minus those already
	// triaged to TODO (they stay unread by design but shouldn't be re-proposed).
	const rows = await db
		.select()
		.from(threads)
		.where(and(eq(threads.accountId, accountId), eq(threads.isUnread, true)))
		.all();

	const pool = new Map<string, ThreadView>();
	for (const row of rows) {
		const view = toView(row);
		if (view.labelIds.includes('TODO')) continue; // already handled
		pool.set(view.id, view);
	}

	// Dedup: (thread, ruleVersion) already decided -> don't re-surface for that rule.
	const decided = new Set<string>();
	for (const v of await db
		.select({ threadId: verdicts.threadId, ruleVersionId: verdicts.ruleVersionId })
		.from(verdicts)
		.where(eq(verdicts.accountId, accountId))
		.all()) {
		decided.add(`${v.threadId}::${v.ruleVersionId}`);
	}

	const resolved = await getResolvedRules(accountId);
	const proposals: ProposalGroup[] = [];

	for (const rule of resolved) {
		if (rule.status === 'suspended') continue;
		if (rule.tier === 'ai') continue; // v1: deterministic only

		const matched: ThreadView[] = [];
		for (const view of pool.values()) {
			if (decided.has(`${view.id}::${rule.versionId}`)) continue;
			if (matchesRule(view, rule.matchCriteria)) matched.push(view);
		}

		if (matched.length === 0) continue;

		// Claim & remove so lower-priority rules never see these threads.
		for (const v of matched) pool.delete(v.id);

		proposals.push({
			ruleId: rule.ruleId,
			versionId: rule.versionId,
			name: rule.name,
			intent: rule.intent,
			action: rule.action,
			status: rule.status,
			priority: rule.priority,
			threads: matched
		});
	}

	const leftovers = [...pool.values()].sort((a, b) => b.receivedAt - a.receivedAt);

	await db
		.update(runs)
		.set({ status: 'completed', endedAt: new Date() })
		.where(eq(runs.id, run.id));

	return { runId: run.id, synced: syncedCount, autoDigest: [], proposals, leftovers };
}

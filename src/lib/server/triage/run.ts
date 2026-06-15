import { db } from '../db';
import { runs, threads, verdicts } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { syncUnreadInbox } from '../gmail/sync';
import { fetchMessageBody } from '../gmail/body';
import { getResolvedRules, seedDefaultRulesIfEmpty } from './rules';
import { matchesRule } from '$lib/utils/matcher';
import { toThreadView } from './view';
import {
	loadOpenProposals,
	supersedeOpenProposals,
	writeProposals,
	type NewProposal
} from './proposals';
import { getClassifier, type ThreadPayload } from '../ai';
import { AI_BATCH_SIZE, MAX_THREADS_PER_RUN } from '$lib/constants';
import type { ProposalGroup, ResolvedRule, ThreadView } from '$lib/types/rules';

export interface RunResult {
	runId: string;
	synced: number | null; // null when the sync step was skipped
	autoDigest: unknown[]; // empty until auto-apply is wired
	proposals: ProposalGroup[];
	leftovers: ThreadView[];
}

export interface RunOptions {
	/** Fetch fresh unread threads from Gmail before evaluating rules. Skip to
	 *  re-run rules against the already-synced pool (fast dev iteration). */
	sync?: boolean;
}

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

function toPayload(v: ThreadView, body?: string): ThreadPayload {
	return {
		threadId: v.id,
		from: v.from,
		to: v.to,
		subject: v.subject,
		snippet: v.snippet,
		ageDays: v.ageDays,
		labels: v.labelIds,
		isCalendarInvite: v.isCalendarInvite,
		hasUnsubscribe: v.hasUnsubscribe,
		body
	};
}

/**
 * Run a triage session: sync, then evaluate rules in priority order with
 * claim-and-remove. Deterministic rules match structurally; AI router rules
 * batch-classify their candidates into per-thread dispositions. Every claimed
 * thread is persisted as a `proposed` proposal row; the run is propose-only
 * (auto-apply is a separate, later phase). Returns the rule-grouped proposals
 * + the uncovered leftover pile.
 */
export async function runTriage(accountId: string, options: RunOptions = {}): Promise<RunResult> {
	const sync = options.sync ?? true;
	await seedDefaultRulesIfEmpty(accountId);

	const run = await db
		.insert(runs)
		.values({
			accountId,
			scope: `unread-in-inbox cap ${MAX_THREADS_PER_RUN}${sync ? '' : ' (no sync)'}`,
			status: 'running',
			startedAt: new Date()
		})
		.returning({ id: runs.id })
		.get();

	// Only the latest run's proposals stay live (reload always rehydrates this run).
	await supersedeOpenProposals(accountId);

	const syncedCount = sync ? (await syncUnreadInbox(accountId)).syncedCount : null;

	// Candidate pool: unread threads for this account, minus those already
	// triaged to TODO (they stay unread by design but shouldn't be re-proposed).
	const rows = await db
		.select()
		.from(threads)
		.where(and(eq(threads.accountId, accountId), eq(threads.isUnread, true)))
		.all();

	const pool = new Map<string, ThreadView>();
	for (const row of rows) {
		const view = toThreadView(row);
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
	const collected: NewProposal[] = [];

	for (const rule of resolved) {
		if (rule.status === 'suspended') continue;

		const candidates: ThreadView[] = [];
		for (const view of pool.values()) {
			if (decided.has(`${view.id}::${rule.versionId}`)) continue;
			if (matchesRule(view, rule.matchCriteria)) candidates.push(view);
		}
		if (candidates.length === 0) continue;

		if (rule.tier === 'ai') {
			await classifyRule(accountId, run.id, rule, candidates, pool, collected);
		} else {
			for (const v of candidates) {
				pool.delete(v.id); // claim & remove
				collected.push({
					runId: run.id,
					accountId,
					ruleId: rule.ruleId,
					ruleVersionId: rule.versionId,
					threadId: v.id,
					messageIds: v.messageIds,
					action: rule.action,
					source: 'deterministic'
				});
			}
		}
	}

	await writeProposals(collected);

	const leftovers = [...pool.values()].sort((a, b) => b.receivedAt - a.receivedAt);

	await db
		.update(runs)
		.set({ status: 'completed', endedAt: new Date() })
		.where(eq(runs.id, run.id));

	const proposals = await loadOpenProposals(accountId, run.id);
	return { runId: run.id, synced: syncedCount, autoDigest: [], proposals, leftovers };
}

/**
 * Classify one AI router rule's candidate batch. Threads the model dispositions
 * to a real action are claimed + queued as proposals; `leave` (or a model-call
 * failure) leaves them in the pool to fall through to later rules / uncovered.
 */
async function classifyRule(
	accountId: string,
	runId: string,
	rule: ResolvedRule,
	candidates: ThreadView[],
	pool: Map<string, ThreadView>,
	collected: NewProposal[]
): Promise<void> {
	const classifier = getClassifier();
	const intent = rule.intent ?? rule.name;
	const allowed = new Set(rule.allowedActions);

	// Fetch bodies once (only when the rule declares it), keyed by thread.
	const bodies = new Map<string, string>();
	if (rule.needsBody) {
		for (const v of candidates) {
			if (v.messageIds[0]) bodies.set(v.id, await fetchMessageBody(accountId, v.messageIds[0]));
		}
	}

	for (const batch of chunk(candidates, AI_BATCH_SIZE)) {
		const payloads = batch.map((v) => toPayload(v, bodies.get(v.id)));
		let verdicts;
		try {
			verdicts = await classifier.classify({ intent, allowedActions: rule.allowedActions, threads: payloads });
		} catch (err) {
			// Model-call failure: leave this batch uncovered; it reappears next run.
			console.error(`AI rule "${rule.name}" classify failed:`, err);
			continue;
		}

		for (const verdict of verdicts) {
			if (verdict.action === 'leave' || !allowed.has(verdict.action)) continue;
			const view = pool.get(verdict.threadId);
			if (!view) continue; // already claimed by an earlier rule this run
			pool.delete(verdict.threadId); // claim & remove
			collected.push({
				runId,
				accountId,
				ruleId: rule.ruleId,
				ruleVersionId: rule.versionId,
				threadId: view.id,
				messageIds: view.messageIds,
				action: verdict.action,
				source: 'ai',
				confidence: verdict.confidence,
				reason: verdict.reason
			});
		}
	}
}

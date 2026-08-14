import { db } from '../db';
import { aiClassifications, runs, threads, verdicts } from '../db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { syncUnreadInbox } from '../gmail/sync';
import { fetchMessageBody } from '../gmail/body';
import { isReauthError } from '../gmail/errors';
import { getResolvedRules, seedDefaultRulesIfEmpty } from './rules';
import { matchesRule } from '$lib/utils/matcher';
import { toThreadView } from './view';
import {
	loadOpenProposals,
	supersedeOpenProposals,
	writeProposals,
	type NewProposal
} from './proposals';
import { applyAutoActions, loadAutoDigest, partitionAutoApply } from './auto';
import { getClassifier, type ClassifyVerdict, type ThreadPayload } from '../ai';
import { AI_BATCH_SIZE, MAX_THREADS_PER_RUN } from '$lib/constants';
import type {
	AutoDigestGroup,
	Confidence,
	Disposition,
	ProposalGroup,
	ResolvedRule,
	ThreadView
} from '$lib/types/rules';
import {
	failStep,
	finishStep,
	markStaleRuns,
	recordAiCall,
	startStep,
	updateStep
} from './telemetry';

export interface RunResult {
	runId: string;
	synced: number | null; // null when the sync step was skipped
	/** What promoted dispositions did without asking — the "this was done" receipt. */
	autoDigest: AutoDigestGroup[];
	proposals: ProposalGroup[];
	leftovers: ThreadView[];
}

export interface RunOptions {
	/** Fetch fresh unread threads from Gmail before evaluating rules. Skip to
	 *  re-run rules against the already-synced pool (fast dev iteration). */
	sync?: boolean;
	runId?: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			out[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
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

interface CachedAiClassification {
	threadId: string;
	action: Disposition;
	confidence: Confidence;
	reason: string | null;
}

async function loadCachedAiClassifications(
	accountId: string,
	ruleVersionId: string,
	candidates: ThreadView[]
): Promise<Map<string, CachedAiClassification>> {
	const threadIds = candidates.map((v) => v.id);
	if (threadIds.length === 0) return new Map();
	const currentMessageIds = new Map(candidates.map((v) => [v.id, JSON.stringify(v.messageIds)]));
	const out = new Map<string, CachedAiClassification>();
	for (const ids of chunk(threadIds, 500)) {
		const rows = await db
			.select()
			.from(aiClassifications)
			.where(
				and(
					eq(aiClassifications.accountId, accountId),
					eq(aiClassifications.ruleVersionId, ruleVersionId),
					inArray(aiClassifications.threadId, ids)
				)
			)
			.all();
		for (const row of rows) {
			if (row.messageIds !== currentMessageIds.get(row.threadId)) continue;
			out.set(row.threadId, {
				threadId: row.threadId,
				action: row.action as Disposition,
				confidence: row.confidence as Confidence,
				reason: row.reason
			});
		}
	}
	return out;
}

async function writeAiClassificationCache(input: {
	accountId: string;
	runId: string;
	rule: ResolvedRule;
	views: Map<string, ThreadView>;
	verdicts: ClassifyVerdict[];
}): Promise<void> {
	if (input.verdicts.length === 0) return;
	const now = new Date();
	const threadIds = input.verdicts.map((verdict) => verdict.threadId);
	await db
		.delete(aiClassifications)
		.where(
			and(
				eq(aiClassifications.accountId, input.accountId),
				eq(aiClassifications.ruleVersionId, input.rule.versionId),
				inArray(aiClassifications.threadId, threadIds)
			)
		);
	await db.insert(aiClassifications).values(
		input.verdicts.map((verdict) => {
			const view = input.views.get(verdict.threadId);
			return {
				id: crypto.randomUUID(),
				accountId: input.accountId,
				ruleId: input.rule.ruleId,
				ruleVersionId: input.rule.versionId,
				threadId: verdict.threadId,
				messageIds: JSON.stringify(view?.messageIds ?? []),
				action: verdict.action,
				confidence: verdict.confidence,
				reason: verdict.reason,
				sourceRunId: input.runId,
				createdAt: now,
				updatedAt: now
			};
		})
	);
}

export async function createTriageRun(accountId: string, sync: boolean): Promise<string> {
	await markStaleRuns(accountId);
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
	return run.id;
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
	const runId = options.runId ?? (await createTriageRun(accountId, sync));
	const bodyCache = new Map<string, string>();
	let selectedSyncThreadIds: Set<string> | null = null;

	try {
		const setupStep = await startStep({ runId, accountId, stage: 'setup' });
		await seedDefaultRulesIfEmpty(accountId);
		// Only the latest run's proposals stay live (reload always rehydrates this run).
		await supersedeOpenProposals(accountId);
		await finishStep(setupStep);

		let syncedCount: number | null = null;
		if (sync) {
			const listStep = await startStep({ runId, accountId, stage: 'gmail_list' });
			let metadataStep: string | null = null;
			const syncResult = await syncUnreadInbox(accountId, {
				onList: async (totalThreads) => {
					await finishStep(listStep, {
						current: totalThreads,
						total: totalThreads,
						metadata: { query: `is:unread in:inbox newer_than`, totalThreads }
					});
					metadataStep = await startStep({
						runId,
						accountId,
						stage: 'metadata_sync',
						current: 0,
						total: Math.min(totalThreads, MAX_THREADS_PER_RUN)
					});
				},
				onMetadata: async ({ current, total }) => {
					if (metadataStep) await updateStep(metadataStep, { current, total });
				}
			});
			syncedCount = syncResult.syncedCount;
			selectedSyncThreadIds = new Set(syncResult.selectedThreadIds);
			if (metadataStep) {
				await finishStep(metadataStep, {
					current: syncedCount,
					total: Math.min(syncResult.totalThreads, MAX_THREADS_PER_RUN),
					metadata: {
						syncedCount,
						staleCount: syncResult.staleCount,
						totalThreads: syncResult.totalThreads
					}
				});
			}
		}

		// Candidate pool: unread threads for this account, minus those already
		// triaged to TODO (they stay unread by design but shouldn't be re-proposed).
		const poolStep = await startStep({ runId, accountId, stage: 'load_pool' });
		const rows = await db
			.select()
			.from(threads)
			.where(and(eq(threads.accountId, accountId), eq(threads.isUnread, true)))
			.all();

		const pool = new Map<string, ThreadView>();
		for (const row of rows) {
			const view = toThreadView(row);
			if (selectedSyncThreadIds && !selectedSyncThreadIds.has(view.id)) continue;
			if (view.labelIds.includes('TODO')) continue; // already handled
			pool.set(view.id, view);
		}
		await finishStep(poolStep, {
			current: pool.size,
			total: rows.length,
			metadata: { unreadRows: rows.length, candidatePool: pool.size }
		});

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

			const beforePoolSize = pool.size;
			const filterStep = await startStep({
				runId,
				accountId,
				stage: 'rule_filter',
				ruleId: rule.ruleId,
				ruleVersionId: rule.versionId,
				ruleName: rule.name,
				total: beforePoolSize,
				metadata: { tier: rule.tier, needsBody: rule.needsBody, poolSize: beforePoolSize }
			});
			const candidates: ThreadView[] = [];
			for (const view of pool.values()) {
				if (decided.has(`${view.id}::${rule.versionId}`)) continue;
				if (matchesRule(view, rule.matchCriteria)) candidates.push(view);
			}

			const warnings =
				rule.needsBody && beforePoolSize >= 10 && candidates.length / beforePoolSize >= 0.8
					? ['needs_body matched most unread candidates; this rule may fetch many bodies']
					: [];

			if (rule.tier === 'ai') {
				await finishStep(filterStep, {
					current: beforePoolSize,
					total: beforePoolSize,
					matchedCount: candidates.length,
					metadata: {
						tier: rule.tier,
						needsBody: rule.needsBody,
						poolSize: beforePoolSize,
						warnings
					}
				});
				if (candidates.length > 0) {
					await classifyRule(accountId, runId, rule, candidates, pool, collected, bodyCache);
				}
			} else {
				for (const v of candidates) {
					pool.delete(v.id); // claim & remove
					collected.push({
						runId,
						accountId,
						ruleId: rule.ruleId,
						ruleVersionId: rule.versionId,
						threadId: v.id,
						messageIds: v.messageIds,
						action: rule.action,
						source: 'deterministic'
					});
				}
				await finishStep(filterStep, {
					current: beforePoolSize,
					total: beforePoolSize,
					matchedCount: candidates.length,
					claimedCount: candidates.length,
					metadata: {
						tier: rule.tier,
						needsBody: rule.needsBody,
						poolSize: beforePoolSize,
						warnings
					}
				});
			}
		}

		// Promoted dispositions act now and report afterwards; the rest queue for review.
		const partition = await partitionAutoApply(accountId, collected);

		const autoStep = await startStep({
			runId,
			accountId,
			stage: 'auto_apply',
			current: 0,
			total: partition.auto.length
		});
		const autoResult = await applyAutoActions(accountId, runId, partition);
		await finishStep(autoStep, {
			current: partition.auto.length,
			total: partition.auto.length,
			metadata: { applied: autoResult.applied, failed: autoResult.failed }
		});

		const writeStep = await startStep({
			runId,
			accountId,
			stage: 'write_proposals',
			current: 0,
			total: partition.propose.length
		});
		await writeProposals(partition.propose);
		await finishStep(writeStep, {
			current: partition.propose.length,
			total: partition.propose.length
		});

		const leftovers = [...pool.values()].sort((a, b) => b.receivedAt - a.receivedAt);

		const finalizeStep = await startStep({ runId, accountId, stage: 'finalize' });
		await db
			.update(runs)
			.set({ status: 'completed', endedAt: new Date() })
			.where(eq(runs.id, runId));
		await finishStep(finalizeStep, {
			metadata: {
				proposals: partition.propose.length,
				autoApplied: autoResult.applied,
				leftovers: leftovers.length,
				syncedCount
			}
		});

		const proposals = await loadOpenProposals(accountId, runId);
		const autoDigest = await loadAutoDigest(accountId, runId);
		return { runId, synced: syncedCount, autoDigest, proposals, leftovers };
	} catch (error) {
		await db
			.update(runs)
			.set({ status: isReauthError(error) ? 'reauth_required' : 'failed', endedAt: new Date() })
			.where(eq(runs.id, runId));
		throw error;
	}
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
	collected: NewProposal[],
	bodyCache: Map<string, string>
): Promise<void> {
	const classifier = getClassifier();
	const intent = rule.intent ?? rule.name;
	const allowed = new Set(rule.allowedActions);
	const cached = await loadCachedAiClassifications(
		accountId,
		rule.versionId,
		candidates
	);
	const uncachedCandidates: ThreadView[] = [];
	let cachedClaimed = 0;

	for (const candidate of candidates) {
		const verdict = cached.get(candidate.id);
		if (!verdict) {
			uncachedCandidates.push(candidate);
			continue;
		}
		if (verdict.action === 'leave' || !allowed.has(verdict.action)) continue;
		const view = pool.get(verdict.threadId);
		if (!view) continue;
		pool.delete(verdict.threadId);
		cachedClaimed++;
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

	// Fetch bodies once (only when the rule declares it), keyed by thread.
	const bodies = new Map<string, string>();
	if (rule.needsBody && uncachedCandidates.length > 0) {
		const bodyStep = await startStep({
			runId,
			accountId,
			stage: 'body_fetch',
			ruleId: rule.ruleId,
			ruleVersionId: rule.versionId,
			ruleName: rule.name,
			current: 0,
			total: uncachedCandidates.length,
			metadata: {
				tier: rule.tier,
				needsBody: rule.needsBody,
				poolSize: candidates.length,
				cacheHits: cached.size
			}
		});
		let done = 0;
		let fetched = 0;
		await mapLimit(uncachedCandidates, 6, async (v) => {
			const messageId = v.messageIds[0];
			if (messageId) {
				let body = bodyCache.get(messageId);
				if (body == null) {
					body = await fetchMessageBody(accountId, messageId);
					bodyCache.set(messageId, body);
					fetched++;
				}
				bodies.set(v.id, body);
			}
			done++;
			await updateStep(bodyStep, {
				current: done,
				total: uncachedCandidates.length,
				bodyFetchCount: fetched
			});
		});
		await finishStep(bodyStep, {
			current: done,
			total: uncachedCandidates.length,
			bodyFetchCount: fetched,
			metadata: {
				tier: rule.tier,
				needsBody: rule.needsBody,
				cacheSize: bodyCache.size,
				cacheHits: cached.size
			}
		});
	}

	const batches = chunk(uncachedCandidates, AI_BATCH_SIZE);
	for (const [index, batch] of batches.entries()) {
		const batchIndex = index + 1;
		const aiStep = await startStep({
			runId,
			accountId,
			stage: 'ai_batch',
			ruleId: rule.ruleId,
			ruleVersionId: rule.versionId,
			ruleName: rule.name,
			batchIndex,
			batchTotal: batches.length,
			current: 0,
			total: batch.length,
			aiBatchCount: batches.length,
			metadata: {
				tier: rule.tier,
				needsBody: rule.needsBody,
				poolSize: candidates.length,
				cacheHits: cached.size,
				cachedClaimed
			}
		});
		const payloads = batch.map((v) => toPayload(v, bodies.get(v.id)));
		const started = Date.now();
		let result;
		try {
			result = await classifier.classify({ intent, allowedActions: rule.allowedActions, threads: payloads });
		} catch (err) {
			// Model-call failure: leave this batch uncovered; it reappears next run.
			console.error(`AI rule "${rule.name}" classify failed:`, err);
			await recordAiCall({
				runId,
				accountId,
				ruleId: rule.ruleId,
				ruleVersionId: rule.versionId,
				ruleName: rule.name,
				batchIndex,
				batchTotal: batches.length,
				threadCount: batch.length,
				durationMs: Date.now() - started,
				status: 'failed',
				error: err instanceof Error ? err.message : String(err)
			});
			await failStep(aiStep, err, { current: 0, total: batch.length });
			continue;
		}

		await writeAiClassificationCache({
			accountId,
			runId,
			rule,
			views: new Map(batch.map((v) => [v.id, v])),
			verdicts: result.verdicts
		});

		let claimed = 0;
		for (const verdict of result.verdicts) {
			if (verdict.action === 'leave' || !allowed.has(verdict.action)) continue;
			const view = pool.get(verdict.threadId);
			if (!view) continue; // already claimed by an earlier rule this run
			pool.delete(verdict.threadId); // claim & remove
			claimed++;
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
		const durationMs = Date.now() - started;
		await recordAiCall({
			runId,
			accountId,
			ruleId: rule.ruleId,
			ruleVersionId: rule.versionId,
			ruleName: rule.name,
			batchIndex,
			batchTotal: batches.length,
			threadCount: batch.length,
			durationMs,
			status: 'completed',
			usage: result.usage
		});
		await finishStep(aiStep, {
			current: batch.length,
			total: batch.length,
			claimedCount: claimed,
			aiBatchCount: batches.length,
			metadata: { cacheHits: cached.size, cachedClaimed }
		});
	}
}

import { db } from '../db';
import { aiCallLogs, runSteps, runs, threads } from '../db/schema';
import { and, desc, eq, lt } from 'drizzle-orm';
import { loadOpenProposals } from './proposals';
import { toThreadView } from './view';
import type { ProposalGroup, ThreadView } from '$lib/types/rules';
import { aggregateRuleProgress, type RuleProgress } from './telemetry-progress';

export type RunStepStage =
	| 'setup'
	| 'gmail_list'
	| 'metadata_sync'
	| 'load_pool'
	| 'rule_filter'
	| 'body_fetch'
	| 'ai_batch'
	| 'auto_apply'
	| 'write_proposals'
	| 'finalize';

export interface StepInput {
	runId: string;
	accountId: string;
	stage: RunStepStage;
	ruleId?: string | null;
	ruleVersionId?: string | null;
	ruleName?: string | null;
	batchIndex?: number | null;
	batchTotal?: number | null;
	current?: number | null;
	total?: number | null;
	matchedCount?: number | null;
	claimedCount?: number | null;
	bodyFetchCount?: number | null;
	aiBatchCount?: number | null;
	metadata?: Record<string, unknown> | null;
}

export interface StepUpdate {
	current?: number | null;
	total?: number | null;
	matchedCount?: number | null;
	claimedCount?: number | null;
	bodyFetchCount?: number | null;
	aiBatchCount?: number | null;
	metadata?: Record<string, unknown> | null;
}

export interface AiUsage {
	provider: string;
	model: string;
	promptChars: number;
	responseChars: number;
	promptTokens?: number | null;
	responseTokens?: number | null;
	totalTokens?: number | null;
}

export interface AiCallLogInput {
	runId: string;
	accountId: string;
	ruleId: string;
	ruleVersionId: string;
	ruleName: string;
	batchIndex: number;
	batchTotal: number;
	threadCount: number;
	durationMs: number;
	status: 'completed' | 'failed';
	usage?: AiUsage | null;
	error?: string | null;
}

export interface ProgressStep {
	id: string;
	stage: string;
	status: string;
	ruleId: string | null;
	ruleVersionId: string | null;
	ruleName: string | null;
	batchIndex: number | null;
	batchTotal: number | null;
	current: number | null;
	total: number | null;
	matchedCount: number | null;
	claimedCount: number | null;
	bodyFetchCount: number | null;
	aiBatchCount: number | null;
	durationMs: number | null;
	error: string | null;
	metadata: Record<string, unknown> | null;
	startedAt: number;
	updatedAt: number;
	endedAt: number | null;
}

export interface RunProgress {
	runId: string;
	accountId: string;
	status: string;
	startedAt: number;
	endedAt: number | null;
	scope: string | null;
	activeStep: ProgressStep | null;
	recentSteps: ProgressStep[];
	rules: RuleProgress[];
	aiTotals: {
		calls: number;
		promptTokens: number | null;
		responseTokens: number | null;
		totalTokens: number | null;
		promptChars: number;
		responseChars: number;
	};
	warnings: string[];
	result?: {
		proposals: ProposalGroup[];
		leftovers: ThreadView[];
	};
}

function nowMs(): number {
	return Date.now();
}

function toDate(value: Date | number | null): Date | null {
	if (value === null) return null;
	return value instanceof Date ? value : new Date(value);
}

function elapsedMs(startedAt: Date | number): number {
	const start = startedAt instanceof Date ? startedAt.getTime() : startedAt;
	return Math.max(0, nowMs() - start);
}

function shortRun(id: string): string {
	return id.slice(0, 8);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function metadataJson(metadata?: Record<string, unknown> | null): string | null {
	return metadata ? JSON.stringify(metadata) : null;
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function stageLabel(input: {
	stage: string;
	ruleName?: string | null;
	batchIndex?: number | null;
	batchTotal?: number | null;
}): string {
	const bits: string[] = [input.stage];
	if (input.ruleName) bits.push(`rule="${input.ruleName}"`);
	if (input.batchIndex && input.batchTotal) bits.push(`batch ${input.batchIndex}/${input.batchTotal}`);
	return bits.join(' ');
}

function logStep(runId: string, message: string): void {
	console.log(`[run ${shortRun(runId)}] ${message}`);
}

export async function startStep(input: StepInput): Promise<string> {
	const id = crypto.randomUUID();
	const now = new Date();
	await db.insert(runSteps).values({
		id,
		runId: input.runId,
		accountId: input.accountId,
		stage: input.stage,
		status: 'running',
		ruleId: input.ruleId ?? null,
		ruleVersionId: input.ruleVersionId ?? null,
		ruleName: input.ruleName ?? null,
		batchIndex: input.batchIndex ?? null,
		batchTotal: input.batchTotal ?? null,
		current: input.current ?? 0,
		total: input.total ?? null,
		matchedCount: input.matchedCount ?? null,
		claimedCount: input.claimedCount ?? null,
		bodyFetchCount: input.bodyFetchCount ?? null,
		aiBatchCount: input.aiBatchCount ?? null,
		metadata: metadataJson(input.metadata),
		startedAt: now,
		updatedAt: now
	});
	logStep(input.runId, `start ${stageLabel(input)}`);
	return id;
}

export async function updateStep(id: string, update: StepUpdate): Promise<void> {
	await db
		.update(runSteps)
		.set({
			...('current' in update ? { current: update.current ?? null } : {}),
			...('total' in update ? { total: update.total ?? null } : {}),
			...('matchedCount' in update ? { matchedCount: update.matchedCount ?? null } : {}),
			...('claimedCount' in update ? { claimedCount: update.claimedCount ?? null } : {}),
			...('bodyFetchCount' in update ? { bodyFetchCount: update.bodyFetchCount ?? null } : {}),
			...('aiBatchCount' in update ? { aiBatchCount: update.aiBatchCount ?? null } : {}),
			...('metadata' in update ? { metadata: metadataJson(update.metadata) } : {}),
			updatedAt: new Date()
		})
		.where(eq(runSteps.id, id));
}

export async function finishStep(id: string, update: StepUpdate = {}): Promise<void> {
	const row = await db.select().from(runSteps).where(eq(runSteps.id, id)).get();
	if (!row) return;
	const endedAt = new Date();
	const durationMs = elapsedMs(row.startedAt);
	await db
		.update(runSteps)
		.set({
			status: 'completed',
			...('current' in update ? { current: update.current ?? null } : {}),
			...('total' in update ? { total: update.total ?? null } : {}),
			...('matchedCount' in update ? { matchedCount: update.matchedCount ?? null } : {}),
			...('claimedCount' in update ? { claimedCount: update.claimedCount ?? null } : {}),
			...('bodyFetchCount' in update ? { bodyFetchCount: update.bodyFetchCount ?? null } : {}),
			...('aiBatchCount' in update ? { aiBatchCount: update.aiBatchCount ?? null } : {}),
			...('metadata' in update ? { metadata: metadataJson(update.metadata) } : {}),
			durationMs,
			updatedAt: endedAt,
			endedAt
		})
		.where(eq(runSteps.id, id));
	logStep(row.runId, `done ${stageLabel(row)} ${durationMs}ms`);
}

export async function failStep(id: string, error: unknown, update: StepUpdate = {}): Promise<void> {
	const row = await db.select().from(runSteps).where(eq(runSteps.id, id)).get();
	if (!row) return;
	const endedAt = new Date();
	const durationMs = elapsedMs(row.startedAt);
	await db
		.update(runSteps)
		.set({
			status: 'failed',
			...('current' in update ? { current: update.current ?? null } : {}),
			...('total' in update ? { total: update.total ?? null } : {}),
			...('metadata' in update ? { metadata: metadataJson(update.metadata) } : {}),
			error: errorMessage(error),
			durationMs,
			updatedAt: endedAt,
			endedAt
		})
		.where(eq(runSteps.id, id));
	logStep(row.runId, `fail ${stageLabel(row)} ${durationMs}ms ${errorMessage(error)}`);
}

export async function recordAiCall(input: AiCallLogInput): Promise<void> {
	const usage = input.usage;
	await db.insert(aiCallLogs).values({
		id: crypto.randomUUID(),
		runId: input.runId,
		accountId: input.accountId,
		ruleId: input.ruleId,
		ruleVersionId: input.ruleVersionId,
		ruleName: input.ruleName,
		provider: usage?.provider ?? 'unknown',
		model: usage?.model ?? 'unknown',
		batchIndex: input.batchIndex,
		batchTotal: input.batchTotal,
		threadCount: input.threadCount,
		promptChars: usage?.promptChars ?? 0,
		responseChars: usage?.responseChars ?? 0,
		promptTokens: usage?.promptTokens ?? null,
		responseTokens: usage?.responseTokens ?? null,
		totalTokens: usage?.totalTokens ?? null,
		durationMs: input.durationMs,
		status: input.status,
		error: input.error ?? null,
		createdAt: new Date()
	});
	const tokens = usage?.totalTokens == null ? 'tokens=n/a' : `tokens=${usage.totalTokens}`;
	logStep(
		input.runId,
		`ai rule="${input.ruleName}" batch ${input.batchIndex}/${input.batchTotal} ${tokens} ${input.durationMs}ms`
	);
}

export async function markStaleRuns(accountId?: string): Promise<void> {
	const cutoff = new Date(nowMs() - 2 * 60 * 60 * 1000);
	const where = accountId
		? and(eq(runs.accountId, accountId), eq(runs.status, 'running'), lt(runs.startedAt, cutoff))
		: and(eq(runs.status, 'running'), lt(runs.startedAt, cutoff));
	await db
		.update(runs)
		.set({ status: 'failed', endedAt: new Date() })
		.where(where);
}

function serializeStep(row: typeof runSteps.$inferSelect): ProgressStep {
	return {
		id: row.id,
		stage: row.stage,
		status: row.status,
		ruleId: row.ruleId,
		ruleVersionId: row.ruleVersionId,
		ruleName: row.ruleName,
		batchIndex: row.batchIndex,
		batchTotal: row.batchTotal,
		current: row.current,
		total: row.total,
		matchedCount: row.matchedCount,
		claimedCount: row.claimedCount,
		bodyFetchCount: row.bodyFetchCount,
		aiBatchCount: row.aiBatchCount,
		durationMs: row.durationMs,
		error: row.error,
		metadata: parseMetadata(row.metadata),
		startedAt: toDate(row.startedAt)!.getTime(),
		updatedAt: toDate(row.updatedAt)!.getTime(),
		endedAt: toDate(row.endedAt)?.getTime() ?? null
	};
}

export async function getRunProgress(runId: string, accountId: string): Promise<RunProgress | null> {
	const run = await db
		.select()
		.from(runs)
		.where(and(eq(runs.id, runId), eq(runs.accountId, accountId)))
		.get();
	if (!run) return null;

	const stepRows = await db
		.select()
		.from(runSteps)
		.where(eq(runSteps.runId, runId))
		.orderBy(desc(runSteps.startedAt))
		.all();
	const callRows = await db
		.select()
		.from(aiCallLogs)
		.where(eq(aiCallLogs.runId, runId))
		.orderBy(desc(aiCallLogs.createdAt))
		.all();

	const recentSteps = stepRows.map(serializeStep);
	const activeStep = recentSteps.find((s) => s.status === 'running') ?? null;
	const rules = aggregateRuleProgress(recentSteps, callRows);
	const warnings = rules.flatMap((r) => r.warnings.map((w) => `${r.name}: ${w}`));

	let promptTokens: number | null = 0;
	let responseTokens: number | null = 0;
	let totalTokens: number | null = 0;
	for (const call of callRows) {
		if (call.promptTokens == null) promptTokens = null;
		else if (promptTokens != null) promptTokens += call.promptTokens;
		if (call.responseTokens == null) responseTokens = null;
		else if (responseTokens != null) responseTokens += call.responseTokens;
		if (call.totalTokens == null) totalTokens = null;
		else if (totalTokens != null) totalTokens += call.totalTokens;
	}

	const progress: RunProgress = {
		runId,
		accountId,
		status: run.status,
		startedAt: toDate(run.startedAt)!.getTime(),
		endedAt: toDate(run.endedAt)?.getTime() ?? null,
		scope: run.scope,
		activeStep,
		recentSteps: recentSteps.slice(0, 20),
		rules,
		aiTotals: {
			calls: callRows.length,
			promptTokens,
			responseTokens,
			totalTokens,
			promptChars: callRows.reduce((sum, call) => sum + call.promptChars, 0),
			responseChars: callRows.reduce((sum, call) => sum + call.responseChars, 0)
		},
		warnings
	};

	if (run.status === 'completed') {
		const proposals = await loadOpenProposals(accountId, runId);
		const claimed = new Set(proposals.flatMap((g) => g.threads.map((t) => t.id)));
		const rows = await db
			.select()
			.from(threads)
			.where(and(eq(threads.accountId, accountId), eq(threads.isUnread, true)))
			.all();
		const leftovers = rows
			.map(toThreadView)
			.filter((v) => !v.labelIds.includes('TODO') && !claimed.has(v.id))
			.sort((a, b) => b.receivedAt - a.receivedAt);
		progress.result = { proposals, leftovers };
	}

	return progress;
}

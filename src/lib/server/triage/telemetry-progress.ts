export interface ProgressStepLike {
	ruleId: string | null;
	ruleVersionId: string | null;
	ruleName: string | null;
	matchedCount: number | null;
	claimedCount: number | null;
	bodyFetchCount: number | null;
	aiBatchCount: number | null;
	durationMs: number | null;
	metadata: Record<string, unknown> | null;
}

export interface AiCallLike {
	ruleId: string;
	ruleVersionId: string;
	ruleName: string;
	batchTotal: number;
	promptChars: number;
	responseChars: number;
	totalTokens: number | null;
}

export interface RuleProgress {
	ruleId: string;
	ruleVersionId: string | null;
	name: string;
	tier: string | null;
	needsBody: boolean;
	poolSize: number | null;
	matchedCount: number;
	bodyFetchCount: number;
	aiBatchCount: number;
	claimedCount: number;
	durationMs: number;
	totalTokens: number | null;
	promptChars: number;
	responseChars: number;
	warnings: string[];
}

export function aggregateRuleProgress(steps: ProgressStepLike[], calls: AiCallLike[]): RuleProgress[] {
	const byRule = new Map<string, RuleProgress>();

	for (const step of steps) {
		if (!step.ruleId) continue;
		let rule = byRule.get(step.ruleId);
		const metadata = step.metadata ?? {};
		if (!rule) {
			rule = {
				ruleId: step.ruleId,
				ruleVersionId: step.ruleVersionId,
				name: step.ruleName ?? step.ruleId,
				tier: typeof metadata.tier === 'string' ? metadata.tier : null,
				needsBody: Boolean(metadata.needsBody),
				poolSize: typeof metadata.poolSize === 'number' ? metadata.poolSize : null,
				matchedCount: 0,
				bodyFetchCount: 0,
				aiBatchCount: 0,
				claimedCount: 0,
				durationMs: 0,
				totalTokens: null,
				promptChars: 0,
				responseChars: 0,
				warnings: []
			};
			byRule.set(step.ruleId, rule);
		}
		rule.ruleVersionId ??= step.ruleVersionId;
		if (typeof metadata.tier === 'string') rule.tier = metadata.tier;
		if ('needsBody' in metadata) rule.needsBody = Boolean(metadata.needsBody);
		if (typeof metadata.poolSize === 'number') rule.poolSize = metadata.poolSize;
		if (step.matchedCount != null) rule.matchedCount = Math.max(rule.matchedCount, step.matchedCount);
		if (step.bodyFetchCount != null) rule.bodyFetchCount = Math.max(rule.bodyFetchCount, step.bodyFetchCount);
		if (step.aiBatchCount != null) rule.aiBatchCount = Math.max(rule.aiBatchCount, step.aiBatchCount);
		if (step.claimedCount != null) rule.claimedCount = Math.max(rule.claimedCount, step.claimedCount);
		if (step.durationMs != null) rule.durationMs += step.durationMs;
		if (Array.isArray(metadata.warnings)) {
			for (const warning of metadata.warnings) {
				if (typeof warning === 'string' && !rule.warnings.includes(warning)) rule.warnings.push(warning);
			}
		}
	}

	for (const call of calls) {
		let rule = byRule.get(call.ruleId);
		if (!rule) {
			rule = {
				ruleId: call.ruleId,
				ruleVersionId: call.ruleVersionId,
				name: call.ruleName,
				tier: 'ai',
				needsBody: false,
				poolSize: null,
				matchedCount: 0,
				bodyFetchCount: 0,
				aiBatchCount: 0,
				claimedCount: 0,
				durationMs: 0,
				totalTokens: null,
				promptChars: 0,
				responseChars: 0,
				warnings: []
			};
			byRule.set(call.ruleId, rule);
		}
		rule.aiBatchCount = Math.max(rule.aiBatchCount, call.batchTotal);
		rule.promptChars += call.promptChars;
		rule.responseChars += call.responseChars;
		if (call.totalTokens != null) rule.totalTokens = (rule.totalTokens ?? 0) + call.totalTokens;
	}

	return [...byRule.values()];
}

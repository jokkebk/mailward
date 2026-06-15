import { describe, expect, test } from 'bun:test';
import {
	aggregateRuleProgress,
	type ProgressStepLike
} from '../src/lib/server/triage/telemetry-progress';

function step(overrides: Partial<ProgressStepLike> = {}): ProgressStepLike {
	return {
		ruleId: 'rule-1',
		ruleVersionId: 'version-1',
		ruleName: 'Broad body rule',
		matchedCount: 45,
		claimedCount: null,
		bodyFetchCount: null,
		aiBatchCount: null,
		durationMs: 120,
		metadata: {
			tier: 'ai',
			needsBody: true,
			poolSize: 50,
			warnings: ['needs_body matched most unread candidates; this rule may fetch many bodies']
		},
		...overrides
	};
}

describe('aggregateRuleProgress', () => {
	test('combines rule counters, warnings, and AI usage', () => {
		const rules = aggregateRuleProgress(
			[
				step({}),
				step({
					bodyFetchCount: 17,
					durationMs: 300
				}),
				step({
					claimedCount: 8,
					aiBatchCount: 3,
					durationMs: 500
				})
			],
			[
				{
					ruleId: 'rule-1',
					ruleVersionId: 'version-1',
					ruleName: 'Broad body rule',
					batchTotal: 3,
					promptChars: 900,
					responseChars: 100,
					totalTokens: 280
				},
				{
					ruleId: 'rule-1',
					ruleVersionId: 'version-1',
					ruleName: 'Broad body rule',
					batchTotal: 3,
					promptChars: 800,
					responseChars: 90,
					totalTokens: 240
				}
			] as any
		);

		expect(rules).toHaveLength(1);
		expect(rules[0]).toMatchObject({
			ruleId: 'rule-1',
			name: 'Broad body rule',
			tier: 'ai',
			needsBody: true,
			poolSize: 50,
			matchedCount: 45,
			bodyFetchCount: 17,
			aiBatchCount: 3,
			claimedCount: 8,
			durationMs: 920,
			totalTokens: 520,
			promptChars: 1700,
			responseChars: 190
		});
		expect(rules[0].warnings).toEqual([
			'needs_body matched most unread candidates; this rule may fetch many bodies'
		]);
	});
});

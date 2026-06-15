import { db } from '../db';
import { rules, ruleVersions } from '../db/schema';
import { and, asc, eq } from 'drizzle-orm';
import type { MatchCriteria, ResolvedRule, RuleAction, RuleStatus, RuleTier } from '$lib/types/rules';

/** Load rules joined to their current version, in priority order (lowest first). */
export async function getResolvedRules(accountId: string): Promise<ResolvedRule[]> {
	const rows = await db
		.select({
			ruleId: rules.id,
			name: rules.name,
			status: rules.status,
			versionId: ruleVersions.id,
			priority: ruleVersions.priority,
			matchCriteria: ruleVersions.matchCriteria,
			intent: ruleVersions.intent,
			action: ruleVersions.action,
			tier: ruleVersions.tier,
			needsBody: ruleVersions.needsBody
		})
		.from(rules)
		.innerJoin(ruleVersions, eq(rules.currentVersionId, ruleVersions.id))
		.where(eq(rules.accountId, accountId))
		.orderBy(asc(ruleVersions.priority))
		.all();

	return rows.map((r) => ({
		ruleId: r.ruleId,
		versionId: r.versionId,
		name: r.name,
		status: r.status as RuleStatus,
		priority: r.priority,
		matchCriteria: JSON.parse(r.matchCriteria) as MatchCriteria,
		intent: r.intent,
		action: r.action as RuleAction,
		tier: r.tier as RuleTier,
		needsBody: Boolean(r.needsBody)
	}));
}

interface NewRuleInput {
	name: string;
	priority: number;
	matchCriteria: MatchCriteria;
	intent?: string | null;
	action: RuleAction;
	tier?: RuleTier;
	needsBody?: boolean;
	changeNote?: string;
	createdBy?: 'human' | 'skill';
}

/** Create a new rule with its first version, and point the lineage at it. */
export async function createRule(accountId: string, input: NewRuleInput): Promise<string> {
	const ruleId = crypto.randomUUID();
	const versionId = crypto.randomUUID();
	const now = new Date();

	await db.insert(rules).values({
		id: ruleId,
		accountId,
		name: input.name,
		status: 'proposing',
		currentVersionId: versionId,
		createdAt: now,
		updatedAt: now
	});

	await db.insert(ruleVersions).values({
		id: versionId,
		ruleId,
		versionNo: 1,
		priority: input.priority,
		matchCriteria: JSON.stringify(input.matchCriteria),
		intent: input.intent ?? null,
		action: input.action,
		tier: input.tier ?? 'deterministic',
		needsBody: input.needsBody ?? false,
		createdBy: input.createdBy ?? 'human',
		changeNote: input.changeNote ?? 'initial version',
		isCurrent: true,
		createdAt: now
	});

	return ruleId;
}

/**
 * Seed a couple of obvious deterministic starter rules so run #1 isn't empty.
 * Intentionally minimal — the real rules come from running the analysis skill
 * over the uncovered pool (see DESIGN.md cold start).
 */
export async function seedDefaultRulesIfEmpty(accountId: string): Promise<boolean> {
	const existing = await db
		.select({ id: rules.id })
		.from(rules)
		.where(eq(rules.accountId, accountId))
		.get();
	if (existing) return false;

	await createRule(accountId, {
		name: 'Calendar invite responses',
		priority: 10,
		action: 'trash',
		intent:
			'Bare "Accepted"/"Declined"/"Tentative" calendar invite responses with no human note. (v1: structural only; the "unless there is a note" nuance arrives with the AI tier.)',
		matchCriteria: {
			type: 'any',
			conditions: [
				{ field: 'subject', operator: 'startsWith', value: 'Accepted: ' },
				{ field: 'subject', operator: 'startsWith', value: 'Declined: ' },
				{ field: 'subject', operator: 'startsWith', value: 'Tentative: ' }
			]
		}
	});

	await createRule(accountId, {
		name: 'Promotions older than a week',
		priority: 50,
		action: 'archive',
		intent: 'Gmail Promotions-category mail older than 7 days — almost always stale.',
		matchCriteria: {
			type: 'all',
			conditions: [
				{ field: 'label', operator: 'has', value: 'CATEGORY_PROMOTIONS' },
				{ field: 'ageDays', operator: 'olderThan', value: 7 }
			]
		}
	});

	return true;
}

import { db } from '../db';
import { ruleDispositions, rules, ruleVersions } from '../db/schema';
import { asc, eq } from 'drizzle-orm';
import type { MatchCriteria, ResolvedRule, RuleAction, RuleStatus, RuleTier } from '$lib/types/rules';

/**
 * Parse a stored `action` column into allowed dispositions. Deterministic rules
 * store a scalar ('trash'); AI router rules store a JSON array ('["trash",...]').
 */
export function parseAllowedActions(tier: RuleTier, stored: string): RuleAction[] {
	if (tier !== 'ai') return [stored as RuleAction];
	try {
		const arr = JSON.parse(stored);
		if (Array.isArray(arr) && arr.length) return arr as RuleAction[];
	} catch {
		/* fall through */
	}
	return [stored as RuleAction];
}

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

	return rows.map((r) => {
		const tier = r.tier as RuleTier;
		const allowedActions = parseAllowedActions(tier, r.action);
		return {
			ruleId: r.ruleId,
			versionId: r.versionId,
			name: r.name,
			status: r.status as RuleStatus,
			priority: r.priority,
			matchCriteria: JSON.parse(r.matchCriteria) as MatchCriteria,
			intent: r.intent,
			action: allowedActions[0],
			allowedActions,
			tier,
			needsBody: Boolean(r.needsBody)
		};
	});
}

interface NewRuleInput {
	name: string;
	priority: number;
	matchCriteria: MatchCriteria;
	intent?: string | null;
	/** Deterministic: a single action. AI router: the set of allowed dispositions. */
	action: RuleAction | RuleAction[];
	tier?: RuleTier;
	needsBody?: boolean;
	changeNote?: string;
	createdBy?: 'human' | 'skill';
}

/** Serialise an action input for storage: scalar for deterministic, JSON array for AI. */
export function serializeAction(tier: RuleTier, action: RuleAction | RuleAction[]): string {
	if (tier === 'ai') return JSON.stringify(Array.isArray(action) ? action : [action]);
	return Array.isArray(action) ? action[0] : action;
}

/** Seed (rule, disposition) promotion rows — one per allowed action, status 'proposing'. */
export async function seedRuleDispositions(ruleId: string, actions: RuleAction[]): Promise<void> {
	const now = new Date();
	const unique = [...new Set(actions)];
	if (unique.length === 0) return;
	await db.insert(ruleDispositions).values(
		unique.map((action) => ({ ruleId, action, status: 'proposing' as const, createdAt: now, updatedAt: now }))
	);
}

/** Create a new rule with its first version, and point the lineage at it. */
export async function createRule(accountId: string, input: NewRuleInput): Promise<string> {
	const ruleId = crypto.randomUUID();
	const versionId = crypto.randomUUID();
	const now = new Date();
	const tier = input.tier ?? 'deterministic';
	const allowedActions = Array.isArray(input.action) ? input.action : [input.action];

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
		action: serializeAction(tier, input.action),
		tier,
		needsBody: input.needsBody ?? false,
		createdBy: input.createdBy ?? 'human',
		changeNote: input.changeNote ?? 'initial version',
		isCurrent: true,
		createdAt: now
	});

	await seedRuleDispositions(ruleId, allowedActions);

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

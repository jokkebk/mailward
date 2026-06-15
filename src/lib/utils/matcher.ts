import type { Condition, MatchCriteria, StringCondition, ThreadView } from '$lib/types/rules';

/** Evaluate a structured match against a thread view. */
export function matchesRule(thread: ThreadView, criteria: MatchCriteria): boolean {
	if (!criteria.conditions?.length) return false;
	const test = (cond: Condition) => matchesCondition(thread, cond);
	return criteria.type === 'all' ? criteria.conditions.every(test) : criteria.conditions.some(test);
}

function matchesCondition(thread: ThreadView, condition: Condition): boolean {
	if (condition.field === 'ageDays') {
		return condition.operator === 'olderThan'
			? thread.ageDays > condition.value
			: thread.ageDays < condition.value;
	}

	if (condition.field === 'label') {
		const has = thread.labelIds.includes(condition.value);
		return condition.operator === 'has' ? has : !has;
	}

	return matchesString(thread, condition);
}

function matchesString(thread: ThreadView, condition: StringCondition): boolean {
	const raw = (thread as unknown as Record<string, unknown>)[condition.field];
	const fieldValue = raw == null ? '' : String(raw);
	const cs = condition.caseSensitive ?? false;
	const target = cs ? fieldValue : fieldValue.toLowerCase();
	const norm = (v: string) => (cs ? v : v.toLowerCase());

	switch (condition.operator) {
		case 'equals':
			return target === norm(String(condition.value));
		case 'contains':
			return target.includes(norm(String(condition.value)));
		case 'startsWith':
			return target.startsWith(norm(String(condition.value)));
		case 'endsWith':
			return target.endsWith(norm(String(condition.value)));
		case 'in': {
			const arr = Array.isArray(condition.value) ? condition.value : [condition.value];
			return arr.some((v) => norm(String(v)) === target);
		}
		case 'regex': {
			try {
				return new RegExp(String(condition.value), cs ? '' : 'i').test(fieldValue);
			} catch {
				return false;
			}
		}
		default:
			return false;
	}
}

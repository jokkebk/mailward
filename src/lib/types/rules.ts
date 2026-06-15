export type RuleAction = 'archive' | 'trash' | 'label_todo';
export type RuleStatus = 'proposing' | 'auto' | 'suspended';
export type RuleTier = 'deterministic' | 'ai';
export type Confidence = 'high' | 'med' | 'low';

export type StringField = 'from' | 'fromDomain' | 'to' | 'subject' | 'snippet';
export type StringOperator = 'equals' | 'contains' | 'startsWith' | 'endsWith' | 'in' | 'regex';

export interface StringCondition {
	field: StringField;
	operator: StringOperator;
	value: string | string[];
	caseSensitive?: boolean;
}

/** Match on the thread's age in days. */
export interface AgeCondition {
	field: 'ageDays';
	operator: 'olderThan' | 'newerThan';
	value: number;
}

/** Match on presence/absence of a Gmail label id. */
export interface LabelCondition {
	field: 'label';
	operator: 'has' | 'lacks';
	value: string; // label id, e.g. 'CATEGORY_PROMOTIONS'
}

export type Condition = StringCondition | AgeCondition | LabelCondition;

export interface MatchCriteria {
	type: 'all' | 'any';
	conditions: Condition[];
}

/** A rule resolved to its current version, as consumed by the triage loop. */
export interface ResolvedRule {
	ruleId: string;
	versionId: string;
	name: string;
	status: RuleStatus;
	priority: number;
	matchCriteria: MatchCriteria;
	intent: string | null;
	action: RuleAction;
	tier: RuleTier;
	needsBody: boolean;
}

/** Shape sent to the client for a thread within a proposal / leftover list. */
export interface ThreadView {
	id: string;
	from: string;
	fromDomain: string;
	subject: string | null;
	snippet: string | null;
	receivedAt: number;
	ageDays: number;
	labelIds: string[];
	messageIds: string[];
}

export interface ProposalGroup {
	ruleId: string;
	versionId: string;
	name: string;
	intent: string | null;
	action: RuleAction;
	status: RuleStatus;
	priority: number;
	threads: ThreadView[];
}

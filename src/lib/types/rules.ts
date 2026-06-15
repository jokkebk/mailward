export type RuleAction = 'archive' | 'trash' | 'label_todo';
/** Per-thread outcome the AI may assign: a real action, or `leave` (don't claim). */
export type Disposition = RuleAction | 'leave';
export type RuleStatus = 'proposing' | 'auto' | 'suspended';
export type RuleTier = 'deterministic' | 'ai';
export type Confidence = 'high' | 'med' | 'low';

export type StringField = 'from' | 'fromDomain' | 'to' | 'subject' | 'snippet';
export type StringOperator = 'equals' | 'contains' | 'startsWith' | 'endsWith' | 'in' | 'regex';
export type BooleanField = 'hasUnsubscribe' | 'isCalendarInvite';

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

/** Match on a cheap computed boolean signal (hasUnsubscribe / isCalendarInvite). */
export interface BooleanCondition {
	field: BooleanField;
	operator: 'is';
	value: boolean;
}

export type Condition = StringCondition | AgeCondition | LabelCondition | BooleanCondition;

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
	/** Representative action (deterministic: the action; AI: allowedActions[0]). */
	action: RuleAction;
	/** Dispositions the rule may emit. Deterministic: [action]. AI: parsed array. */
	allowedActions: RuleAction[];
	tier: RuleTier;
	needsBody: boolean;
}

/** Shape sent to the client for a thread within a proposal / leftover list. */
export interface ThreadView {
	id: string;
	from: string;
	to: string;
	fromDomain: string;
	subject: string | null;
	snippet: string | null;
	receivedAt: number;
	ageDays: number;
	labelIds: string[];
	messageIds: string[];
	hasUnsubscribe: boolean;
	isCalendarInvite: boolean;
}

/** A persisted proposal row joined with its thread, for the review UI + apply. */
export interface ProposalItem extends ThreadView {
	proposalId: string;
	action: RuleAction; // this thread's disposition
	source: 'deterministic' | 'ai';
	confidence: Confidence | null;
	reason: string | null;
}

export interface ProposalGroup {
	ruleId: string;
	versionId: string;
	name: string;
	intent: string | null;
	/** Representative action (deterministic: the single action; AI: undefined — per thread). */
	action: RuleAction;
	tier: RuleTier;
	status: RuleStatus;
	priority: number;
	threads: ProposalItem[];
}

export type RuleAction = 'archive' | 'trash' | 'label_todo';
/** Per-thread outcome the AI may assign: a real action, or `leave` (don't claim). */
export type Disposition = RuleAction | 'leave';
export type RuleStatus = 'proposing' | 'auto' | 'suspended';
export type RuleTier = 'deterministic' | 'ai';
export type Confidence = 'high' | 'med' | 'low';

export type StringField = 'from' | 'fromDomain' | 'to' | 'routingRecipients' | 'subject' | 'snippet';
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
	routingRecipients: string;
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

/** One (rule, disposition)'s promotion-gate record, as read by the promotion panel. */
export interface DispositionMetrics {
	ruleId: string;
	action: RuleAction;
	status: RuleStatus;
	/** Pinned propose-only: blocks promotion regardless of the numbers. */
	manualOnly: boolean;
	success: number;
	failure: number;
	excluded: number;
	approvalPct: number | null;
	applied: number;
	rolledBack: number;
	scored: number;
	/** Longest leading run of approvals, the gate's "verbatim enough" signal. */
	leadingSuccessRun: number;
	/** Gate inputs, echoed so the UI can say "17 of 20". */
	minRun: number;
	minApprovalPct: number;
	eligible: boolean;
}

export interface RuleDispositionMetrics extends DispositionMetrics {
	ruleName: string;
	ruleStatus: RuleStatus;
	tier: RuleTier;
	priority: number;
}

/**
 * One thing that already happened without asking. The digest is a post-hoc
 * receipt, so every row carries the `actionId` needed to undo it on its own.
 */
export interface AutoDigestItem {
	actionId: string;
	threadId: string;
	from: string;
	subject: string | null;
	snippet: string | null;
	receivedAt: number;
	action: RuleAction;
	confidence: Confidence | null;
	reason: string | null;
	status: 'applied' | 'rolled_back' | 'failed';
	/** Acted on but low-confidence (autoDecision 'act_flag') — worth a glance. */
	flagged: boolean;
	error: string | null;
}

export interface AutoDigestGroup {
	ruleId: string;
	ruleName: string;
	action: RuleAction;
	applied: number;
	flagged: number;
	rolledBack: number;
	failed: number;
	items: AutoDigestItem[];
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

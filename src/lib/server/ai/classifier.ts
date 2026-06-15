import type { Confidence, Disposition, RuleAction } from '$lib/types/rules';

export const CONFIDENCE_BANDS: Confidence[] = ['high', 'med', 'low'];

/** Compact, privacy-bounded payload sent to the model per thread. */
export interface ThreadPayload {
	threadId: string;
	from: string;
	to: string;
	subject: string | null;
	snippet: string | null;
	ageDays: number;
	labels: string[];
	isCalendarInvite: boolean;
	hasUnsubscribe: boolean;
	/** Present only when the rule declares needs_body. */
	body?: string;
}

export interface ClassifyRequest {
	/** Natural-language intent of the router rule (how to disposition the category). */
	intent: string;
	/** Dispositions the model may assign for this rule. `leave` is always also allowed. */
	allowedActions: RuleAction[];
	threads: ThreadPayload[];
}

export interface ClassifyVerdict {
	threadId: string;
	action: Disposition; // one of allowedActions, or 'leave'
	confidence: Confidence;
	reason: string;
}

/**
 * The daily triage classifier. One implementation per provider (Gemini first;
 * OpenAI / Anthropic drop in behind the same interface). Each call adjudicates
 * one router rule's candidate batch and returns a verdict per thread.
 */
export interface Classifier {
	classify(req: ClassifyRequest): Promise<ClassifyVerdict[]>;
}

/**
 * Defensive normalisation of a model's raw verdict array: keep only verdicts for
 * threads we asked about, coerce unknown dispositions to 'leave' and unknown
 * confidence to 'low', and default any omitted thread to a low-confidence 'leave'
 * (so it stays uncovered). Provider-agnostic, so every Classifier impl can reuse it.
 */
export function normalizeVerdicts(raw: unknown, req: ClassifyRequest): ClassifyVerdict[] {
	const allowed = new Set<Disposition>([...req.allowedActions, 'leave']);
	const wanted = new Set(req.threads.map((t) => t.threadId));
	const byThread = new Map<string, ClassifyVerdict>();

	if (Array.isArray(raw)) {
		for (const r of raw) {
			const threadId = String((r as any)?.threadId ?? '');
			if (!wanted.has(threadId) || byThread.has(threadId)) continue;
			const action = allowed.has((r as any)?.action) ? ((r as any).action as Disposition) : 'leave';
			const confidence = CONFIDENCE_BANDS.includes((r as any)?.confidence)
				? ((r as any).confidence as Confidence)
				: 'low';
			byThread.set(threadId, {
				threadId,
				action,
				confidence,
				reason: String((r as any)?.reason ?? '')
			});
		}
	}

	return req.threads.map(
		(t) =>
			byThread.get(t.threadId) ?? {
				threadId: t.threadId,
				action: 'leave' as Disposition,
				confidence: 'low' as Confidence,
				reason: 'No verdict returned for this thread.'
			}
	);
}

import type { ClassifyRequest, ThreadPayload } from './classifier';

/**
 * Static, cacheable system prompt: the classifier's role, the disposition
 * vocabulary, and the confidence bands. Kept stable so providers that support
 * prompt caching can cache it across every rule's batch in a run.
 */
export const SYSTEM_PROMPT = `You are an email triage classifier. You are given a single triage RULE
(a natural-language intent plus the set of dispositions it is allowed to assign) and a BATCH of
email threads that already passed a structural prefilter for that rule. For EACH thread, assign
exactly one disposition and a confidence band.

Dispositions:
- trash: delete (recoverable; move to Trash). Reserve for mail that is safe to throw away.
- archive: remove from inbox, keep. For mail that needs no action but is worth keeping.
- label_todo: flag as needing the user's attention/response; stays unread.
- leave: do NOT act. Use when the thread does not actually fit the rule's intent, or you are
  unsure it belongs to this category at all. A left thread falls through to other rules.

Rules:
- Only assign a disposition that is in the rule's allowed set, or 'leave'. Never invent others.
- When the rule's intent does not clearly apply to a thread, choose 'leave' rather than guessing.
- Confidence is a coarse band, self-assessed: 'high' = unambiguous fit; 'med' = probable;
  'low' = plausible but you would not bet on it. Be honest; low confidence is expected and useful.
- Judge from the provided fields only. Do not assume content you were not given.

Return one verdict object per input thread, preserving threadId exactly.`;

/** Build the per-request user message: the rule + the batch as compact JSON. */
export function buildUserPrompt(req: ClassifyRequest): string {
	const lines = [
		'RULE',
		`intent: ${req.intent}`,
		`allowed dispositions: ${req.allowedActions.join(', ')}, leave`,
		'',
		`THREADS (${req.threads.length}):`,
		JSON.stringify(req.threads.map(compactThread), null, 2)
	];
	return lines.join('\n');
}

/** Drop empty/undefined fields to keep the payload (and token cost) lean. */
function compactThread(t: ThreadPayload): Record<string, unknown> {
	const o: Record<string, unknown> = {
		threadId: t.threadId,
		from: t.from,
		subject: t.subject ?? '',
		snippet: t.snippet ?? '',
		ageDays: t.ageDays
	};
	if (t.to) o.to = t.to;
	if (t.labels.length) o.labels = t.labels;
	if (t.isCalendarInvite) o.isCalendarInvite = true;
	if (t.hasUnsubscribe) o.hasUnsubscribe = true;
	if (t.body) o.body = t.body;
	return o;
}

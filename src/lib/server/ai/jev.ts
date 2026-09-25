import { env } from '$env/dynamic/private';
import type { Disposition } from '$lib/types/rules';
import type { Classifier, ClassifyRequest, ClassifyResult } from './classifier';

export const JEV_MODEL = 'typesafe/jev-1.13';
const ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';

const descriptions: Record<Disposition, string> = {
	trash: 'Move to Trash. The rule clearly applies and the mail is safe to discard.',
	archive: 'Remove from inbox, but keep. The rule clearly applies and no action is needed.',
	label_todo: 'Keep unread and flag for the user to handle or reply. The rule clearly applies.',
	leave: 'Do not claim this thread for this rule. The rule does not clearly apply, or the provided evidence is insufficient.'
};

/** One independent Choice question per thread, matching the September replay. */
export function buildJevRequest(req: ClassifyRequest) {
	const actions: Disposition[] = [...new Set<Disposition>([...req.allowedActions, 'leave'])];
	return {
		model: JEV_MODEL,
		state: {
			rule: { intent: req.intent, allowedDispositions: actions },
			threads: req.threads.map((t) => ({
				threadId: t.threadId,
				from: t.from,
				to: t.to,
				subject: t.subject ?? '',
				snippet: t.snippet ?? '',
				ageDays: t.ageDays,
				labels: t.labels,
				isCalendarInvite: t.isCalendarInvite,
				hasUnsubscribe: t.hasUnsubscribe,
				...(t.body !== undefined ? { body: t.body } : {})
			}))
		},
		questions: Object.fromEntries(req.threads.map((_, i) => [
			`thread_${i}`,
			{
				type: 'choice',
				instructions: `For only \`threads[${i}]\`, given \`rule.intent\`, which allowed disposition best fits? Judge from the supplied fields only. If the rule does not clearly apply, choose leave.`,
				criteria: Object.fromEntries(actions.map((action) => [action, descriptions[action]]))
			}
		]))
	};
}

export class JevClassifier implements Classifier {
	constructor(private readonly fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch) {}

	async classify(req: ClassifyRequest): Promise<ClassifyResult> {
		const payload = buildJevRequest(req);
		const promptChars = JSON.stringify(payload).length;
		if (req.threads.length === 0) {
			return { verdicts: [], usage: { provider: 'openrouter', model: JEV_MODEL, promptChars, responseChars: 0 } };
		}
		const key = env.OPENROUTER_API_KEY;
		if (!key) throw new Error('OPENROUTER_API_KEY is not set');
		let response: Response | null = null;
		for (let attempt = 0; attempt < 4; attempt++) {
			response = await this.fetcher(ENDPOINT, {
				method: 'POST',
				headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(60_000)
			});
			if (response.ok) break;
			if (response.status !== 429 && response.status < 500) throw new Error(`Jev HTTP ${response.status}`);
			if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1_000));
		}
		if (!response?.ok) throw new Error(`Jev HTTP ${response?.status ?? 'unknown'}`);
		const data = await response.json() as any;
		const allowed = new Set<Disposition>([...req.allowedActions, 'leave']);
		const verdicts = req.threads.map((thread, i) => {
			const answer = data.answers?.[`thread_${i}`];
			const action = answer?.choice as Disposition;
			const probability = answer?.probabilities?.[action];
			if (answer?.type !== 'choice' || !allowed.has(action) ||
				typeof probability !== 'number' || probability < 0 || probability > 1) {
				throw new Error(`Jev returned an invalid answer for thread ${i}`);
			}
			return {
				threadId: thread.threadId,
				action,
				confidence: probability >= 0.9 ? 'high' as const : probability >= 0.7 ? 'med' as const : 'low' as const,
				reason: `Jev chose ${action} with probability ${Math.round(probability * 100)}%. It does not provide a written reason.`
			};
		});
		const usage = data.usage;
		return {
			verdicts,
			usage: {
				provider: 'openrouter', model: data.model || JEV_MODEL,
				promptChars, responseChars: JSON.stringify(data.answers).length,
				promptTokens: usage?.input_tokens ?? null,
				responseTokens: usage?.output_tokens ?? null,
				totalTokens: usage?.input_tokens != null && usage?.output_tokens != null
					? usage.input_tokens + usage.output_tokens : null
			}
		};
	}
}

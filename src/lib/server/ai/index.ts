import { env } from '$env/dynamic/private';
import type { Classifier } from './classifier';
import { GeminiClassifier } from './gemini';
import { OpenAIClassifier } from './openai';

export type {
	Classifier,
	ClassifyRequest,
	ClassifyResult,
	ClassifyUsage,
	ClassifyVerdict,
	ThreadPayload
} from './classifier';

let cached: Classifier | null = null;

/**
 * The active triage classifier, chosen by AI_PROVIDER (default 'gemini').
 * Anthropic ('haiku') is intended to drop in here behind the same Classifier
 * interface.
 */
export function getClassifier(): Classifier {
	if (cached) return cached;
	const provider = (env.AI_PROVIDER || 'gemini').toLowerCase();
	switch (provider) {
		case 'gemini':
			cached = new GeminiClassifier();
			return cached;
		case 'openai':
			cached = new OpenAIClassifier();
			return cached;
		// case 'anthropic': cached = new AnthropicClassifier(); return cached;
		default:
			throw new Error(`Unknown AI_PROVIDER '${provider}' (supported: gemini, openai)`);
	}
}

/** Test seam: inject a stub classifier (used by integration tests / dev). */
export function setClassifier(c: Classifier | null): void {
	cached = c;
}

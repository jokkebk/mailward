import { env } from '$env/dynamic/private';
import type { Classifier } from './classifier';
import { GeminiClassifier } from './gemini';
import { JevClassifier } from './jev';
import { OpenAIClassifier } from './openai';

export type {
	Classifier,
	ClassifyRequest,
	ClassifyResult,
	ClassifyUsage,
	ClassifyVerdict,
	ThreadPayload
} from './classifier';

export type ClassifierMode = 'legacy' | 'jev';
const cached = new Map<ClassifierMode, Classifier>();

/** Jev and the configured older classifier must never share cached decisions. */
export function classifierCacheKey(mode: ClassifierMode): string {
	return mode === 'jev' ? 'jev:typesafe/jev-1.13' : 'legacy';
}

/**
 * The active triage classifier, chosen by AI_PROVIDER (default 'gemini').
 * Anthropic ('haiku') is intended to drop in here behind the same Classifier
 * interface.
 */
export function getClassifier(mode: ClassifierMode = 'legacy'): Classifier {
	const existing = cached.get(mode);
	if (existing) return existing;
	if (mode === 'jev') {
		const classifier = new JevClassifier();
		cached.set(mode, classifier);
		return classifier;
	}
	const provider = (env.AI_PROVIDER || 'gemini').toLowerCase();
	switch (provider) {
		case 'gemini':
			cached.set(mode, new GeminiClassifier());
			return cached.get(mode)!;
		case 'openai':
			cached.set(mode, new OpenAIClassifier());
			return cached.get(mode)!;
		// case 'anthropic': cached = new AnthropicClassifier(); return cached;
		default:
			throw new Error(`Unknown AI_PROVIDER '${provider}' (supported: gemini, openai)`);
	}
}

/** Test seam: inject a stub classifier (used by integration tests / dev). */
export function setClassifier(c: Classifier | null, mode: ClassifierMode = 'legacy'): void {
	if (c) cached.set(mode, c);
	else cached.delete(mode);
}

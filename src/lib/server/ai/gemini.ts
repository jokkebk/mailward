import { GoogleGenAI, Type } from '@google/genai';
import { env } from '$env/dynamic/private';
import type { Disposition } from '$lib/types/rules';
import {
	CONFIDENCE_BANDS,
	normalizeVerdicts,
	type Classifier,
	type ClassifyResult,
	type ClassifyRequest,
} from './classifier';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt';

/** Gemini implementation of the triage classifier (structured-output JSON). */
export class GeminiClassifier implements Classifier {
	#client: GoogleGenAI | null = null;

	#getClient(): GoogleGenAI {
		if (!this.#client) {
			const apiKey = env.GEMINI_API_KEY;
			if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
			this.#client = new GoogleGenAI({ apiKey });
		}
		return this.#client;
	}

	async classify(req: ClassifyRequest): Promise<ClassifyResult> {
		const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
		const prompt = buildUserPrompt(req);
		if (req.threads.length === 0) {
			return {
				verdicts: [],
				usage: { provider: 'gemini', model, promptChars: prompt.length, responseChars: 0 }
			};
		}
		const allowed: Disposition[] = [...req.allowedActions, 'leave'];

		const response = await this.#getClient().models.generateContent({
			model,
			contents: prompt,
			config: {
				systemInstruction: SYSTEM_PROMPT,
				temperature: 0,
				responseMimeType: 'application/json',
				responseSchema: {
					type: Type.ARRAY,
					items: {
						type: Type.OBJECT,
						properties: {
							threadId: { type: Type.STRING },
							action: { type: Type.STRING, enum: allowed as string[] },
							confidence: { type: Type.STRING, enum: CONFIDENCE_BANDS as string[] },
							reason: { type: Type.STRING }
						},
						required: ['threadId', 'action', 'confidence', 'reason'],
						propertyOrdering: ['threadId', 'action', 'confidence', 'reason']
					}
				}
			}
		});

		const text = response.text;
		if (!text) throw new Error('Gemini returned an empty response');
		const usage = response.usageMetadata;
		return {
			verdicts: normalizeVerdicts(JSON.parse(text), req),
			usage: {
				provider: 'gemini',
				model,
				promptChars: prompt.length,
				responseChars: text.length,
				promptTokens: usage?.promptTokenCount ?? null,
				responseTokens: usage?.candidatesTokenCount ?? null,
				totalTokens: usage?.totalTokenCount ?? null
			}
		};
	}
}

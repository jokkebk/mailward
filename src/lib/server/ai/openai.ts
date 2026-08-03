import OpenAI from 'openai';
import type { ReasoningEffort } from 'openai/resources/shared';
import { env } from '$env/dynamic/private';
import {
	CONFIDENCE_BANDS,
	normalizeVerdicts,
	type Classifier,
	type ClassifyResult,
	type ClassifyRequest
} from './classifier';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt';

const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Reasoning effort for reasoning-capable models (gpt-5.x family). Unset = model default (medium). */
export function openaiReasoningEffort(): Exclude<ReasoningEffort, null> | undefined {
	const raw = env.OPENAI_REASONING_EFFORT;
	if (raw == null || raw === '') return undefined;
	if (!(REASONING_EFFORTS as readonly string[]).includes(raw)) {
		throw new Error(`OPENAI_REASONING_EFFORT must be one of: ${REASONING_EFFORTS.join(', ')}`);
	}
	return raw as Exclude<ReasoningEffort, null>;
}

/**
 * OpenAI implementation of the triage classifier, via the Responses API
 * (the successor to Chat Completions — better cache reuse and the only
 * surface that exposes `reasoning.effort` for every gpt-5.x model).
 */
export class OpenAIClassifier implements Classifier {
	#client: OpenAI | null = null;

	constructor(client?: OpenAI) {
		this.#client = client ?? null;
	}

	#getClient(): OpenAI {
		if (!this.#client) {
			const apiKey = env.OPENAI_API_KEY;
			if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
			this.#client = new OpenAI({ apiKey });
		}
		return this.#client;
	}

	async classify(req: ClassifyRequest): Promise<ClassifyResult> {
		const model = env.OPENAI_MODEL || 'gpt-5.6-luna';
		const effort = openaiReasoningEffort();
		const prompt = buildUserPrompt(req);
		if (req.threads.length === 0) {
			return {
				verdicts: [],
				usage: { provider: 'openai', model, promptChars: prompt.length, responseChars: 0 }
			};
		}
		const allowed = [...req.allowedActions, 'leave'];

		const response = await this.#getClient().responses.create({
			model,
			...(effort ? { reasoning: { effort } } : {}),
			input: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: prompt }
			],
			text: {
				format: {
					type: 'json_schema',
					name: 'triage_verdicts',
					strict: true,
					schema: {
						type: 'object',
						properties: {
							verdicts: {
								type: 'array',
								items: {
									type: 'object',
									properties: {
										threadId: { type: 'string' },
										action: { type: 'string', enum: allowed },
										confidence: { type: 'string', enum: CONFIDENCE_BANDS },
										reason: { type: 'string' }
									},
									required: ['threadId', 'action', 'confidence', 'reason'],
									additionalProperties: false
								}
							}
						},
						required: ['verdicts'],
						additionalProperties: false
					}
				}
			}
		});

		const text = response.output_text;
		if (!text) throw new Error('OpenAI returned an empty response');
		const usage = response.usage;
		return {
			verdicts: normalizeVerdicts(JSON.parse(text).verdicts, req),
			usage: {
				provider: 'openai',
				model,
				promptChars: prompt.length,
				responseChars: text.length,
				promptTokens: usage?.input_tokens ?? null,
				responseTokens: usage?.output_tokens ?? null,
				totalTokens: usage?.total_tokens ?? null
			}
		};
	}
}

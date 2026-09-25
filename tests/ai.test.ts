import { describe, expect, mock, test } from 'bun:test';
import { buildUserPrompt } from '../src/lib/server/ai/prompt';
import { normalizeVerdicts, type ClassifyRequest } from '../src/lib/server/ai/classifier';
import { JevClassifier } from '../src/lib/server/ai/jev';
import { hasOpenRouterKey } from '../src/lib/server/ai/availability';

mock.module('$env/dynamic/private', () => ({ env: process.env }));

const req: ClassifyRequest = {
	intent: 'Trash bare calendar responses; TODO invites needing a reply.',
	allowedActions: ['trash', 'label_todo'],
	threads: [
		{
			threadId: 'a',
			from: 'x@y.com',
			to: 'me@example.com',
			subject: 'Accepted: Sync',
			snippet: '',
			ageDays: 1,
			labels: ['INBOX'],
			isCalendarInvite: true,
			hasUnsubscribe: false
		},
		{
			threadId: 'b',
			from: 'p@q.com',
			to: 'me@example.com',
			subject: 'Invitation: Review',
			snippet: 'please confirm',
			ageDays: 0,
			labels: ['INBOX'],
			isCalendarInvite: true,
			hasUnsubscribe: false,
			body: 'Can you make it?'
		}
	]
};

describe('buildUserPrompt', () => {
	test('includes intent, allowed dispositions + leave, and thread ids', () => {
		const p = buildUserPrompt(req);
		expect(p).toContain(req.intent);
		expect(p).toContain('allowed dispositions: trash, label_todo, leave');
		expect(p).toContain('"threadId": "a"');
		expect(p).toContain('"threadId": "b"');
	});

	test('includes body only when present', () => {
		const p = buildUserPrompt(req);
		expect(p).toContain('Can you make it?');
		// Thread "a" has no body field
		const aBlock = p.slice(p.indexOf('"threadId": "a"'), p.indexOf('"threadId": "b"'));
		expect(aBlock).not.toContain('"body"');
	});
});

describe('normalizeVerdicts', () => {
	test('passes valid verdicts through', () => {
		const out = normalizeVerdicts(
			[
				{ threadId: 'a', action: 'trash', confidence: 'high', reason: 'bare response' },
				{ threadId: 'b', action: 'label_todo', confidence: 'med', reason: 'needs reply' }
			],
			req
		);
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ threadId: 'a', action: 'trash', confidence: 'high' });
	});

	test('coerces unknown action to leave and unknown confidence to low', () => {
		const out = normalizeVerdicts(
			[{ threadId: 'a', action: 'spam', confidence: 'definitely', reason: 'x' }],
			req
		);
		const a = out.find((v) => v.threadId === 'a')!;
		expect(a.action).toBe('leave');
		expect(a.confidence).toBe('low');
	});

	test('defaults omitted threads to low-confidence leave', () => {
		const out = normalizeVerdicts(
			[{ threadId: 'a', action: 'trash', confidence: 'high', reason: 'ok' }],
			req
		);
		const b = out.find((v) => v.threadId === 'b')!;
		expect(b.action).toBe('leave');
		expect(b.confidence).toBe('low');
	});

	test('drops verdicts for threads we did not ask about', () => {
		const out = normalizeVerdicts(
			[
				{ threadId: 'a', action: 'trash', confidence: 'high', reason: 'ok' },
				{ threadId: 'zzz', action: 'trash', confidence: 'high', reason: 'ghost' }
			],
			req
		);
		expect(out.map((v) => v.threadId).sort()).toEqual(['a', 'b']);
	});

	test('always returns one verdict per requested thread', () => {
		const out = normalizeVerdicts('not an array', req);
		expect(out.map((v) => v.threadId).sort()).toEqual(['a', 'b']);
		expect(out.every((v) => v.action === 'leave')).toBe(true);
	});
});

async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
	const prev = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		return await fn();
	} finally {
		if (prev === undefined) delete process.env[name];
		else process.env[name] = prev;
	}
}

function fakeGeminiClient(calls: unknown[]): any {
	return {
		models: {
			generateContent: async (input: unknown) => {
				calls.push(input);
				return {
					text: JSON.stringify([
						{ threadId: 'a', action: 'trash', confidence: 'high', reason: 'bare response' },
						{ threadId: 'b', action: 'label_todo', confidence: 'med', reason: 'needs reply' }
					]),
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 20,
						totalTokenCount: 30
					}
				};
			}
		}
	};
}

async function makeGeminiClassifier(client: any) {
	const { GeminiClassifier } = await import('../src/lib/server/ai/gemini');
	return new GeminiClassifier(client);
}

describe('GeminiClassifier', () => {
	test('sends deterministic JSON config with thinking disabled by default', async () => {
		await withEnv('GEMINI_THINKING_BUDGET', undefined, async () => {
			const calls: unknown[] = [];
			const classifier = await makeGeminiClassifier(fakeGeminiClient(calls));

			await classifier.classify(req);

			expect(calls).toHaveLength(1);
			const call = calls[0] as any;
			expect(call.config.temperature).toBe(0);
			expect(call.config.responseMimeType).toBe('application/json');
			expect(call.config.thinkingConfig).toEqual({ thinkingBudget: 0 });
			expect(call.config.responseSchema.type).toBe('ARRAY');
			expect(call.config.responseSchema.items.properties.action.enum).toEqual([
				'trash',
				'label_todo',
				'leave'
			]);
		});
	});

	test('uses GEMINI_THINKING_BUDGET override', async () => {
		await withEnv('GEMINI_THINKING_BUDGET', '256', async () => {
			const calls: unknown[] = [];
			const classifier = await makeGeminiClassifier(fakeGeminiClient(calls));

			await classifier.classify(req);

			const call = calls[0] as any;
			expect(call.config.thinkingConfig).toEqual({ thinkingBudget: 256 });
		});
	});

	test('rejects invalid GEMINI_THINKING_BUDGET values', async () => {
		await withEnv('GEMINI_THINKING_BUDGET', 'abc', async () => {
			const classifier = await makeGeminiClassifier(fakeGeminiClient([]));
			await expect(classifier.classify(req)).rejects.toThrow(
				'GEMINI_THINKING_BUDGET must be a non-negative integer'
			);
		});

		await withEnv('GEMINI_THINKING_BUDGET', '-1', async () => {
			const classifier = await makeGeminiClassifier(fakeGeminiClient([]));
			await expect(classifier.classify(req)).rejects.toThrow(
				'GEMINI_THINKING_BUDGET must be a non-negative integer'
			);
		});
	});
});

describe('JevClassifier', () => {
	test('asks one typed question per thread and maps probabilities to coarse bands', async () => {
		await withEnv('OPENROUTER_API_KEY', 'test-key', async () => {
			let sent: any;
			const classifier = new JevClassifier(async (_url, init) => {
				sent = JSON.parse(String(init?.body));
				return new Response(JSON.stringify({
					model: 'typesafe/jev-1.13-20260917',
					answers: {
						thread_0: { type: 'choice', choice: 'trash', probabilities: { trash: 0.94, label_todo: 0.04, leave: 0.02 } },
						thread_1: { type: 'choice', choice: 'label_todo', probabilities: { trash: 0.3, label_todo: 0.65, leave: 0.05 } }
					},
					usage: { input_tokens: 100, output_tokens: 10 }
				}));
			});
			const result = await classifier.classify(req);
			expect(Object.keys(sent.questions)).toEqual(['thread_0', 'thread_1']);
			expect(sent.questions.thread_0.criteria).toHaveProperty('leave');
			expect(sent.state.threads[0]).not.toHaveProperty('body');
			expect(sent.state.threads[1].body).toBe('Can you make it?');
			expect(result.verdicts.map((v) => [v.threadId, v.action, v.confidence])).toEqual([
				['a', 'trash', 'high'], ['b', 'label_todo', 'low']
			]);
			expect(result.verdicts[0].reason).toContain('does not provide a written reason');
			expect(result.usage.promptTokens).toBe(100);
		});
	});

	test('rejects a missing thread answer instead of silently trusting a partial batch', async () => {
		await withEnv('OPENROUTER_API_KEY', 'test-key', async () => {
			const classifier = new JevClassifier(async () => new Response(JSON.stringify({
				answers: { thread_0: { type: 'choice', choice: 'trash', probabilities: { trash: 0.9 } } }
			})));
			await expect(classifier.classify(req)).rejects.toThrow('invalid answer for thread 1');
		});
	});
});

describe('Jev availability', () => {
	test('requires a configured key, not an empty or example value', async () => {
		for (const value of [undefined, '', '   ', 'your_openrouter_api_key_here']) {
			await withEnv('OPENROUTER_API_KEY', value, async () => {
				expect(hasOpenRouterKey()).toBe(false);
			});
		}
		await withEnv('OPENROUTER_API_KEY', 'test-key', async () => {
			expect(hasOpenRouterKey()).toBe(true);
		});
	});
});

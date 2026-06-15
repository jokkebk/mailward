import { describe, expect, test } from 'bun:test';
import { buildUserPrompt } from '../src/lib/server/ai/prompt';
import { normalizeVerdicts, type ClassifyRequest } from '../src/lib/server/ai/classifier';

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

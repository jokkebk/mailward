import { describe, expect, test } from 'bun:test';
import { matchesRule } from '../src/lib/utils/matcher';
import type { MatchCriteria, ThreadView } from '../src/lib/types/rules';

function thread(overrides: Partial<ThreadView> = {}): ThreadView {
	return {
		id: 't1',
		from: 'Acme <noreply@acme.com>',
		to: 'me@example.com',
		routingRecipients: 'me@example.com noreply@acme.com',
		fromDomain: 'acme.com',
		subject: 'Invitation: Standup @ 9am',
		snippet: 'You are invited',
		receivedAt: Date.now(),
		ageDays: 3,
		labelIds: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
		messageIds: ['m1'],
		hasUnsubscribe: false,
		isCalendarInvite: true,
		...overrides
	};
}

describe('matcher boolean fields', () => {
	test('isCalendarInvite is true', () => {
		const c: MatchCriteria = {
			type: 'all',
			conditions: [{ field: 'isCalendarInvite', operator: 'is', value: true }]
		};
		expect(matchesRule(thread(), c)).toBe(true);
		expect(matchesRule(thread({ isCalendarInvite: false }), c)).toBe(false);
	});

	test('hasUnsubscribe is false', () => {
		const c: MatchCriteria = {
			type: 'all',
			conditions: [{ field: 'hasUnsubscribe', operator: 'is', value: false }]
		};
		expect(matchesRule(thread(), c)).toBe(true);
		expect(matchesRule(thread({ hasUnsubscribe: true }), c)).toBe(false);
	});

	test('mixes booleans with string + age + label conditions', () => {
		const c: MatchCriteria = {
			type: 'all',
			conditions: [
				{ field: 'isCalendarInvite', operator: 'is', value: true },
				{ field: 'subject', operator: 'startsWith', value: 'Invitation:' },
				{ field: 'ageDays', operator: 'olderThan', value: 1 },
				{ field: 'label', operator: 'has', value: 'CATEGORY_UPDATES' }
			]
		};
		expect(matchesRule(thread(), c)).toBe(true);
	});

	test('matches derived routing recipients as a string field', () => {
		const c: MatchCriteria = {
			type: 'all',
			conditions: [
				{ field: 'routingRecipients', operator: 'contains', value: 'devs@acme.test' }
			]
		};
		expect(matchesRule(thread({ routingRecipients: 'devs@acme.test noreply@example.com' }), c)).toBe(true);
		expect(matchesRule(thread({ routingRecipients: 'noreply@example.com' }), c)).toBe(false);
	});
});

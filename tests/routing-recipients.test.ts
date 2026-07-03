import { describe, expect, test } from 'bun:test';
import { routingRecipientsForThread } from '../src/lib/server/triage/view';

function row(overrides: { from?: string; to?: string | null; rawHeaders?: string | null } = {}) {
	return {
		from: 'Sender <sender@example.com>',
		to: 'me@example.com',
		rawHeaders: null,
		...overrides
	};
}

function headers(entries: Array<{ name: string; value: string }>): string {
	return JSON.stringify(entries);
}

describe('routingRecipientsForThread', () => {
	test('includes direct To recipients', () => {
		const got = routingRecipientsForThread(row({ to: 'devs@acme.test' }));
		expect(got).toContain('devs@acme.test');
	});

	test('infers Google Group aliases from List-Unsubscribe URLs', () => {
		const got = routingRecipientsForThread(
			row({
				to: 'devs@auctions.test',
				rawHeaders: headers([
					{
						name: 'List-Unsubscribe',
						value:
							'<mailto:googlegroups-manage+unsubscribe@googlegroups.com>, <https://groups.google.com/a/acme.test/group/devs/subscribe>'
					}
				])
			})
		);
		expect(got).toContain('devs@acme.test');
	});

	test('includes via-list From aliases', () => {
		const got = routingRecipientsForThread(
			row({ from: '"\'Microsoft on behalf of Partner\' via Devteam" <devs@acme.test>' })
		);
		expect(got).toContain('devs@acme.test');
	});
});

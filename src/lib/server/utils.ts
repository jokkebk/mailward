import { json } from '@sveltejs/kit';

/** Returns the accountId from URL params, or a 400 Response if missing. */
export function getRequiredAccountId(url: URL): string | Response {
	const accountId = url.searchParams.get('accountId');
	if (!accountId) {
		return json({ error: 'Account ID is required' }, { status: 400 });
	}
	return accountId;
}

export function ageDays(receivedAt: Date | number): number {
	const ms = typeof receivedAt === 'number' ? receivedAt : receivedAt.getTime();
	return Math.max(0, Math.floor((Date.now() - ms) / 86_400_000));
}

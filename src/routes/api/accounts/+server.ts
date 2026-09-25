import { json } from '@sveltejs/kit';
import { db } from '$lib/server/db';
import { tokens } from '$lib/server/db/schema';
import { hasOpenRouterKey } from '$lib/server/ai/availability';
import { asc } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		const accounts = await db.select({ id: tokens.id }).from(tokens).orderBy(asc(tokens.id)).all();
		return json({ accounts: accounts.map((a) => a.id), jevAvailable: hasOpenRouterKey() });
	} catch (error) {
		console.error('Fetch accounts error:', error);
		return json({ error: 'Failed to fetch accounts' }, { status: 500 });
	}
};

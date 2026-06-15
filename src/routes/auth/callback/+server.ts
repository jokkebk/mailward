import { redirect } from '@sveltejs/kit';
import { getAccountEmail, getTokensFromCode } from '$lib/server/gmail/oauth';
import { db } from '$lib/server/db';
import { tokens } from '$lib/server/db/schema';
import { eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
	const code = url.searchParams.get('code');
	if (!code) throw redirect(302, '/?error=no_code');

	let accountEmail = '';
	try {
		const t = await getTokensFromCode(code);
		if (!t.access_token || !t.refresh_token || !t.expiry_date) {
			throw redirect(302, '/?error=invalid_tokens');
		}
		accountEmail = await getAccountEmail(t);

		const existing = await db.select().from(tokens).where(eq(tokens.id, accountEmail)).get();
		const values = {
			accessToken: t.access_token,
			refreshToken: t.refresh_token,
			expiresAt: new Date(t.expiry_date)
		};
		if (existing) {
			await db.update(tokens).set(values).where(eq(tokens.id, accountEmail));
		} else {
			await db.insert(tokens).values({ id: accountEmail, ...values });
		}
	} catch (error) {
		if (error instanceof Response) throw error;
		console.error('Auth callback error:', error);
		throw redirect(302, '/?error=auth_failed');
	}

	throw redirect(302, `/?accountId=${encodeURIComponent(accountEmail)}`);
};

import { db } from '../db';
import { tokens } from '../db/schema';
import { eq } from 'drizzle-orm';
import { REAUTH_REQUIRED_CODE, isReauthError } from './errors';

export async function handleReauthCleanup(
	error: unknown,
	accountId: string | null | undefined
): Promise<boolean> {
	if (!accountId) return false;
	if (!isReauthError(error)) return false;

	await db.delete(tokens).where(eq(tokens.id, accountId));
	return true;
}

export function reauthResponse() {
	return {
		error: 'Re-authentication required',
		code: REAUTH_REQUIRED_CODE
	};
}

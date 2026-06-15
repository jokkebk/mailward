import { google } from 'googleapis';
import { getOAuth2Client } from './oauth';
import { db } from '../db';
import { tokens } from '../db/schema';
import { eq } from 'drizzle-orm';
import { createReauthError, isReauthError } from './errors';

export async function getGmailClient(accountId: string) {
	// Get stored tokens
	const storedTokens = await db.select().from(tokens).where(eq(tokens.id, accountId)).get();

	if (!storedTokens) {
		throw new Error('No stored tokens found for this account. Please authenticate first.');
	}

	const oauth2Client = getOAuth2Client();
	oauth2Client.setCredentials({
		access_token: storedTokens.accessToken,
		refresh_token: storedTokens.refreshToken
	});

	// Check if token is expired and refresh if needed
	const now = new Date();
	if (storedTokens.expiresAt < now) {
		try {
			const { credentials } = await oauth2Client.refreshAccessToken();
			if (credentials.access_token && credentials.expiry_date) {
				await db
					.update(tokens)
					.set({
						accessToken: credentials.access_token,
						expiresAt: new Date(credentials.expiry_date)
					})
					.where(eq(tokens.id, accountId));
				oauth2Client.setCredentials(credentials);
			}
		} catch (error) {
			if (isReauthError(error)) {
				throw createReauthError();
			}
			throw error;
		}
	}

	return google.gmail({ version: 'v1', auth: oauth2Client });
}

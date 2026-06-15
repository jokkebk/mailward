import { env } from '$env/dynamic/private';
import { google } from 'googleapis';

const SCOPES = [
	'https://www.googleapis.com/auth/gmail.readonly', // Read emails
	'https://www.googleapis.com/auth/gmail.modify', // Mark as read, archive
	'https://www.googleapis.com/auth/gmail.labels' // Manage labels
];

export function getOAuth2Client() {
	return new google.auth.OAuth2(
		env.GOOGLE_CLIENT_ID,
		env.GOOGLE_CLIENT_SECRET,
		env.GOOGLE_REDIRECT_URI
	);
}

export function generateAuthUrl() {
	const oauth2Client = getOAuth2Client();
	return oauth2Client.generateAuthUrl({
		access_type: 'offline',
		scope: SCOPES,
		prompt: 'consent'
	});
}

export async function getTokensFromCode(code: string) {
	const oauth2Client = getOAuth2Client();
	const { tokens } = await oauth2Client.getToken(code);
	return tokens;
}

export async function getAccountEmail(tokensData: {
	access_token?: string | null;
	refresh_token?: string | null;
	expiry_date?: number | null;
}) {
	const oauth2Client = getOAuth2Client();
	oauth2Client.setCredentials({
		access_token: tokensData.access_token,
		refresh_token: tokensData.refresh_token
	});

	const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
	const profile = await gmail.users.getProfile({ userId: 'me' });
	if (!profile.data.emailAddress) {
		throw new Error('Failed to resolve account email.');
	}
	return profile.data.emailAddress;
}

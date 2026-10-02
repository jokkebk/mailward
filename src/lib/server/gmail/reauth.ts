import { REAUTH_REQUIRED_CODE, isReauthError } from './errors';

export function isReauthRequired(error: unknown): boolean {
	return isReauthError(error);
}

export function reauthResponse() {
	return {
		error: 'Re-authentication required',
		code: REAUTH_REQUIRED_CODE
	};
}

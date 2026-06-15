export const REAUTH_REQUIRED_CODE = 'reauth_required';

export function createReauthError(message = 'Re-authentication required'): Error {
	const error = new Error(message);
	(error as { code?: string }).code = REAUTH_REQUIRED_CODE;
	return error;
}

export function isReauthError(error: unknown): boolean {
	if (!error || typeof error !== 'object') return false;
	const err = error as {
		code?: string;
		message?: string;
		response?: { status?: number; data?: unknown };
	};

	if (err.code === REAUTH_REQUIRED_CODE) return true;

	const response = err.response;
	const status = response?.status;
	const data = response?.data as {
		error?: string | { message?: string; status?: string };
		error_description?: string;
	} | null;

	const oauthError = typeof data?.error === 'string' ? data?.error : undefined;
	if (oauthError === 'invalid_grant' || oauthError === 'invalid_token') return true;

	const message =
		data?.error_description ||
		(typeof data?.error === 'object' ? data?.error?.message : undefined) ||
		err.message;

	if (typeof message === 'string' && message.toLowerCase().includes('authenticate')) {
		return true;
	}

	if (status === 401) return true;

	if (status === 403 && typeof message === 'string') {
		const lower = message.toLowerCase();
		if (lower.includes('invalid') || lower.includes('authentication')) return true;
	}

	return false;
}

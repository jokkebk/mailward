import { env } from '$env/dynamic/private';

/** Expose only availability to the browser; the key stays on the server. */
export function hasOpenRouterKey(): boolean {
	const key = env.OPENROUTER_API_KEY?.trim();
	return Boolean(key && !key.includes('your_') && !key.includes('_here'));
}

import { redirect } from '@sveltejs/kit';
import { generateAuthUrl } from '$lib/server/gmail/oauth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	throw redirect(302, generateAuthUrl());
};

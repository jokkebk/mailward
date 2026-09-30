import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import { inspectThreadContent, ReviewError } from '$lib/server/v3/service';
import { handleReauthCleanup, reauthResponse } from '$lib/server/gmail/reauth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params, url }) => {
  const accountId = getRequiredAccountId(url);
  if (accountId instanceof Response) return accountId;
  try {
    return json({ messages: await inspectThreadContent(accountId, params.threadId) });
  } catch (error) {
    if (await handleReauthCleanup(error, accountId)) return json(reauthResponse(), { status: 401 });
    if (error instanceof ReviewError) return json({ error: error.message }, { status: error.statusCode });
    console.error(error); return json({ error: 'Could not inspect thread' }, { status: 500 });
  }
};

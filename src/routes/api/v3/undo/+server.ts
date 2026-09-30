import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import { ReviewError, undoReviewedAction, undoReviewedRun } from '$lib/server/v3/service';
import { handleReauthCleanup, reauthResponse } from '$lib/server/gmail/reauth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ url, request }) => {
  const accountId = getRequiredAccountId(url);
  if (accountId instanceof Response) return accountId;
  try {
    const body = await request.json() as { actionId?: string; runId?: string };
    if (body.actionId) return json(await undoReviewedAction(accountId, body.actionId));
    if (body.runId) return json(await undoReviewedRun(accountId, body.runId));
    return json({ error: 'actionId or runId required' }, { status: 400 });
  } catch (error) {
    if (await handleReauthCleanup(error, accountId)) return json(reauthResponse(), { status: 401 });
    if (error instanceof ReviewError) return json({ error: error.message }, { status: error.statusCode });
    console.error(error); return json({ error: 'Undo failed' }, { status: 500 });
  }
};

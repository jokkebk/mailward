import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import { ReviewError, submitReviewedSet } from '$lib/server/v3/service';
import { isReauthRequired, reauthResponse } from '$lib/server/gmail/reauth';
import type { ReviewDecision } from '$lib/types/v3';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ url, request }) => {
  const accountId = getRequiredAccountId(url);
  if (accountId instanceof Response) return accountId;
  try {
    const body = await request.json() as { runId: string; decisions: ReviewDecision[] };
    if (typeof body.runId !== 'string' || !Array.isArray(body.decisions)) return json({ error: 'Invalid reviewed set' }, { status: 400 });
    return json({ results: await submitReviewedSet(accountId, body.runId, body.decisions) });
  } catch (error) {
    if (isReauthRequired(error)) return json(reauthResponse(), { status: 401 });
    if (error instanceof ReviewError) return json({ error: error.message }, { status: error.statusCode });
    console.error(error); return json({ error: 'Review failed' }, { status: 500 });
  }
};

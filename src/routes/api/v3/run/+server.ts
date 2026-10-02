import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import { listRun, ReviewError, startAssessment } from '$lib/server/v3/service';
import { isReauthRequired, reauthResponse } from '$lib/server/gmail/reauth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
  const accountId = getRequiredAccountId(url);
  if (accountId instanceof Response) return accountId;
  try { return json(listRun(accountId, url.searchParams.get('runId') ?? undefined)); }
  catch (error) { console.error(error); return json({ error: 'Could not list assessments' }, { status: 500 }); }
};

export const POST: RequestHandler = async ({ url }) => {
  const accountId = getRequiredAccountId(url);
  if (accountId instanceof Response) return accountId;
  try { return json({ runId: await startAssessment(accountId, Number(url.searchParams.get('limit') ?? 100)) }); }
  catch (error) {
    if (isReauthRequired(error)) return json(reauthResponse(), { status: 401 });
    if (error instanceof ReviewError) return json({ error: error.message }, { status: error.statusCode });
    console.error(error); return json({ error: 'Could not start assessment' }, { status: 500 });
  }
};

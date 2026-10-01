import { json } from '@sveltejs/kit';
import { getRequiredAccountId } from '$lib/server/utils';
import { openV3Database } from '$lib/server/v3/service';
import { applySettingsOp, loadSettings, SettingsError, type SettingsOp } from '$lib/server/v3/settings';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
  const accountId = getRequiredAccountId(url);
  if (accountId instanceof Response) return accountId;
  const db = openV3Database();
  try { return json(loadSettings(db, accountId)); }
  catch (error) {
    if (error instanceof SettingsError) return json({ error: error.message }, { status: error.statusCode });
    console.error(error); return json({ error: 'Could not load settings' }, { status: 500 });
  } finally { db.close(); }
};

export const POST: RequestHandler = async ({ url, request }) => {
  const accountId = getRequiredAccountId(url);
  if (accountId instanceof Response) return accountId;
  let body: SettingsOp;
  try { body = await request.json(); } catch { return json({ error: 'Expected a JSON body' }, { status: 400 }); }
  const db = openV3Database();
  try { return json(applySettingsOp(db, accountId, body)); }
  catch (error) {
    if (error instanceof SettingsError) return json({ error: error.message }, { status: error.statusCode });
    console.error(error); return json({ error: 'Could not save settings' }, { status: 500 });
  } finally { db.close(); }
};

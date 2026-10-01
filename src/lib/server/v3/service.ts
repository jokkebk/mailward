import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { getGmailClient } from '../gmail/client';
import { handleReauthCleanup } from '../gmail/reauth';
import { extractBody } from '../gmail/content';
import { sanitizeHtml } from '../gmail/sanitize';
import { applyThreadAction, undoAction } from '../gmail/execution';
import { deterministicHandling, saveDeterministicAssessment, CALENDAR_RESPONSE_RULE } from './deterministic';
import { getOrCreatePolicy } from './policy';
import { callJev, resolveHandling, RUBRIC_VERSION, V3_MODEL } from './assessment';
import { prepareThread, REPRESENTATION_VERSION } from './representation';
import type { Assessment, Representation, ReviewDecision } from '$lib/types/v3';

export function openV3Database(path = process.env.DATABASE_PATH || './data/emails.db'): Database {
  mkdirSync(dirname(path), { recursive: true });
  const sqlite = new Database(path);
  sqlite.exec('PRAGMA foreign_keys = ON');
  return sqlite;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = <T>(json: string): T => JSON.parse(json) as T;
function cacheContext(rep: Representation): string | null {
  const text = rep.messages.map((m) => `${m.subject} ${m.body}`).join(' ');
  if (rep.messages.some((m) => m.isCalendarInvite)) return JSON.stringify({ day: new Date().toISOString().slice(0, 10), ended: rep.messages.map((m) => m.calendar?.endsAt ? Date.parse(m.calendar.endsAt) <= Date.now() : null) });
  if (!/\b(today|tomorrow|deadline|due|by (?:mon|tues|wednes|thurs|fri|satur|sun)day|tänään|huomenna|mennessä|erääntyy)\b/i.test(text)) return null;
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export interface AssessmentRow {
  id: string; account_id: string; thread_id: string; input_key: string; representation: string;
  answers: string | null; proposed_action: string; final_action: string; lane: string;
  reason: string; priority: number; status: string; error: string | null; created_at: number;
  review_kind: string | null; review_disposition: string | null; review_action_id: string | null;
  execution_status: string | null; review_error: string | null;
}

export function listRun(accountId: string, runId?: string) {
  const sqlite = openV3Database();
  try {
    const account = sqlite.query('SELECT id FROM tokens WHERE id = ?').get(accountId);
    if (!account) throw new ReviewError('Account not connected', 404);
    const policy = getOrCreatePolicy(sqlite, accountId);
    const run = (runId
      ? sqlite.query("SELECT * FROM runs WHERE id = ? AND account_id = ? AND scope = 'v3'").get(runId, accountId)
      : sqlite.query("SELECT * FROM runs WHERE account_id = ? AND scope = 'v3' ORDER BY started_at DESC LIMIT 1").get(accountId)) as any;
    if (!run) return { run: null, policy, items: [], calls: [], steps: [] };
    const items = sqlite.query(`SELECT a.*, r.kind AS review_kind, r.disposition AS review_disposition, r.action_id AS review_action_id,
      r.execution_status, r.error AS review_error, r.final_disposition AS review_final_disposition, r.chip AS review_chip,
      x.status AS action_status FROM v3_run_items i JOIN v3_assessments a ON i.assessment_id = a.id
      LEFT JOIN v3_reviews r ON r.assessment_id = a.id LEFT JOIN actions x ON x.id = r.action_id
      WHERE i.run_id = ? AND a.account_id = ? ORDER BY a.priority DESC, a.created_at DESC, a.id`).all(run.id, accountId) as any[];
    const calls = sqlite.query('SELECT model, thread_count, prompt_chars, input_tokens, output_tokens, duration_ms, status, error FROM v3_call_logs WHERE run_id = ?').all(run.id);
    const steps = sqlite.query("SELECT stage, duration_ms, status, total, error FROM run_steps WHERE run_id = ? AND rule_id IS NULL ORDER BY started_at").all(run.id);
    const replayStep = (steps as any[]).find((step) => step.stage.startsWith('v3_replay:'));
    const replaySource = replayStep ? sqlite.query('SELECT started_at FROM runs WHERE id=?').get(replayStep.stage.slice('v3_replay:'.length)) as any : null;
    const assessedPolicy = items[0] ? sqlite.query('SELECT * FROM v3_policies WHERE id=?').get(items[0].policy_id) : null;
    const replay = replaySource ? { sourceRunId: replayStep.stage.slice('v3_replay:'.length), assessedAt: replaySource.started_at } : null;
    return { run, policy: assessedPolicy ?? policy, deterministicRules: [CALENDAR_RESPONSE_RULE], replay, items: items.map((a) => ({ ...a, representation: parse<Representation>(a.representation), answers: a.answers ? parse<Assessment>(a.answers) : null })), calls, steps };
  } finally { sqlite.close(); }
}

function recentRepresentation(sqlite: Database, accountId: string, threadId: string, ids: string[]): Representation | null {
  const rows = sqlite.query('SELECT representation FROM v3_assessments WHERE account_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT 8').all(accountId, threadId) as { representation: string }[];
  for (const row of rows) {
    const rep = parse<Representation>(row.representation);
    if (rep.version === REPRESENTATION_VERSION && JSON.stringify(rep.messageIds) === JSON.stringify(ids.slice(0, 4)) && rep.omittedUnread === Math.max(0, ids.length - 4) && rep.unavailable.length === 0) return rep;
  }
  return null;
}

function upsertThread(sqlite: Database, accountId: string, rep: Representation) {
  const first = rep.messages[0];
  if (!first) return;
  const domain = first.from.match(/@([^>\s]+)/)?.[1]?.toLowerCase() ?? '';
  const received = Date.parse(first.date) || Date.now();
  sqlite.query(`INSERT INTO threads (id,account_id,"from",from_domain,"to",subject,snippet,received_at,is_unread,label_ids,message_ids,raw_headers,has_unsubscribe,is_calendar_invite,synced_at)
    VALUES (?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id,"from"=excluded."from",from_domain=excluded.from_domain,"to"=excluded."to",subject=excluded.subject,snippet=excluded.snippet,received_at=excluded.received_at,is_unread=1,label_ids=excluded.label_ids,message_ids=excluded.message_ids,has_unsubscribe=excluded.has_unsubscribe,is_calendar_invite=excluded.is_calendar_invite,synced_at=excluded.synced_at`).run(
    rep.threadId, accountId, first.from, domain, first.to, first.subject, first.body.slice(0, 180), received,
    JSON.stringify(first.labels), JSON.stringify(rep.messageIds), '{}', first.hasUnsubscribe ? 1 : 0, first.isCalendarInvite ? 1 : 0, Date.now()
  );
}

const activeRuns = new Map<string, { id: string; job: Promise<void> }>();
export async function startAssessment(accountId: string, limit = 100): Promise<string> {
  if (!process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY.includes('your_')) throw new ReviewError('Set OPENROUTER_API_KEY to assess with Jev', 400);
  const active = activeRuns.get(accountId);
  if (active) return active.id;
  const sqlite = openV3Database();
  const account = sqlite.query('SELECT id FROM tokens WHERE id = ?').get(accountId);
  if (!account) { sqlite.close(); throw new Error('Account not connected'); }
  getOrCreatePolicy(sqlite, accountId);
  const id = crypto.randomUUID();
  sqlite.query('INSERT INTO runs (id, account_id, started_at, scope, status) VALUES (?, ?, ?, ?, ?)').run(id, accountId, Date.now(), 'v3', 'running');
  sqlite.close();
  const job = assessAccount(accountId, id, Math.min(200, Math.max(1, limit))).finally(() => activeRuns.delete(accountId));
  activeRuns.set(accountId, { id, job });
  return id;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

function recordStage(sqlite: Database, accountId: string, runId: string, stage: string, startedAt: number, status: 'completed' | 'failed', total: number, error: string | null = null) {
  sqlite.query(`INSERT INTO run_steps (id,run_id,account_id,stage,status,total,duration_ms,error,started_at,updated_at,ended_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(crypto.randomUUID(),runId,accountId,stage,status,total,Date.now()-startedAt,error,startedAt,Date.now(),Date.now());
}

async function assessAccount(accountId: string, runId: string, limit: number) {
  const sqlite = openV3Database();
  try {
    const fetchStarted = Date.now();
    const policy = getOrCreatePolicy(sqlite, accountId);
    const gmail = await getGmailClient(accountId);
    const listed: { id?: string | null; threadId?: string | null }[] = [];
    let pageToken: string | undefined;
    do {
      const response = await gmail.users.messages.list({ userId: 'me', q: 'is:unread in:inbox newer_than:30d', maxResults: 500, pageToken });
      listed.push(...(response.data.messages ?? []));
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken && listed.length < limit * 5);
    const grouped = new Map<string, string[]>();
    for (const item of listed) if (item.id && item.threadId) grouped.set(item.threadId, [...(grouped.get(item.threadId) ?? []), item.id]);
    const entries = [...grouped.entries()].slice(0, limit);
    const fresh: { rep: Representation; key: string }[] = [];
    await mapLimit(entries, 6, async ([threadId, ids]) => {
      let rep = recentRepresentation(sqlite, accountId, threadId, ids);
      if (!rep) {
        const fetched = new Map<string, any | Error>();
        await mapLimit(ids.slice(0, 4), 3, async (id) => {
          try { fetched.set(id, (await gmail.users.messages.get({ userId: 'me', id, format: 'full' })).data); }
          catch (error) { fetched.set(id, error instanceof Error ? error : new Error(String(error))); }
        });
        rep = prepareThread(threadId, ids, fetched);
      }
      upsertThread(sqlite, accountId, rep);
      const key = hash({ rep, contextDate: cacheContext(rep) });
      if (deterministicHandling(rep)) {
        saveDeterministicAssessment(sqlite, accountId, runId, policy.id, RUBRIC_VERSION, rep, key);
        return;
      }
      const cached = sqlite.query('SELECT id FROM v3_assessments WHERE account_id = ? AND thread_id = ? AND input_key = ? AND policy_id = ? AND rubric_version = ? AND model = ? AND answers IS NOT NULL AND error IS NULL ORDER BY created_at DESC LIMIT 1').get(accountId, threadId, key, policy.id, RUBRIC_VERSION, V3_MODEL) as { id: string } | null;
      if (cached) sqlite.query('INSERT OR IGNORE INTO v3_run_items (run_id, assessment_id) VALUES (?, ?)').run(runId, cached.id);
      else fresh.push({ rep, key });
    });
    recordStage(sqlite, accountId, runId, 'v3_fetch_prepare', fetchStarted, 'completed', entries.length);
    const assessStarted = Date.now();
    // Shared multi-thread state produced cross-thread interference in the
    // September audit. Keep all six questions together, but isolate each thread.
    const batches = fresh.map((item) => [item]);
    await mapLimit(batches, 4, async (batch) => {
      const started = performance.now();
      try {
        const result = await callJev(batch.map((x) => x.rep), policy.text);
        sqlite.query('INSERT INTO v3_call_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), runId, accountId, result.model, batch.length, result.promptChars, result.usage.input_tokens ?? null, result.usage.output_tokens ?? null, result.durationMs, 'completed', null, Date.now());
        batch.forEach((item, i) => insertAssessment(sqlite, accountId, runId, policy.id, item, result.assessments[i], result.model));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sqlite.query('INSERT INTO v3_call_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(crypto.randomUUID(), runId, accountId, V3_MODEL, batch.length, 0, null, null, Math.round(performance.now() - started), 'failed', message, Date.now());
        batch.forEach((item) => insertAssessment(sqlite, accountId, runId, policy.id, item, new Error(message)));
      }
    });
    recordStage(sqlite, accountId, runId, 'v3_assess', assessStarted, 'completed', fresh.length);
    sqlite.query("UPDATE runs SET status = 'completed', ended_at = ? WHERE id = ?").run(Date.now(), runId);
  } catch (error) {
    const reauth = await handleReauthCleanup(error, accountId);
    sqlite.query("UPDATE runs SET status = ?, ended_at = ? WHERE id = ?").run(reauth ? 'reauth_required' : 'failed', Date.now(), runId);
    console.error('v3 run failed:', error);
  } finally { sqlite.close(); }
}

function insertAssessment(sqlite: Database, accountId: string, runId: string, policyId: string, item: { rep: Representation; key: string }, result: Assessment | Error, actualModel: string | null = null) {
  const assessment = result instanceof Error ? null : result;
  const handling = resolveHandling(assessment, item.rep);
  const id = crypto.randomUUID();
  sqlite.query(`INSERT INTO v3_assessments (id,account_id,thread_id,input_key,policy_id,rubric_version,model,actual_model,representation,answers,proposed_action,final_action,lane,reason,priority,status,error,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, accountId, item.rep.threadId, item.key, policyId, RUBRIC_VERSION, V3_MODEL, actualModel, JSON.stringify(item.rep), assessment ? JSON.stringify(assessment) : null, handling.action, handling.finalAction, handling.lane, handling.reason, handling.priority, handling.status, result instanceof Error ? result.message : null, Date.now());
  sqlite.query('INSERT OR IGNORE INTO v3_run_items (run_id, assessment_id) VALUES (?, ?)').run(runId, id);
}

export class ReviewError extends Error { constructor(message: string, public statusCode = 400) { super(message); } }

export async function submitReviewedSet(accountId: string, runId: string, decisions: ReviewDecision[], actor = 'human') {
  if (!decisions.length) throw new ReviewError('No decisions submitted');
  if (new Set(decisions.map((d) => d.assessmentId)).size !== decisions.length) throw new ReviewError('Duplicate assessment');
  const sqlite = openV3Database();
  const valid = new Set(['trash', 'archive', 'label_todo', 'leave']);
  const kinds = new Set(['approve', 'correct', 'skip', 'done']);
  const chips = new Set(['already_handled', 'other_owner', 'worth_reading', 'actual_receipt', 'show_before_clearing']);
  try {
    const run = sqlite.query("SELECT id FROM runs WHERE id = ? AND account_id = ? AND scope = 'v3' AND status = 'completed'").get(runId, accountId);
    if (!run) throw new ReviewError('Run is not ready', 409);
    const rows = decisions.map((d) => {
      if (!valid.has(d.disposition) || !kinds.has(d.kind) || (d.finalDisposition && !valid.has(d.finalDisposition))) throw new ReviewError('Invalid decision');
      if ((d.chip && !chips.has(d.chip)) || (d.note !== undefined && typeof d.note !== 'string') || (d.acknowledged !== undefined && typeof d.acknowledged !== 'boolean')) throw new ReviewError('Invalid feedback');
      if (d.kind === 'done' && !d.finalDisposition) throw new ReviewError('Done requires final handling');
      const row = sqlite.query(`SELECT a.* FROM v3_assessments a JOIN v3_run_items i ON i.assessment_id = a.id WHERE i.run_id = ? AND a.id = ? AND a.account_id = ?`).get(runId, d.assessmentId, accountId) as any;
      if (!row) throw new ReviewError('Assessment not in run', 404);
      if (sqlite.query('SELECT id FROM v3_reviews WHERE assessment_id = ?').get(d.assessmentId)) throw new ReviewError('Already reviewed', 409);
      const current = sqlite.query('SELECT message_ids FROM threads WHERE id = ? AND account_id = ?').get(row.thread_id, accountId) as { message_ids: string } | null;
      if (!current || JSON.stringify(parse<Representation>(row.representation).messageIds) !== current.message_ids) throw new ReviewError('Message snapshot changed; assess again', 409);
      if ((row.lane === 'show_me' || d.chip === 'show_before_clearing') && (d.disposition === 'trash' || d.finalDisposition === 'trash') && !d.acknowledged) throw new ReviewError('Acknowledge before clearing', 400);
      // Show-before-clearing proposes leaving the mail until seen, then its final
      // handling; carrying out that final handling is agreement, not a correction.
      const proposed = [row.proposed_action, ...(row.lane === 'show_me' ? [row.final_action] : [])];
      if (d.kind === 'approve' && (row.status !== 'ready' || !proposed.includes(d.disposition))) throw new ReviewError('Approve must match a ready proposal');
      if (d.kind === 'skip' && d.disposition !== 'leave') throw new ReviewError('Skip leaves mail untouched');
      return { d, row };
    });
    // Verify the live Gmail snapshot before any mutation. Another inbound unread
    // message must never inherit a decision made against the older message set.
    const gmail = await getGmailClient(accountId);
    for (const { row } of rows) {
      const live = await gmail.users.threads.get({ userId: 'me', id: row.thread_id, format: 'minimal' });
      const liveUnread = (live.data.messages ?? []).filter((m) => m.labelIds?.includes('UNREAD') && m.labelIds?.includes('INBOX')).map((m) => m.id).filter(Boolean).reverse();
      const expected = parse<Representation>(row.representation).messageIds;
      if (JSON.stringify(liveUnread.slice(0, 4)) !== JSON.stringify(expected)) throw new ReviewError('New or changed unread message; assess again', 409);
    }
    const out = [];
    for (const { d, row } of rows) {
      const target = d.kind === 'done' ? d.finalDisposition! : d.disposition;
      const reviewId = crypto.randomUUID();
      sqlite.query(`INSERT INTO v3_reviews (id,account_id,assessment_id,run_id,actor,kind,disposition,final_disposition,acknowledged,chip,note,execution_status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(reviewId, accountId, d.assessmentId, runId, actor, d.kind, d.disposition, d.finalDisposition ?? null, d.acknowledged ? 1 : 0, d.chip ?? null, d.note?.slice(0, 4000) ?? null, target === 'leave' ? 'no_action' : 'pending', Date.now());
      if (target === 'leave') { out.push({ assessmentId: d.assessmentId, status: 'no_action' }); continue; }
      let applied;
      try {
        applied = await applyThreadAction({ accountId, runId, threadId: row.thread_id, action: target, verdict: d.kind, note: d.note ?? null });
      } catch (error) {
        sqlite.query('DELETE FROM v3_reviews WHERE id = ?').run(reviewId);
        throw error;
      }
      sqlite.query('UPDATE v3_reviews SET action_id = ?, execution_status = ?, error = ? WHERE id = ?').run(applied.actionId ?? null, applied.status, applied.error ?? null, reviewId);
      out.push({ assessmentId: d.assessmentId, status: applied.status, actionId: applied.actionId, error: applied.error });
    }
    return out;
  } finally { sqlite.close(); }
}

export async function undoReviewedAction(accountId: string, actionId: string) {
  const sqlite = openV3Database();
  try {
    const review = sqlite.query('SELECT id FROM v3_reviews WHERE account_id = ? AND action_id = ?').get(accountId, actionId);
    if (!review) throw new ReviewError('Review action not found', 404);
    const result = await undoAction(accountId, actionId);
    if (result.status === 'applied') sqlite.query("UPDATE v3_reviews SET execution_status = 'undone' WHERE account_id = ? AND action_id = ?").run(accountId, actionId);
    return result;
  } finally { sqlite.close(); }
}

export async function undoReviewedRun(accountId: string, runId: string) {
  const sqlite = openV3Database();
  try {
    if (!sqlite.query("SELECT id FROM runs WHERE id = ? AND account_id = ? AND scope = 'v3'").get(runId, accountId)) throw new ReviewError('Run not found', 404);
    const rows = sqlite.query(`SELECT r.action_id FROM v3_reviews r JOIN actions a ON a.id = r.action_id
      WHERE r.account_id = ? AND r.run_id = ? AND a.status = 'applied' ORDER BY a.applied_at DESC`).all(accountId, runId) as { action_id: string }[];
    const outcomes = [];
    for (const row of rows) outcomes.push(await undoReviewedAction(accountId, row.action_id));
    return { undone: outcomes.filter((o) => o.status === 'applied').length, failed: outcomes.filter((o) => o.status === 'failed').length };
  } finally { sqlite.close(); }
}

/** On-demand fuller conversation inspection for UI and future local adapters. */
export async function inspectThreadContent(accountId: string, threadId: string) {
  const sqlite = openV3Database();
  try {
    if (!sqlite.query('SELECT id FROM threads WHERE id = ? AND account_id = ?').get(threadId, accountId)) throw new ReviewError('Thread not found', 404);
  } finally { sqlite.close(); }
  const gmail = await getGmailClient(accountId);
  const response = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
  return (response.data.messages ?? []).map((message) => {
    const headers = message.payload?.headers ?? [];
    const header = (name: string) => headers.find((h) => h.name?.toLowerCase() === name)?.value ?? '';
    const body = extractBody(message.payload);
    return { id: message.id, from: header('from'), date: header('date'), html: body.html ? sanitizeHtml(body.html) : null, text: body.text };
  });
}

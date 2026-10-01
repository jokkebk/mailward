import type { Database } from 'bun:sqlite';
import type { PreparedMessage, RecipeCondition, RecipeSpec, Representation } from '$lib/types/v3';
import type { HandlingResult } from './assessment';
import calendarRsvp from './recipes/calendar-rsvp.json';
import calendarReminders from './recipes/calendar-reminders.json';
import signInCodes from './recipes/sign-in-codes.json';
import unsubscribeConfirmations from './recipes/unsubscribe-confirmations.json';
import signatureRequests from './recipes/signature-requests.json';
import stripeReceipts from './recipes/stripe-receipts.json';

// Recipes are data: a generic handler evaluates JSON conditions over the
// representation's metadata. Code supplies the fields; recipes combine them.
// Matching is deliberately unconstrained — a person or agent decides what is
// safe enough, and settings show what each recipe matched in recent mail.

/** Shipped catalogue. Adopting copies a recipe into the account; later library edits never change it silently. */
export const RECIPE_LIBRARY: { spec: RecipeSpec; version: number; recommended: boolean }[] = [
  { spec: calendarRsvp as RecipeSpec, version: 1, recommended: true },
  { spec: calendarReminders as RecipeSpec, version: 1, recommended: false },
  { spec: signInCodes as RecipeSpec, version: 1, recommended: false },
  { spec: unsubscribeConfirmations as RecipeSpec, version: 1, recommended: false },
  { spec: signatureRequests as RecipeSpec, version: 1, recommended: false },
  { spec: stripeReceipts as RecipeSpec, version: 1, recommended: false }
];

/** Fields a condition can read. `thread.*` fields are the same for every message. */
export const RECIPE_FIELDS: Record<string, string> = {
  from: 'From header, e.g. "Name <a@b.com>"', fromAddress: 'Sender address only', fromDomain: 'Sender domain',
  to: 'To header', cc: 'Cc header', replyTo: 'Reply-To header', deliveredTo: 'Delivered-To header',
  subject: 'Subject', body: 'Bounded body text Jev would see', labels: 'Gmail label IDs (list)',
  hasUnsubscribe: 'Has a List-Unsubscribe header', isCalendarInvite: 'Carries a calendar invitation',
  clipped: 'Body was clipped to fit', missingBody: 'No readable body', attachmentsNotRead: 'Has unread document attachments',
  attachmentNames: 'Attachment filenames (list)', attachmentTypes: 'Attachment MIME types (list)', linkUrls: 'Meaningful link URLs (list)',
  'calendar.kind': 'response | invitation | update | other', 'calendar.responseOnly': 'Bare generated RSVP with no note',
  'calendar.note': 'Human note on a calendar message', 'calendar.eventTime': 'Event time text',
  'thread.messageCount': 'Unread messages assessed', 'thread.omittedUnread': 'Unread messages beyond the first four',
  'thread.unavailableCount': 'Messages that could not be fetched'
};
const OPERATORS = ['equals', 'matches', 'contains', 'in', 'is', 'shorterThan', 'longerThan'] as const;

export class RecipeError extends Error {}

function facts(message: PreparedMessage, rep: Representation): Record<string, unknown> {
  const address = (message.from.match(/<([^>]+)>/)?.[1] ?? message.from).trim().toLowerCase();
  return {
    ...message, fromAddress: address, fromDomain: address.split('@')[1] ?? '',
    attachmentNames: message.attachments.map((a) => a.name), attachmentTypes: message.attachments.map((a) => a.mime),
    linkUrls: message.links.map((l) => l.url),
    'calendar.kind': message.calendar?.kind ?? null, 'calendar.responseOnly': message.calendar?.responseOnly ?? false,
    'calendar.note': message.calendar?.note || null, 'calendar.eventTime': message.calendar?.eventTime ?? null,
    'thread.messageCount': rep.messages.length, 'thread.omittedUnread': rep.omittedUnread, 'thread.unavailableCount': rep.unavailable.length
  };
}

const lower = (v: unknown) => String(v).toLowerCase();
function test(condition: RecipeCondition, f: Record<string, unknown>): boolean {
  if ('any' in condition) return condition.any.some((c) => test(c, f));
  if ('all' in condition) return condition.all.every((c) => test(c, f));
  if ('not' in condition) return !test(condition.not, f);
  const value = f[condition.field];
  const values: unknown[] = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  const empty = values.length === 0 || values.every((v) => v === '' || v === false);
  if (condition.is !== undefined) {
    if (condition.is === null) return Array.isArray(value) ? value.length === 0 : value === null || value === undefined || value === '';
    return value === condition.is;
  }
  if (condition.equals !== undefined) return values.some((v) => typeof v === 'string' && typeof condition.equals === 'string' ? lower(v) === lower(condition.equals) : v === condition.equals);
  if (condition.matches !== undefined) { const re = new RegExp(condition.matches, 'i'); return values.some((v) => re.test(String(v))); }
  if (condition.contains !== undefined) return values.some((v) => lower(v).includes(lower(condition.contains)));
  if (condition.in !== undefined) return values.some((v) => condition.in!.some((x) => typeof x === 'string' ? lower(v) === lower(x) : v === x));
  if (condition.shorterThan !== undefined) return empty || values.every((v) => String(v).length < condition.shorterThan!);
  if (condition.longerThan !== undefined) return values.some((v) => String(v).length > condition.longerThan!);
  return false;
}

export function recipeMatches(spec: RecipeSpec, rep: Representation): boolean {
  if (!rep.messages.length) return false;
  if (spec.completeContentOnly !== false && (rep.unavailable.length || rep.omittedUnread || rep.messages.some((m) => m.missingBody))) return false;
  const passes = (m: PreparedMessage) => { const f = facts(m, rep); return spec.match.every((c) => test(c, f)); };
  return spec.messages === 'any' ? rep.messages.some(passes) : rep.messages.every(passes);
}

export function recipeHandling(spec: RecipeSpec): HandlingResult {
  const reason = spec.reason || spec.title;
  if (spec.action === 'label_todo') {
    const lane = spec.section === 'worth_reading' ? 'worth_reading' as const : 'needs_action' as const;
    return { action: 'label_todo', finalAction: spec.then ?? 'archive', lane, reason, priority: lane === 'needs_action' ? 100 : 60, status: 'ready' };
  }
  if (spec.section === 'show_before_clearing') return { action: 'leave', finalAction: spec.action, lane: 'show_me', reason, priority: 30, status: 'ready' };
  return { action: spec.action, finalAction: spec.action, lane: 'cleanup', reason, priority: 0, status: 'ready' };
}

function checkCondition(c: unknown, path: string) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new RecipeError(`${path} must be an object`);
  const o = c as Record<string, unknown>;
  for (const group of ['any', 'all'] as const) if (group in o) {
    if (!Array.isArray(o[group]) || !(o[group] as unknown[]).length) throw new RecipeError(`${path}.${group} must be a non-empty list`);
    (o[group] as unknown[]).forEach((x, i) => checkCondition(x, `${path}.${group}[${i}]`));
    return;
  }
  if ('not' in o) return checkCondition(o.not, `${path}.not`);
  if (typeof o.field !== 'string' || !(o.field in RECIPE_FIELDS)) throw new RecipeError(`${path}.field must be one of: ${Object.keys(RECIPE_FIELDS).join(', ')}`);
  const ops = OPERATORS.filter((op) => op in o);
  if (ops.length !== 1) throw new RecipeError(`${path} needs exactly one of: ${OPERATORS.join(', ')}`);
  const [op] = ops, v = o[op];
  if (op === 'matches') { if (typeof v !== 'string') throw new RecipeError(`${path}.matches must be a string`); try { new RegExp(v, 'i'); } catch (e) { throw new RecipeError(`${path}.matches is not a valid pattern: ${(e as Error).message}`); } }
  if ((op === 'contains') && typeof v !== 'string') throw new RecipeError(`${path}.contains must be a string`);
  if ((op === 'shorterThan' || op === 'longerThan') && typeof v !== 'number') throw new RecipeError(`${path}.${op} must be a number`);
  if (op === 'in' && !Array.isArray(v)) throw new RecipeError(`${path}.in must be a list`);
  if (op === 'is' && v !== null && typeof v !== 'boolean') throw new RecipeError(`${path}.is must be true, false or null`);
}

/** Parse and check shape only; what a recipe matches is the author's call. */
export function parseRecipe(input: unknown): RecipeSpec {
  const spec = (typeof input === 'string' ? (() => { try { return JSON.parse(input); } catch (e) { throw new RecipeError(`Not valid JSON: ${(e as Error).message}`); } })() : input) as RecipeSpec;
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new RecipeError('A recipe is a JSON object');
  if (typeof spec.key !== 'string' || !/^[a-z0-9][a-z0-9-]{1,48}$/.test(spec.key)) throw new RecipeError('key must be a short lowercase slug, e.g. "calendar-replies"');
  if (typeof spec.title !== 'string' || !spec.title.trim()) throw new RecipeError('title is required');
  if (!['trash', 'archive', 'label_todo'].includes(spec.action)) throw new RecipeError('action must be trash, archive or label_todo');
  if (spec.section !== undefined) {
    const todo = spec.action === 'label_todo';
    if (todo ? !['needs_action', 'worth_reading'].includes(spec.section) : spec.section !== 'show_before_clearing') throw new RecipeError(todo ? 'A TODO section is needs_action or worth_reading' : 'Trash or Archive can only use section "show_before_clearing"');
  }
  if (spec.then !== undefined && (spec.action !== 'label_todo' || !['trash', 'archive', 'leave'].includes(spec.then))) throw new RecipeError('then applies to TODO recipes: trash, archive or leave');
  if (spec.messages !== undefined && !['every', 'any'].includes(spec.messages)) throw new RecipeError('messages must be "every" or "any"');
  if (spec.completeContentOnly !== undefined && typeof spec.completeContentOnly !== 'boolean') throw new RecipeError('completeContentOnly must be true or false');
  if (!Array.isArray(spec.match) || !spec.match.length) throw new RecipeError('match needs at least one condition');
  spec.match.forEach((c, i) => checkCondition(c, `match[${i}]`));
  return spec;
}

// ── Persistence ─────────────────────────────────────────────────────────────

export interface RecipeRecord { id: string; key: string; version: number; spec: RecipeSpec; status: 'active' | 'paused'; position: number; source: string | null; created_by: string; created_at: number; updated_at: number }

export function listRecipes(db: Database, accountId: string, activeOnly = false): RecipeRecord[] {
  const rows = db.query(`SELECT id,key,version,spec,status,position,source,created_by,created_at,updated_at FROM v3_recipes
    WHERE account_id=? AND status ${activeOnly ? "='active'" : "IN ('active','paused')"} ORDER BY position, created_at`).all(accountId) as any[];
  return rows.map((r) => ({ ...r, spec: JSON.parse(r.spec) }));
}

/** First active recipe in list order wins. */
export function firstMatch(recipes: RecipeRecord[], rep: Representation): RecipeRecord | null {
  return recipes.find((r) => r.status === 'active' && recipeMatches(r.spec, rep)) ?? null;
}

/** Adopt a new recipe or append a version of an existing key. The previous version retires. */
export function saveRecipe(db: Database, accountId: string, input: unknown, actor: string, source: string | null = null): RecipeRecord {
  const spec = parseRecipe(input);
  return db.transaction(() => {
    const current = db.query("SELECT id,version,status,position,source FROM v3_recipes WHERE account_id=? AND key=? AND status IN ('active','paused')").get(accountId, spec.key) as { id: string; version: number; status: 'active' | 'paused'; position: number; source: string | null } | null;
    const latest = db.query('SELECT MAX(version) AS v FROM v3_recipes WHERE account_id=? AND key=?').get(accountId, spec.key) as { v: number | null };
    const prior = current ? (db.query('SELECT spec FROM v3_recipes WHERE id=?').get(current.id) as { spec: string }).spec : null;
    if (prior && JSON.stringify(JSON.parse(prior)) === JSON.stringify(spec)) throw new RecipeError('Recipe is unchanged');
    const position = current?.position ?? ((db.query("SELECT MAX(position) AS p FROM v3_recipes WHERE account_id=? AND status IN ('active','paused')").get(accountId) as { p: number | null }).p ?? -1) + 1;
    if (current) db.query("UPDATE v3_recipes SET status='retired', updated_at=? WHERE id=?").run(Date.now(), current.id);
    const id = crypto.randomUUID(), now = Date.now(), version = (latest.v ?? 0) + 1, status = current?.status ?? 'active';
    source = source ?? current?.source ?? null;
    db.query('INSERT INTO v3_recipes (id,account_id,key,version,spec,status,position,source,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, accountId, spec.key, version, JSON.stringify(spec), status, position, source, actor, now, now);
    return { id, key: spec.key, version, spec, status, position, source, created_by: actor, created_at: now, updated_at: now };
  }).immediate();
}

export function adoptLibraryRecipe(db: Database, accountId: string, key: string, actor: string): RecipeRecord {
  const entry = RECIPE_LIBRARY.find((r) => r.spec.key === key);
  if (!entry) throw new RecipeError('No such library recipe');
  return saveRecipe(db, accountId, entry.spec, actor, `library:${key}@${entry.version}`);
}

export function setRecipeStatus(db: Database, accountId: string, key: string, status: 'active' | 'paused' | 'retired') {
  const changed = db.query("UPDATE v3_recipes SET status=?, updated_at=? WHERE account_id=? AND key=? AND status IN ('active','paused')").run(status, Date.now(), accountId, key);
  if (!changed.changes) throw new RecipeError('Recipe not found');
}

/** Move a recipe one step earlier or later in match order. */
export function moveRecipe(db: Database, accountId: string, key: string, delta: -1 | 1) {
  db.transaction(() => {
    const list = listRecipes(db, accountId);
    const i = list.findIndex((r) => r.key === key), j = i + delta;
    if (i < 0) throw new RecipeError('Recipe not found');
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    list.forEach((r, n) => db.query('UPDATE v3_recipes SET position=? WHERE id=?').run(n, r.id));
  })();
}

/** Stored-evidence dry run: which recent threads would a recipe match, and how were they reviewed? No Gmail or model calls. */
export function recentMatches(db: Database, accountId: string, specs: RecipeSpec[], days = 30) {
  const rows = db.query(`SELECT a.thread_id, a.representation, a.created_at,
      (SELECT COALESCE(r.final_disposition, r.disposition) FROM v3_assessments b JOIN v3_reviews r ON r.assessment_id=b.id
        WHERE b.account_id=a.account_id AND b.thread_id=a.thread_id AND r.kind<>'skip' ORDER BY r.created_at DESC LIMIT 1) AS reviewed
    FROM v3_assessments a WHERE a.account_id=? AND a.created_at>=? AND a.created_at=(SELECT MAX(c.created_at) FROM v3_assessments c WHERE c.account_id=a.account_id AND c.thread_id=a.thread_id)
    ORDER BY a.created_at DESC LIMIT 1500`).all(accountId, Date.now() - days * 86_400_000) as { thread_id: string; representation: string; created_at: number; reviewed: string | null }[];
  const reps = rows.map((r) => ({ ...r, rep: JSON.parse(r.representation) as Representation }));
  const byThread = new Map<string, string[]>();
  const results = specs.map((spec) => {
    const hits = reps.filter((r) => { try { return recipeMatches(spec, r.rep); } catch { return false; } });
    for (const h of hits) byThread.set(h.thread_id, [...(byThread.get(h.thread_id) ?? []), spec.key]);
    const reviewed = hits.filter((h) => h.reviewed);
    const target = spec.action === 'label_todo' ? ['label_todo', spec.then ?? 'archive'] : [spec.action];
    return {
      key: spec.key, matched: hits.length, reviewed: reviewed.length,
      agreed: reviewed.filter((h) => target.includes(h.reviewed!)).length,
      samples: hits.slice(0, 8).map((h) => ({ from: h.rep.messages[0]?.from ?? '', subject: h.rep.messages[0]?.subject ?? '', reviewed: h.reviewed }))
    };
  });
  return { scanned: reps.length, days, results: results.map((r) => ({ ...r, overlaps: [...new Set([...byThread.values()].filter((keys) => keys.includes(r.key) && keys.length > 1).flat())].filter((k) => k !== r.key) })) };
}

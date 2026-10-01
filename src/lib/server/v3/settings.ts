import type { Database } from 'bun:sqlite';
import type { PolicyCard, Representation } from '$lib/types/v3';
import { buildAssessmentRequest, RUBRIC_VERSION, V3_MODEL } from './assessment';
import { weeklyPacket } from './learning';
import { cardsOf, createInitialPolicy, createPolicyRevision, getOrCreatePolicy, getPolicy, policyText, STARTER_CARDS, SUGGESTED_CARDS, type PolicyRecord } from './policy';
import { adoptLibraryRecipe, listRecipes, moveRecipe, parseRecipe, RECIPE_FIELDS, RECIPE_LIBRARY, RecipeError, recentMatches, saveRecipe, setRecipeStatus } from './recipes';

// Settings: the account's guidance cards, recipes and policy history, plus a
// read-only view of how Jev is asked. Everything here is stored data; nothing
// calls Gmail or Jev.

export class SettingsError extends Error { constructor(message: string, public statusCode = 400) { super(message); } }

const words = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);
const SOURCE_NOTE: Record<string, string> = { 'v3-starter': 'Starter guidance', setup: 'Initial setup' };
function noteOf(p: PolicyRecord): string | null {
  try { const r = JSON.parse(p.import_report ?? '{}'); return r.note ?? SOURCE_NOTE[r.source] ?? r.source ?? null; } catch { return null; }
}

/** Runs started before setup get the starter guidance and the recommended recipes. */
export function ensureAccountSetup(db: Database, accountId: string): PolicyRecord {
  const existing = getPolicy(db, accountId);
  if (existing) return existing;
  const policy = getOrCreatePolicy(db, accountId);
  if (!db.query('SELECT 1 FROM v3_recipes WHERE account_id=? LIMIT 1').get(accountId))
    for (const r of RECIPE_LIBRARY.filter((r) => r.recommended)) adoptLibraryRecipe(db, accountId, r.spec.key, 'bootstrap');
  return policy;
}

export interface SetupInput { name?: string; role?: string; starter?: string[]; suggested?: string[]; topics?: string; recipes?: string[] }

/** Compose the first policy from the setup form. Unchecked starter cards are kept, switched off. */
export function setupCards(input: SetupInput): PolicyCard[] {
  const name = input.name?.trim(), role = input.role?.trim(), topics = input.topics?.trim();
  const starter = new Set(input.starter ?? STARTER_CARDS.map((c) => c.id)), suggested = new Set(input.suggested ?? []);
  const about: PolicyCard[] = name ? [{ id: 'about', title: 'About you', enabled: true, body: `This inbox belongs to ${name}${role ? `, ${role}` : ''}. "The account holder" in this guidance means them.` }] : [];
  const extras = SUGGESTED_CARDS.filter((c) => suggested.has(c.id) && (!c.input || topics))
    .map(({ blurb: _b, input: _i, ...c }) => ({ ...c, body: c.body.replace('{topics}', topics ?? '') }));
  return [...about, ...STARTER_CARDS.map((c) => ({ ...c, enabled: starter.has(c.id) })), ...extras];
}

export function setupAccount(db: Database, accountId: string, input: SetupInput) {
  const cards = setupCards(input);
  return db.transaction(() => {
    try { createInitialPolicy(db, accountId, cards); } catch (e) { throw new SettingsError((e as Error).message, getPolicy(db, accountId) ? 409 : 400); }
    for (const key of input.recipes ?? []) adoptLibraryRecipe(db, accountId, key, 'setup');
  })();
}

/** The six questions as Jev receives them, with the shared preamble pulled out once. */
function jevQuestions() {
  const rep: Representation = { version: 3, threadId: 'x', messageIds: [], omittedUnread: 0, historyNotFetched: true, messages: [], unavailable: [] };
  const questions = Object.entries(buildAssessmentRequest([rep], '').questions as Record<string, { type: string; instructions: string; criteria: Record<string, string> | string[] }>);
  const texts = questions.map(([, q]) => q.instructions);
  let shared = texts[0];
  for (const t of texts) while (!t.startsWith(shared)) shared = shared.slice(0, shared.lastIndexOf(' ', shared.length - 2) + 1);
  return {
    shared: shared.trim(),
    questions: questions.map(([key, q]) => ({
      key: key.replace(/^t0_/, ''), kind: q.type, instruction: q.instructions.slice(shared.length).trim(),
      options: Array.isArray(q.criteria) ? q.criteria.map((label, i) => ({ key: String(i), label })) : Object.entries(q.criteria).map(([k, label]) => ({ key: k, label }))
    }))
  };
}

export function loadSettings(db: Database, accountId: string) {
  if (!db.query('SELECT id FROM tokens WHERE id = ?').get(accountId)) throw new SettingsError('Account not connected', 404);
  const policy = getPolicy(db, accountId);
  const history = (db.query('SELECT id, version_no, text, rubric_version, status, import_report, sections, created_by, created_at FROM v3_policies WHERE account_id = ? ORDER BY version_no DESC').all(accountId) as PolicyRecord[])
    .map((p) => ({ id: p.id, version: p.version_no, createdBy: p.created_by, createdAt: p.created_at, note: noteOf(p), words: words(p.text), text: p.text }));
  const recipes = listRecipes(db, accountId);
  const adopted = new Set(recipes.map((r) => r.key));
  const packet = weeklyPacket(db, accountId, Date.now() - 30 * 86_400_000, 0);
  const agreement = new Map<number, { version: number; comparable: number; matched: number }>();
  for (const c of packet.cohorts.filter((c) => c.source === 'jev')) {
    const a = agreement.get(c.policyVersion) ?? { version: c.policyVersion, comparable: 0, matched: 0 };
    a.comparable += c.comparable; a.matched += c.matched; agreement.set(c.policyVersion, a);
  }
  const lastRun = db.query("SELECT COUNT(*) AS n FROM v3_run_items i JOIN runs r ON r.id = i.run_id WHERE r.id = (SELECT id FROM runs WHERE account_id = ? AND scope = 'v3' ORDER BY started_at DESC LIMIT 1)").get(accountId) as { n: number };
  return {
    accountId, setupNeeded: !policy,
    policy: policy ? { id: policy.id, version: policy.version_no, cards: cardsOf(policy), words: words(policy.text), createdBy: policy.created_by, createdAt: policy.created_at, note: noteOf(policy) } : null,
    history,
    agreement: [...agreement.values()].filter((a) => a.comparable).sort((a, b) => b.version - a.version),
    lastRunThreads: lastRun.n,
    recipes: recipes.map((r) => ({ key: r.key, version: r.version, status: r.status, source: r.source, createdBy: r.created_by, updatedAt: r.updated_at, spec: r.spec })),
    recipeStats: recentMatches(db, accountId, recipes.filter((r) => r.status === 'active').map((r) => r.spec)),
    library: RECIPE_LIBRARY.map((r) => ({ spec: r.spec, version: r.version, recommended: r.recommended, adopted: adopted.has(r.spec.key) })),
    fields: RECIPE_FIELDS,
    jev: { model: V3_MODEL, rubricVersion: RUBRIC_VERSION, ...jevQuestions() },
    setup: { starter: STARTER_CARDS, suggested: SUGGESTED_CARDS }
  };
}

export type SettingsOp =
  | { op: 'savePolicy'; expectedPolicyId: string; cards: PolicyCard[]; note?: string }
  | { op: 'restorePolicy'; expectedPolicyId: string; policyId: string }
  | { op: 'setup' } & SetupInput
  | { op: 'saveRecipe'; recipe: unknown }
  | { op: 'testRecipe'; recipe: unknown }
  | { op: 'adoptRecipe'; key: string }
  | { op: 'recipeStatus'; key: string; status: 'active' | 'paused' }
  | { op: 'removeRecipe'; key: string }
  | { op: 'moveRecipe'; key: string; delta: -1 | 1 };

function checkCards(cards: unknown): PolicyCard[] {
  if (!Array.isArray(cards) || !cards.length) throw new SettingsError('Guidance needs at least one card');
  return cards.map((c, i) => {
    if (!c || typeof c.title !== 'string' || typeof c.body !== 'string' || typeof c.enabled !== 'boolean') throw new SettingsError(`Card ${i + 1} is malformed`);
    return { id: typeof c.id === 'string' && c.id ? c.id.slice(0, 40) : crypto.randomUUID().slice(0, 8), title: c.title.trim().slice(0, 80) || 'Untitled', body: c.body.trim(), enabled: c.enabled };
  });
}

export function applySettingsOp(db: Database, accountId: string, input: SettingsOp, actor = 'human') {
  if (!db.query('SELECT id FROM tokens WHERE id = ?').get(accountId)) throw new SettingsError('Account not connected', 404);
  try {
    switch (input.op) {
      case 'savePolicy': {
        const cards = checkCards(input.cards);
        if (!policyText(cards).trim()) throw new SettingsError('Switch on at least one card');
        const p = createPolicyRevision(db, accountId, cards, actor, input.note?.trim() || 'Edited in settings', input.expectedPolicyId);
        return { policyId: p.id, version: p.version_no };
      }
      case 'restorePolicy': {
        const old = db.query('SELECT text, sections, version_no FROM v3_policies WHERE id = ? AND account_id = ?').get(input.policyId, accountId) as PolicyRecord | null;
        if (!old) throw new SettingsError('Policy version not found', 404);
        const p = createPolicyRevision(db, accountId, cardsOf(old), actor, `Restored v${old.version_no}`, input.expectedPolicyId);
        return { policyId: p.id, version: p.version_no };
      }
      case 'setup': setupAccount(db, accountId, input); return { ok: true };
      case 'saveRecipe': { const r = saveRecipe(db, accountId, input.recipe, actor); return { key: r.key, version: r.version }; }
      case 'testRecipe': return recentMatches(db, accountId, [parseRecipe(input.recipe)]);
      case 'adoptRecipe': { const r = adoptLibraryRecipe(db, accountId, input.key, actor); return { key: r.key, version: r.version }; }
      case 'recipeStatus': setRecipeStatus(db, accountId, input.key, input.status === 'paused' ? 'paused' : 'active'); return { ok: true };
      case 'removeRecipe': setRecipeStatus(db, accountId, input.key, 'retired'); return { ok: true };
      case 'moveRecipe': moveRecipe(db, accountId, input.key, input.delta === -1 ? -1 : 1); return { ok: true };
      default: throw new SettingsError('Unknown settings operation');
    }
  } catch (error) {
    if (error instanceof SettingsError) throw error;
    if (error instanceof RecipeError) throw new SettingsError(error.message);
    const message = (error as Error).message ?? '';
    if (/^Policy (changed|is unchanged|must)/.test(message)) throw new SettingsError(message, message.startsWith('Policy changed') ? 409 : 400);
    throw error;
  }
}

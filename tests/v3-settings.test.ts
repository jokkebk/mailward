import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { prepareThread } from '../src/lib/server/v3/representation';
import { cardsOf, createPolicyRevision, getOrCreatePolicy, getPolicy, policyText, STARTER_CARDS } from '../src/lib/server/v3/policy';
import { firstMatch, listRecipes, parseRecipe, recipeHandling, recipeMatches, recentMatches, saveRecipe, setRecipeStatus, moveRecipe, RecipeError } from '../src/lib/server/v3/recipes';
import { applySettingsOp, ensureAccountSetup, loadSettings, setupCards, SettingsError } from '../src/lib/server/v3/settings';
import type { RecipeSpec } from '../src/lib/types/v3';

const b64 = (s: string) => Buffer.from(s).toString('base64url');
function mail(id: string, from: string, subject: string, body: string) {
  return { id, labelIds: ['INBOX','UNREAD'], payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: from }, { name: 'To', value: 'me@example.test' }, { name: 'Subject', value: subject }, { name: 'Date', value: 'Tue, 29 Sep 2026 09:00:00 +0300' }
  ], body: { data: b64(body) } } };
}
const thread = (id: string, ...messages: ReturnType<typeof mail>[]) => prepareThread(id, messages.map((m) => m.id), new Map(messages.map((m) => [m.id, m])));
function db(accounts = ['a']) {
  const sqlite = new Database(':memory:');
  migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });
  for (const a of accounts) sqlite.query('INSERT INTO tokens (id,access_token,refresh_token,expires_at) VALUES (?,?,?,?)').run(a,'x','y',1);
  return sqlite;
}
const receipt: RecipeSpec = { key: 'stripe', title: 'Stripe receipts', action: 'archive', match: [
  { field: 'fromDomain', matches: '(^|\\.)stripe\\.com$' }, { field: 'subject', matches: '^your receipt from ' }] };

describe('recipes', () => {
  test('match metadata with case-insensitive operators and combinators', () => {
    const rep = thread('t', mail('m', 'Acme <receipts+abc@stripe.com>', 'Your receipt from Acme #1234', 'Paid 12 €'));
    expect(recipeMatches(receipt, rep)).toBe(true);
    expect(recipeMatches({ ...receipt, match: [{ field: 'fromAddress', equals: 'RECEIPTS+abc@stripe.com' }] }, rep)).toBe(true);
    expect(recipeMatches({ ...receipt, match: [{ field: 'body', shorterThan: 5 }] }, rep)).toBe(false);
    expect(recipeMatches({ ...receipt, match: [{ any: [{ field: 'subject', contains: 'invoice' }, { field: 'subject', contains: 'RECEIPT' }] }] }, rep)).toBe(true);
    expect(recipeMatches({ ...receipt, match: [{ not: { field: 'labels', in: ['inbox'] } }] }, rep)).toBe(false);
    expect(recipeMatches({ ...receipt, match: [{ field: 'calendar.note', is: null }] }, rep)).toBe(true);
  });
  test('every unread message must match unless "any" is chosen; incomplete content falls through by default', () => {
    const rep = thread('t', mail('m1', 'x@stripe.com', 'Your receipt from A', 'ok'), mail('m2', 'person@example.test', 'Re: refund', 'Can you check?'));
    expect(recipeMatches(receipt, rep)).toBe(false);
    expect(recipeMatches({ ...receipt, messages: 'any' }, rep)).toBe(true);
    const single = thread('s', mail('m', 'x@stripe.com', 'Your receipt from A', 'ok'));
    const missing = { ...single, unavailable: ['m9'] };
    expect(recipeMatches(receipt, missing)).toBe(false);
    expect(recipeMatches({ ...receipt, completeContentOnly: false }, missing)).toBe(true);
  });
  test('handling supports Trash, Archive, TODO and show-before-clearing targets', () => {
    expect(recipeHandling(receipt)).toMatchObject({ action: 'archive', finalAction: 'archive', lane: 'cleanup', status: 'ready' });
    expect(recipeHandling({ ...receipt, action: 'label_todo' })).toMatchObject({ action: 'label_todo', finalAction: 'archive', lane: 'needs_action' });
    expect(recipeHandling({ ...receipt, action: 'label_todo', section: 'worth_reading', then: 'trash' })).toMatchObject({ lane: 'worth_reading', finalAction: 'trash' });
    expect(recipeHandling({ ...receipt, action: 'trash', section: 'show_before_clearing' })).toMatchObject({ action: 'leave', finalAction: 'trash', lane: 'show_me' });
  });
  test('validation explains malformed recipes', () => {
    expect(() => parseRecipe('{')).toThrow(RecipeError);
    expect(() => parseRecipe({ ...receipt, key: 'Bad Key' })).toThrow(/slug/);
    expect(() => parseRecipe({ ...receipt, match: [{ field: 'sender', equals: 'x' }] })).toThrow(/field must be one of/);
    expect(() => parseRecipe({ ...receipt, match: [{ field: 'subject', matches: '(' }] })).toThrow(/valid pattern/);
    expect(() => parseRecipe({ ...receipt, match: [{ field: 'subject', matches: 'a', contains: 'b' }] })).toThrow(/exactly one/);
    expect(() => parseRecipe({ ...receipt, section: 'worth_reading' })).toThrow(/show_before_clearing/);
    expect(parseRecipe(JSON.stringify(receipt)).key).toBe('stripe');
  });
  test('edits append versions, keep order and status; first active match wins', () => {
    const sqlite = db();
    saveRecipe(sqlite, 'a', receipt, 'test', 'agent');
    saveRecipe(sqlite, 'a', { ...receipt, key: 'all-stripe', title: 'All Stripe', action: 'trash', match: [receipt.match[0]] }, 'test');
    const v2 = saveRecipe(sqlite, 'a', { ...receipt, title: 'Receipts via Stripe' }, 'test');
    expect(v2.version).toBe(2);
    expect(v2.source).toBe('agent');
    expect(() => saveRecipe(sqlite, 'a', { ...receipt, title: 'Receipts via Stripe' }, 'test')).toThrow(/unchanged/);
    expect(listRecipes(sqlite, 'a').map((r) => [r.key, r.version])).toEqual([['stripe', 2], ['all-stripe', 1]]);
    const rep = thread('t', mail('m', 'x@stripe.com', 'Your receipt from A', 'ok'));
    expect(firstMatch(listRecipes(sqlite, 'a', true), rep)?.key).toBe('stripe');
    moveRecipe(sqlite, 'a', 'all-stripe', -1);
    expect(firstMatch(listRecipes(sqlite, 'a', true), rep)?.key).toBe('all-stripe');
    setRecipeStatus(sqlite, 'a', 'all-stripe', 'paused');
    expect(firstMatch(listRecipes(sqlite, 'a', true), rep)?.key).toBe('stripe');
    setRecipeStatus(sqlite, 'a', 'stripe', 'retired');
    expect(listRecipes(sqlite, 'a').map((r) => r.key)).toEqual(['all-stripe']);
    sqlite.close();
  });
  test('dry runs report matches, review agreement and overlaps from stored evidence', () => {
    const sqlite = db();
    const policy = getOrCreatePolicy(sqlite, 'a');
    const runId = crypto.randomUUID();
    sqlite.query("INSERT INTO runs (id,account_id,started_at,scope,status) VALUES (?,?,?,'v3','completed')").run(runId, 'a', Date.now());
    for (const [i, subject] of ['Your receipt from A', 'Your receipt from B', 'Weekly digest'].entries()) {
      const rep = thread(`t${i}`, mail(`m${i}`, 'x@stripe.com', subject, 'ok'));
      const id = crypto.randomUUID();
      sqlite.query(`INSERT INTO v3_assessments (id,account_id,thread_id,input_key,policy_id,rubric_version,model,representation,proposed_action,final_action,lane,reason,status,created_at)
        VALUES (?,?,?,?,?,3,'m',?,'archive','archive','cleanup','r','ready',?)`).run(id, 'a', rep.threadId, 'k', policy.id, JSON.stringify(rep), Date.now());
      if (i === 0) sqlite.query("INSERT INTO v3_reviews (id,account_id,assessment_id,run_id,actor,kind,disposition,execution_status,created_at) VALUES (?,?,?,?,'human','approve','archive','applied',?)").run(crypto.randomUUID(), 'a', id, runId, Date.now());
    }
    const report = recentMatches(sqlite, 'a', [receipt, { ...receipt, key: 'stripe-any', match: [receipt.match[0]] }]);
    expect(report.scanned).toBe(3);
    expect(report.results[0]).toMatchObject({ matched: 2, reviewed: 1, agreed: 1, overlaps: ['stripe-any'] });
    expect(report.results[1].matched).toBe(3);
    sqlite.close();
  });
});

describe('guidance cards and setup', () => {
  test('text-only policies become cards that reproduce the exact text', () => {
    const text = 'Assess mail for Kim.\n\nAccounting: Receipts are records.\n\nReading: AI news is worth reading.';
    const cards = cardsOf({ text, sections: null });
    expect(cards.map((c) => c.title)).toEqual(['Overview', 'Accounting', 'Reading']);
    expect(policyText(cards)).toBe(text);
  });
  test('title-only edits update in place; text edits append a version; stale editors are refused', () => {
    const sqlite = db();
    const v1 = getOrCreatePolicy(sqlite, 'a');
    const cards = cardsOf(v1);
    const renamed = createPolicyRevision(sqlite, 'a', cards.map((c, i) => (i ? c : { ...c, title: 'Basics' })), 'human', 'rename', v1.id);
    expect(renamed.id).toBe(v1.id);
    expect(cardsOf(getPolicy(sqlite, 'a')!)[0].title).toBe('Basics');
    const off = createPolicyRevision(sqlite, 'a', cardsOf(renamed).map((c) => (c.id === 'reading' ? { ...c, enabled: false } : c)), 'human', 'no reading', v1.id);
    expect(off.version_no).toBe(2);
    expect(off.text).not.toContain('Substantive material');
    expect(cardsOf(off).find((c) => c.id === 'reading')!.enabled).toBe(false);
    expect(JSON.parse(off.import_report!).note).toBe('no reading');
    expect(() => createPolicyRevision(sqlite, 'a', cardsOf(off), 'human', 'x', v1.id)).toThrow(/Policy changed/);
    sqlite.close();
  });
  test('setup composes guidance, adopts recipes and refuses a second setup', () => {
    const sqlite = db();
    const cards = setupCards({ name: 'Kim', role: 'designer at Acme', starter: STARTER_CARDS.filter((c) => c.id !== 'reading').map((c) => c.id), suggested: ['interests', 'cold-sales'], topics: 'typography' });
    expect(cards[0].body).toContain('Kim, designer at Acme');
    expect(cards.find((c) => c.id === 'reading')!.enabled).toBe(false);
    expect(cards.find((c) => c.id === 'interests')!.body).toContain('typography');
    expect(loadSettings(sqlite, 'a').setupNeeded).toBe(true);
    applySettingsOp(sqlite, 'a', { op: 'setup', name: 'Kim', recipes: ['calendar-rsvp', 'stripe-receipts'] });
    const settings = loadSettings(sqlite, 'a');
    expect(settings.setupNeeded).toBe(false);
    expect(settings.policy!.cards[0].title).toBe('About you');
    expect(settings.recipes.map((r) => r.key)).toEqual(['calendar-rsvp', 'stripe-receipts']);
    expect(settings.jev.questions.map((q) => q.key)).toEqual(['category', 'attention', 'retention', 'urgency', 'relevance', 'gap']);
    expect(settings.jev.questions[0].instruction).toBe('What kind of mail is this?');
    expect(() => applySettingsOp(sqlite, 'a', { op: 'setup' })).toThrow(SettingsError);
    sqlite.close();
  });
  test('a run before setup gets the starter guidance and recommended recipes', () => {
    const sqlite = db();
    ensureAccountSetup(sqlite, 'a');
    expect(getPolicy(sqlite, 'a')!.created_by).toBe('bootstrap');
    expect(listRecipes(sqlite, 'a').map((r) => r.key)).toEqual(['calendar-rsvp']);
    sqlite.close();
  });
  test('the migration keeps the calendar rule for accounts that already had a policy', () => {
    const sqlite = new Database(':memory:');
    const all = JSON.parse(require('fs').readFileSync('drizzle/meta/_journal.json', 'utf8')).entries;
    // Apply migrations up to 0008, add an existing account, then apply 0009.
    const dir = require('fs').mkdtempSync(require('os').tmpdir() + '/mw-');
    require('fs').mkdirSync(`${dir}/meta`);
    const write = (entries: any[]) => {
      require('fs').writeFileSync(`${dir}/meta/_journal.json`, JSON.stringify({ version: '7', dialect: 'sqlite', entries }));
      for (const e of entries) require('fs').copyFileSync(`drizzle/${e.tag}.sql`, `${dir}/${e.tag}.sql`);
    };
    write(all.filter((e: any) => e.tag !== '0009_v3_settings'));
    migrate(drizzle(sqlite), { migrationsFolder: dir });
    sqlite.query("INSERT INTO tokens (id,access_token,refresh_token,expires_at) VALUES ('old','x','y',1)").run();
    sqlite.query("INSERT INTO v3_policies (id,account_id,version_no,text,created_at) VALUES ('p','old',1,'text',1)").run();
    write(all);
    migrate(drizzle(sqlite), { migrationsFolder: dir });
    const [recipe] = listRecipes(sqlite, 'old');
    expect([recipe.key, recipe.version, recipe.status]).toEqual(['calendar-rsvp', 1, 'active']);
    expect(parseRecipe(recipe.spec).match).toHaveLength(4);
    sqlite.close();
  });
});

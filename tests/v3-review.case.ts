import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { unlinkSync } from 'fs';

mock.module('$env/dynamic/private', () => ({ env: process.env }));
const dbPath = `/tmp/mailward-v3-review-${process.pid}-${Date.now()}.db`;
process.env.DATABASE_PATH = dbPath;
const mutations: string[] = [];
const labelChanges: { add: string[]; remove: string[] }[] = [];
let actionFailure: Error | null = null;
let liveIds = ['m1'];
let fullFetches = 0;
mock.module('../src/lib/server/gmail/client', () => ({
  async getGmailClient() { return { users: {
    threads: { async get() { return { data: { messages: liveIds.map((id) => ({ id, labelIds: ['INBOX','UNREAD'] })) } }; } },
    messages: {
      async list() { return { data: { messages: [{ id: 'm2', threadId: 't2' }] } }; },
      async get() { fullFetches++; return { data: { id: 'm2', labelIds: ['INBOX','UNREAD'], payload: { mimeType: 'text/plain', headers: [
        { name: 'From', value: 'sender@example.test' }, { name: 'To', value: 'a' }, { name: 'Subject', value: 'Read this' }, { name: 'Date', value: new Date().toUTCString() }
      ], body: { data: Buffer.from('Interesting research note').toString('base64url') } } } }; }
    }
  } }; }
}));
mock.module('../src/lib/server/gmail/thread-actions', () => ({
  async archiveThread(_a: string, id: string) { mutations.push(`archive:${id}`); },
  async trashThread(_a: string, id: string) { mutations.push(`trash:${id}`); },
  async labelThreadTodo(_a: string, id: string) { if (actionFailure) throw actionFailure; mutations.push(`todo:${id}`); return 'TODO'; },
  async untrashThread(_a: string, id: string) { mutations.push(`untrash:${id}`); },
  async modifyThreadLabels(_a: string, id: string, add: string[], remove: string[]) { mutations.push(`modify:${id}`); labelChanges.push({ add, remove }); }
}));
const { applyThreadAction, undoAction } = await import('../src/lib/server/gmail/execution');
const { submitReviewedSet, undoReviewedAction, ReviewError, startAssessment, listRun } = await import('../src/lib/server/v3/service');

function db() { return new Database(dbPath); }
beforeAll(() => {
  const sqlite = db(); migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });
  sqlite.query("INSERT INTO tokens (id,access_token,refresh_token,expires_at) VALUES ('a','x','y',1)").run();
  sqlite.query("INSERT INTO runs (id,account_id,started_at,scope,status) VALUES ('r','a',1,'v3','completed')").run();
  sqlite.query("INSERT INTO v3_policies (id,account_id,version_no,text,rubric_version,status,created_at) VALUES ('p','a',1,'policy',1,'proposed',1)").run();
  sqlite.query(`INSERT INTO threads (id,account_id,"from",from_domain,received_at,is_unread,label_ids,message_ids,synced_at)
    VALUES ('t','a','x','example.test',1,1,'["INBOX","UNREAD"]','["m1"]',1)`).run();
  const rep = JSON.stringify({ version: 1, threadId: 't', messageIds: ['m1'], omittedUnread: 0, unavailable: [], messages: [{ id: 'm1', body: 'hello', missingBody: false }] });
  for (const id of ['a1','a2']) {
    sqlite.query(`INSERT INTO v3_assessments (id,account_id,thread_id,input_key,policy_id,rubric_version,model,representation,proposed_action,final_action,lane,reason,priority,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,'a','t',id,'p',1,'model',rep,'archive','archive','cleanup','none',1,'ready',1);
    sqlite.query('INSERT INTO v3_run_items VALUES (?,?)').run('r',id);
  }
  sqlite.query(`INSERT INTO v3_assessments (id,account_id,thread_id,input_key,policy_id,rubric_version,model,representation,proposed_action,final_action,lane,reason,priority,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('a3','a','t','a3','p',1,'model',rep,'leave','trash','show_me','reminder',1,'ready',1);
  sqlite.query('INSERT INTO v3_run_items VALUES (?,?)').run('r','a3');
  sqlite.close();
});
afterAll(() => { try { unlinkSync(dbPath); } catch {} });

describe('v3 reviewed set', () => {
  test('an API gap stays unresolved, then a retry reuses full content and succeeds', async () => {
    process.env.OPENROUTER_API_KEY = 'fixture-key';
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      const options = (key: string[], selected: string) => ({ type: 'choice', choice: selected, confidence: 1, probabilities: Object.fromEntries(key.map((k) => [k, k === selected ? 1 : 0])) });
      const answers = calls === 1 ? {} : {
        t0_category: options(['sales','notification','newsletter','transaction','conversation','other'],'newsletter'),
        t0_attention: options(['act','read','glance','none','unclear'],'read'),
        t0_retention: options(['keep','disposable','unclear'],'keep'),
        t0_urgency: { type:'score',score:1,confidence:1,probabilities:{0:0,1:1,2:0,3:0} },
        t0_relevance: { type:'score',score:2,confidence:1,probabilities:{0:0,1:0,2:1,3:0} },
        t0_gap: options(['sufficient','more_body','conversation','attachment','user_context'],'sufficient')
      };
      return new Response(JSON.stringify({ model:'jev-fixture', answers, usage:{ input_tokens:100, output_tokens:10 } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      async function run() {
        const id = await startAssessment('a', 10);
        for (let i = 0; i < 100; i++) {
          const result = listRun('a', id);
          if (result.run?.status !== 'running') return result;
          await Bun.sleep(5);
        }
        throw new Error('assessment did not finish');
      }
      const failed = await run();
      expect(failed.run.status).toBe('completed');
      expect(failed.items[0].status).toBe('unresolved');
      const recovered = await run();
      expect(recovered.items[0].lane).toBe('worth_reading');
      expect(recovered.items[0].actual_model).toBe('jev-fixture');
      expect(calls).toBe(2);
      expect(fullFetches).toBe(1);
    } finally { globalThis.fetch = originalFetch; delete process.env.OPENROUTER_API_KEY; }
  });
  test('rejects stale and duplicate decisions before Gmail mutation', async () => {
    liveIds = ['m1','m2'];
    await expect(submitReviewedSet('a','r',[
      { assessmentId:'a1', kind:'approve', disposition:'archive' }, { assessmentId:'a2', kind:'skip', disposition:'leave' }
    ])).rejects.toMatchObject({ statusCode: 409, stale: ['a1','a2'] });
    expect(mutations).toHaveLength(0);
    liveIds = ['m1'];
    await expect(submitReviewedSet('a','r',[
      { assessmentId:'a1', kind:'approve', disposition:'archive' }, { assessmentId:'a1', kind:'approve', disposition:'archive' }
    ])).rejects.toBeInstanceOf(ReviewError);
  });
  test('records completion separately, applies once, and undoes from ledger', async () => {
    const results = await submitReviewedSet('a','r',[{ assessmentId:'a1', kind:'done', disposition:'leave', finalDisposition:'archive', chip:'already_handled' }]);
    expect(results[0].status).toBe('applied');
    expect(mutations).toEqual(['archive:t']);
    const sqlite = db();
    const review = sqlite.query("SELECT kind, chip, action_id, execution_status FROM v3_reviews WHERE assessment_id = 'a1'").get() as any;
    expect(review.kind).toBe('done'); expect(review.chip).toBe('already_handled');
    expect((sqlite.query('SELECT status FROM actions WHERE id = ?').get(review.action_id) as any).status).toBe('applied');
    sqlite.close();
    const undone = await undoReviewedAction('a', review.action_id);
    expect(undone.status).toBe('applied');
    expect(mutations).toEqual(['archive:t','modify:t']);
    await expect(submitReviewedSet('a','r',[{ assessmentId:'a1', kind:'approve', disposition:'archive' }])).rejects.toBeInstanceOf(ReviewError);
  });
  test('skip is a review outcome without a fake action', async () => {
    const results = await submitReviewedSet('a','r',[{ assessmentId:'a2', kind:'skip', disposition:'leave' }]);
    expect(results[0].status).toBe('no_action');
    const sqlite = db();
    expect((sqlite.query("SELECT action_id FROM v3_reviews WHERE assessment_id = 'a2'").get() as any).action_id).toBeNull();
    sqlite.close();
  });
  test('show-before-clearing approves its final handling only once seen', async () => {
    await expect(submitReviewedSet('a','r',[{ assessmentId:'a3', kind:'approve', disposition:'trash' }])).rejects.toBeInstanceOf(ReviewError);
    const results = await submitReviewedSet('a','r',[{ assessmentId:'a3', kind:'approve', disposition:'trash', acknowledged: true }]);
    expect(results[0].status).toBe('applied');
    expect(mutations.at(-1)).toBe('trash:t');
    const sqlite = db();
    expect((sqlite.query("SELECT kind, acknowledged FROM v3_reviews WHERE assessment_id = 'a3'").get() as any)).toEqual({ kind: 'approve', acknowledged: 1 });
    const receipt = sqlite.query("SELECT action_id FROM v3_reviews WHERE assessment_id = 'a3'").get() as { action_id: string };
    sqlite.close();
    await undoReviewedAction('a', receipt.action_id);
    expect(mutations.slice(-2)).toEqual(['untrash:t', 'modify:t']);
    expect(labelChanges.at(-1)).toEqual({ add: ['INBOX'], remove: [] });
  });
  test('shared executor keeps TODO unread, scopes undo to the account, and restores labels', async () => {
    const result = await applyThreadAction({ accountId: 'a', runId: 'r', threadId: 't', action: 'label_todo', verdict: 'approve' });
    expect(result.status).toBe('applied');
    const sqlite = db();
    const thread = sqlite.query("SELECT is_unread, label_ids FROM threads WHERE id = 't'").get() as any;
    expect(thread.is_unread).toBe(1);
    expect(JSON.parse(thread.label_ids)).toContain('TODO');
    const receipt = sqlite.query('SELECT mode, rule_id, rule_version_id, prior_state FROM actions WHERE id = ?').get(result.actionId!) as any;
    expect(receipt.mode).toBe('manual');
    expect(receipt.rule_id).toBeNull(); expect(receipt.rule_version_id).toBeNull();
    expect(JSON.parse(receipt.prior_state).addedLabelId).toBe('TODO');
    const before = mutations.length;
    expect((await undoAction('other-account', result.actionId!)).status).toBe('failed');
    expect(mutations.length).toBe(before);
    expect((await undoAction('a', result.actionId!)).status).toBe('applied');
    expect(labelChanges.at(-1)).toEqual({ add: [], remove: ['TODO'] });
    expect(JSON.parse((sqlite.query("SELECT label_ids FROM threads WHERE id = 't'").get() as any).label_ids)).toEqual(['INBOX', 'UNREAD']);
    sqlite.close();
  });
  test('shared executor logs Gmail failure and propagates reauth without an action', async () => {
    const sqlite = db();
    const count = () => (sqlite.query('SELECT count(*) AS n FROM actions').get() as { n: number }).n;
    try {
      actionFailure = new Error('Gmail unavailable');
      const failed = await applyThreadAction({ accountId: 'a', runId: 'r', threadId: 't', action: 'label_todo', verdict: 'approve' });
      expect(failed.status).toBe('failed');
      expect((sqlite.query('SELECT status, error FROM actions WHERE id = ?').get(failed.actionId!) as any)).toEqual({ status: 'failed', error: 'Gmail unavailable' });
      const before = count();
      actionFailure = Object.assign(new Error('Reauthorize'), { code: 'reauth_required' });
      await expect(applyThreadAction({ accountId: 'a', runId: 'r', threadId: 't', action: 'label_todo', verdict: 'approve' })).rejects.toMatchObject({ code: 'reauth_required' });
      expect(count()).toBe(before);
    } finally { actionFailure = null; sqlite.close(); }
  });
});

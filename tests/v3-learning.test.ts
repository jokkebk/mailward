import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { mkdtempSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { weeklyPacket, learningCase } from '../src/lib/server/v3/learning';
import { getOrCreatePolicy, createPolicyRevision } from '../src/lib/server/v3/policy';

function fixture(path = ':memory:') {
  const db = new Database(path, { create: true });
  migrate(drizzle(db),{ migrationsFolder:'drizzle' });
  db.query("INSERT INTO tokens (id,access_token,refresh_token,expires_at) VALUES ('a','fixture','fixture',1)").run();
  db.query("INSERT INTO runs (id,account_id,started_at,scope,status) VALUES ('r','a',100,'v3','completed')").run();
  return db;
}

describe('v3 weekly learning', () => {
  test('agreement excludes completions, skips and unresolved, and isolates policy/source cohorts', () => {
    const db = fixture();
    const p1 = getOrCreatePolicy(db,'a');
    const p2 = createPolicyRevision(db,'a',p1.text + ' Preserve explicitly requested personal records.','test','new preference');
    function review(id: string, policyId: string, kind: string, disposition: string, opts: { lane?: string; status?: string; source?: string; execution?: string; date?: number } = {}) {
      const rep = JSON.stringify({ version:3,threadId:id,messageIds:[id],omittedUnread:0,unavailable:[],messages:[{from:'sender@example.test',subject:id,body:'Exact evidence for '+id}] });
      db.query(`INSERT INTO v3_assessments (id,account_id,thread_id,input_key,policy_id,rubric_version,model,representation,proposed_action,final_action,lane,reason,priority,status,assessment_source,created_at)
        VALUES (?,'a',?,?,?,2,'model',?,?,?,?,'reason',1,?,?,100)`).run(id,id,id,policyId,rep,opts.lane === 'show_me' ? 'leave' : 'archive',opts.lane === 'show_me' ? 'trash' : 'archive',opts.lane??'cleanup',opts.status??'ready',opts.source??'jev');
      db.query(`INSERT INTO v3_reviews (id,account_id,assessment_id,run_id,actor,kind,disposition,execution_status,created_at)
        VALUES (?,'a',?,'r','human',?,?,?,?)`).run('review-'+id,id,kind,disposition,opts.execution??'no_action',opts.date??100);
    }
    review('match',p1.id,'approve','archive');
    review('miss',p1.id,'correct','label_todo',{execution:'undone'});
    review('glance',p1.id,'approve','trash',{lane:'show_me'});
    review('done',p1.id,'done','leave');
    review('skip',p1.id,'skip','leave');
    review('unclear',p1.id,'correct','archive',{status:'unresolved'});
    review('rule',p1.id,'correct','trash',{source:'rule'});
    review('new',p2.id,'approve','archive',{execution:'failed'});
    review('old',p1.id,'correct','trash',{date:1});
    db.query("INSERT INTO runs (id,account_id,started_at,scope,status) VALUES ('r2','a',100,'v3','completed')").run();
    db.query("INSERT INTO v3_run_items VALUES ('r','match'),('r2','match')").run();
    const packet = weeklyPacket(db,'a',50,2);
    expect(packet.currentPolicy?.id).toBe(p2.id);
    expect(packet.cohorts).toHaveLength(3);
    const c = packet.cohorts.find((c)=>c.policyId===p1.id && c.source==='jev')!;
    expect(c.comparable).toBe(3); expect(c.matched).toBe(2); expect(c.agreementPct).toBe(66.7);
    expect(c.matrix).toEqual({'archive → archive':1,'archive → label_todo':1,'trash → trash':1});
    expect(c.completed).toBe(1); expect(c.skipped).toBe(1); expect(c.unresolved).toBe(1); expect(c.undone).toBe(1);
    expect(packet.cases).toHaveLength(2); expect(packet.omittedCases).toBe(6);
    expect(packet.cases.every((r)=>r.kind==='correct' || r.execution==='failed')).toBe(true);
    expect(packet.cohorts.find((c)=>c.policyId===p2.id)?.failed).toBe(1);
    expect(learningCase(db,'a','miss').representation.messages[0].body).toBe('Exact evidence for miss');
    expect(()=>learningCase(db,'other-account','miss')).toThrow('not found');
    const empty = weeklyPacket(db,'a',200);
    expect(empty.cohorts).toHaveLength(0); expect(empty.currentPolicy?.id).toBe(p2.id);
    db.close();
  });
  test('policy helper dry-run writes nothing, applies once, and refuses stale revisions', () => {
    const dir = mkdtempSync(join(tmpdir(),'mailward-policy-'));
    const path = join(dir,'fixture.db'); const proposal = join(dir,'proposal.json');
    const db = fixture(path);
    try {
      const p = getOrCreatePolicy(db,'a');
      const text = p.text + '\nRetain user-requested research references for future work.';
      writeFileSync(proposal,JSON.stringify({accountId:'a',expectedPolicyId:p.id,text,note:'test correction'}));
      const invoke = (apply=false) => Bun.spawnSync(['bun','run','scripts/v3-policy.ts',proposal,...(apply?['--apply']:[])],{env:{...process.env,DATABASE_PATH:path},stdout:'pipe',stderr:'pipe'});
      const dry = invoke(); expect(dry.exitCode,Buffer.from(dry.stderr).toString()).toBe(0);
      expect(JSON.parse(Buffer.from(dry.stdout).toString()).applied).toBe(false);
      expect(getOrCreatePolicy(db,'a').id).toBe(p.id);
      const applied = invoke(true); expect(applied.exitCode,Buffer.from(applied.stderr).toString()).toBe(0);
      const result = JSON.parse(Buffer.from(applied.stdout).toString());
      expect(result.nextVersion).toBe(2); expect(result.gmailActions).toBe(0);
      expect(getOrCreatePolicy(db,'a').text).toBe(text);
      const stale = invoke(true); expect(stale.exitCode).not.toBe(0);
      expect(Buffer.from(stale.stderr).toString()).toContain('Policy changed');
      expect((db.query('SELECT COUNT(*) n FROM v3_policies').get() as any).n).toBe(2);
      const original = JSON.parse(readFileSync(proposal,'utf8'));
      writeFileSync(proposal,JSON.stringify({...original,expectedPolicyId:result.policyId,text:'Too short'}));
      expect(invoke(true).exitCode).not.toBe(0);
      expect((db.query('SELECT COUNT(*) n FROM v3_policies').get() as any).n).toBe(2);
      expect((db.query('SELECT COUNT(*) n FROM actions').get() as any).n).toBe(0);
    } finally {
      db.close(); unlinkSync(path); unlinkSync(proposal); rmdirSync(dir);
    }
  });
});

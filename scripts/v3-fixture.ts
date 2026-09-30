/** Safe local preview data. Never uses Gmail or the live database. */
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { prepareThread } from '../src/lib/server/v3/representation';
import { resolveHandling, V3_MODEL } from '../src/lib/server/v3/assessment';
import type { Assessment, Attention, Retention } from '../src/lib/types/v3';

const path = process.argv[2] || '/tmp/mailward-v3-fixture.db';
const sqlite = new Database(path, { create: true });
migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });
const account = 'fixture@example.test';
sqlite.query('INSERT OR IGNORE INTO tokens (id,access_token,refresh_token,expires_at) VALUES (?,?,?,?)').run(account,'fixture','fixture',Date.now()+86400000);
const runId = crypto.randomUUID();
sqlite.query('INSERT INTO runs (id,account_id,started_at,ended_at,scope,status) VALUES (?,?,?,?,?,?)').run(runId,account,Date.now(),Date.now(),'v3','completed');
const policyId = crypto.randomUUID();
sqlite.query('INSERT INTO v3_policies (id,account_id,version_no,text,rubric_version,status,import_report,created_at) VALUES (?,?,?,?,?,?,?,?)').run(policyId,account,1,'Fixture policy',1,'proposed',JSON.stringify({ source: 'safe synthetic fixture', automationInherited: false }),Date.now());
const answer = (choice: string) => ({ type: 'choice' as const, choice, confidence: .92, probabilities: { [choice]: 1 } });
const score = (n: number) => ({ type: 'score' as const, score: n, confidence: .9, probabilities: { [String(n)]: 1 } });
const examples: [string,string,string,Attention,Retention,number,number][] = [
  ['A customer question','Could you send the proposal by Friday?','customer@sample.test','act','keep',3,3],
  ['An AI product release','New research tools are available. Read about the workflow.','news@sample.test','read','disposable',1,3],
  ['Receipt from supplier','Payment receipt attached for accounting.','billing@sample.test','act','keep',2,2],
  ['Service digest','Weekly uptime summary. All systems healthy.','service@sample.test','none','disposable',0,0],
  ['Archive this reference','Your account reference for next quarter.','accounts@sample.test','none','keep',0,1],
  ['Approval reminder','Please check the pending request.','hr@sample.test','glance','disposable',1,1],
  ['Unclear attachment','See attached document.','person@sample.test','unclear','unclear',1,1]
];
for (const [subject, body, from, attention, retention, urgency, relevance] of examples) {
  const id = crypto.randomUUID(); const mid = crypto.randomUUID();
  const message = { id: mid, labelIds: ['INBOX','UNREAD'], payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: from }, { name: 'To', value: account }, { name: 'Subject', value: subject }, { name: 'Date', value: new Date().toUTCString() }
  ], body: { data: Buffer.from(body).toString('base64url') } } };
  const rep = prepareThread(id,[mid],new Map([[mid,message]]));
  const assessment: Assessment = { category: answer('other') as any, attention: answer(attention) as any, retention: answer(retention) as any,
    urgency: score(urgency) as any, relevance: score(relevance) as any, gap: answer('sufficient') as any };
  const handling = resolveHandling(assessment,rep);
  sqlite.query(`INSERT INTO threads (id,account_id,"from",from_domain,"to",subject,snippet,received_at,is_unread,label_ids,message_ids,synced_at)
    VALUES (?,?,?,?,?,?,?,?,1,?,?,?)`).run(id,account,from,'sample.test',account,subject,body,Date.now(),JSON.stringify(['INBOX','UNREAD']),JSON.stringify([mid]),Date.now());
  const aid = crypto.randomUUID();
  sqlite.query(`INSERT INTO v3_assessments (id,account_id,thread_id,input_key,policy_id,rubric_version,model,actual_model,representation,answers,proposed_action,final_action,lane,reason,priority,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(aid,account,id,mid,policyId,1,V3_MODEL,V3_MODEL,JSON.stringify(rep),JSON.stringify(assessment),handling.action,handling.finalAction,handling.lane,handling.reason,handling.priority,handling.status,Date.now());
  sqlite.query('INSERT INTO v3_run_items VALUES (?,?)').run(runId,aid);
}
sqlite.close();
console.log(`Fixture ready at ${path}`);

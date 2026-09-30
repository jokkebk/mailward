/** Publish an already evaluated inbox snapshot as a NEW review-only run.
 * No Gmail client or action-execution module is imported. Keeps old results.
 * bun run scripts/v3-publish-replay.ts database.db evaluated-results.json
 */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { getOrCreatePolicy, createPolicyRevision, AUDIT_POLICY } from '../src/lib/server/v3/policy';
import { resolveHandling, RUBRIC_VERSION, V3_MODEL, parseAssessment } from '../src/lib/server/v3/assessment';
import { REPRESENTATION_VERSION } from '../src/lib/server/v3/representation';

const [dbPath, resultPath] = process.argv.slice(2);
if (!dbPath || !resultPath) throw new Error('Usage: v3-publish-replay.ts database.db evaluated-results.json');
const result = JSON.parse(readFileSync(resultPath, 'utf8'));
if (result.policy !== AUDIT_POLICY || result.summary.rubricVersion !== RUBRIC_VERSION) throw new Error('Evaluation must use the current policy and rubric');
const db = new Database(dbPath); db.exec('PRAGMA foreign_keys=ON');
try {
  const source = db.query("SELECT * FROM runs WHERE id=? AND scope='v3' AND status='completed'").get(result.summary.runId) as any;
  if (!source || result.assessmentTime !== new Date(source.started_at).toISOString()) throw new Error('Missing or mismatched source run');
  const prior = db.query('SELECT a.id,a.policy_id,a.thread_id,a.representation FROM v3_run_items i JOIN v3_assessments a ON i.assessment_id=a.id WHERE i.run_id=?').all(source.id) as any[];
  if (prior.length !== result.rows.length || new Set(result.rows.map((r:any)=>r.threadId)).size !== prior.length) throw new Error('Evaluation coverage changed');
  if (db.query('SELECT id FROM v3_reviews WHERE run_id=? LIMIT 1').get(source.id)) throw new Error('Original review already has decisions; do not replace its active review');
  const duplicate = db.query('SELECT id FROM run_steps WHERE stage=? LIMIT 1').get(`v3_replay:${source.id}`);
  if (duplicate) throw new Error('A replay has already been published for this source');
  const active = db.query("SELECT id FROM runs WHERE account_id=? AND status='running' AND CASE WHEN started_at>100000000000 THEN started_at ELSE started_at*1000 END > ? LIMIT 1").get(source.account_id, Date.now()-1800000);
  if(active) throw new Error('An inbox assessment is active');
  const currentPolicy = getOrCreatePolicy(db, source.account_id);
  if (currentPolicy.id !== prior[0].policy_id && currentPolicy.text !== AUDIT_POLICY) throw new Error('Preferences changed since the evaluated run');
  for (const row of result.rows) {
    const old = prior.find((a)=>a.thread_id===row.threadId);
    const live = db.query('SELECT message_ids FROM threads WHERE id=? AND account_id=?').get(row.threadId,source.account_id) as any;
    if (!old || !live || row.rep.version!==REPRESENTATION_VERSION || JSON.stringify(row.rep.messageIds)!==live.message_ids || JSON.stringify(row.rep.messageIds)!==JSON.stringify(JSON.parse(old.representation).messageIds)) throw new Error('Message snapshot changed; assess again');
    const answers = Object.fromEntries(Object.entries(row.candidate.answers).map(([key,value])=>[`t0_${key}`,value]));
    parseAssessment(answers,0);
  }
  const runId=crypto.randomUUID(), now=Date.now();
  db.transaction(()=>{
    const policy=currentPolicy.text===AUDIT_POLICY ? currentPolicy : createPolicyRevision(db,source.account_id,AUDIT_POLICY,'quality-audit','Correct ownership exceptions, reminder handling and calendar semantics; evaluated on the original 49-thread inbox snapshot. Review-only.');
    db.query("INSERT INTO runs(id,account_id,started_at,ended_at,scope,status) VALUES(?,?,?,?,'v3','completed')").run(runId,source.account_id,now,now);
    for(const row of result.rows){
      const handling=resolveHandling(row.candidate.answers,row.rep), id=crypto.randomUUID();
      const key=createHash('sha256').update(JSON.stringify({rep:row.rep,replayedAt:result.assessmentTime,sourceRunId:source.id})).digest('hex');
      db.query('INSERT INTO v3_assessments(id,account_id,thread_id,input_key,policy_id,rubric_version,model,actual_model,representation,answers,proposed_action,final_action,lane,reason,priority,status,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,source.account_id,row.threadId,key,policy.id,RUBRIC_VERSION,V3_MODEL,result.calls[0]?.model??V3_MODEL,JSON.stringify(row.rep),JSON.stringify(row.candidate.answers),handling.action,handling.finalAction,handling.lane,handling.reason,handling.priority,handling.status,now);
      db.query('INSERT INTO v3_run_items(run_id,assessment_id) VALUES(?,?)').run(runId,id);
    }
    for(const call of result.calls) db.query('INSERT INTO v3_call_logs VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),runId,source.account_id,call.model,1,call.promptChars,call.usage.input_tokens??null,call.usage.output_tokens??null,call.durationMs,'completed',null,now);
    db.query("INSERT INTO run_steps(id,run_id,account_id,stage,status,total,duration_ms,started_at,updated_at,ended_at) VALUES(?,?,?,?,'completed',?,0,?,?,?)").run(crypto.randomUUID(),runId,source.account_id,`v3_replay:${source.id}`,result.rows.length,source.started_at,now,now);
  })();
  console.log(JSON.stringify({runId,sourceRunId:source.id,threads:result.rows.length,policyVersion:(getOrCreatePolicy(db,source.account_id)).version_no,gmailActions:0}));
} finally { db.close(); }

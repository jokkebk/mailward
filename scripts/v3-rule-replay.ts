/** Re-evaluate deterministic matches on captured mail. Reuse other verdicts.
 * No Gmail access, no model calls, no actions. Preserves the previous run.
 * bun run scripts/v3-rule-replay.ts database.db captured-corpus.json
 */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { prepareThread } from '../src/lib/server/v3/representation';
import { deterministicHandling, saveDeterministicAssessment } from '../src/lib/server/v3/deterministic';
import { RUBRIC_VERSION } from '../src/lib/server/v3/assessment';

const [path,corpusPath]=process.argv.slice(2);
if(!path||!corpusPath)throw new Error('Usage: v3-rule-replay.ts database.db corpus.json');
const db=new Database(path);migrate(drizzle(db),{migrationsFolder:'drizzle'});
try{
  const corpus=JSON.parse(readFileSync(corpusPath,'utf8'));
  const original=db.query('SELECT account_id FROM runs WHERE id=?').get(corpus.runId) as any;
  if(!original)throw new Error('Corpus source run missing');
  const source=db.query("SELECT * FROM runs WHERE account_id=? AND scope='v3' AND status='completed' ORDER BY started_at DESC LIMIT 1").get(original.account_id) as any;
  if(db.query('SELECT id FROM v3_reviews WHERE run_id=? LIMIT 1').get(source.id))throw new Error('Current run has decisions; assess again instead');
  if(db.query('SELECT id FROM v3_assessments a JOIN v3_run_items i ON i.assessment_id=a.id WHERE i.run_id=? AND a.assessment_source=\'rule\' LIMIT 1').get(source.id))throw new Error('Rules already applied to current review');
  const rows=db.query('SELECT a.* FROM v3_assessments a JOIN v3_run_items i ON a.id=i.assessment_id WHERE i.run_id=?').all(source.id) as any[];
  const messages=new Map<string,any>(corpus.messages.map((m:any)=>[m.id,m]));
  const prepared=rows.map((row)=>{
    const old=JSON.parse(row.representation), live=db.query('SELECT message_ids FROM threads WHERE account_id=? AND id=?').get(source.account_id,row.thread_id) as any;
    if(!live||JSON.stringify(old.messageIds)!==live.message_ids||old.omittedUnread)throw new Error('Message snapshot changed');
    const rep=prepareThread(row.thread_id,old.messageIds,messages);
    if(rep.unavailable.length)throw new Error('Corpus incomplete');
    return {row,rep,rule:deterministicHandling(rep)};
  });
  const id=crypto.randomUUID(),now=Date.now();
  db.transaction(()=>{
    db.query("INSERT INTO runs(id,account_id,started_at,ended_at,scope,status) VALUES(?,?,?,?,'v3','completed')").run(id,source.account_id,now,now);
    for(const {row,rep,rule} of prepared){
      if(rule)saveDeterministicAssessment(db,source.account_id,id,row.policy_id,RUBRIC_VERSION,rep,createHash('sha256').update(JSON.stringify(rep)).digest('hex'));
      else db.query('INSERT INTO v3_run_items(run_id,assessment_id) VALUES(?,?)').run(id,row.id);
    }
    db.query("INSERT INTO run_steps(id,run_id,account_id,stage,status,total,duration_ms,started_at,updated_at,ended_at) VALUES(?,?,?,?,'completed',?,0,?,?,?)").run(crypto.randomUUID(),id,source.account_id,`v3_replay:${corpus.runId}`,rows.length,Date.parse(corpus.assessmentTime),now,now);
  })();
  console.log(JSON.stringify({runId:id,ruleVerdicts:prepared.filter(r=>r.rule).length,reusedJevVerdicts:prepared.filter(r=>!r.rule).length,gmailActions:0}));
}finally{db.close();}

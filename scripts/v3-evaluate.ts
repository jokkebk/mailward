/** Read-only comparison of v2 history and v3, on an explicit database snapshot.
 * capture: Gmail GETs only; saves the original assessment's message IDs.
 * replay: no Gmail access; Jev evaluates the captured mail at the original run time.
 * Output contains private mail. Keep corpus/results outside Git.
 * bun run scripts/v3-evaluate.ts capture /tmp/snapshot.db /tmp/corpus.json
 * bun run scripts/v3-evaluate.ts replay /tmp/snapshot.db /tmp/corpus.json /tmp/results.json
 */
import { Database } from 'bun:sqlite';
import { google } from 'googleapis';
import { writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { prepareThread } from '../src/lib/server/v3/representation';
import { callJev, resolveHandling, RUBRIC_VERSION } from '../src/lib/server/v3/assessment';
import { AUDIT_POLICY } from './lib/v3-audit-policy';
import type { Representation } from '../src/lib/types/v3';

const [mode, dbPath, corpusPath, resultPath] = process.argv.slice(2);
if (!['capture','replay'].includes(mode) || !dbPath || !corpusPath || (mode === 'replay' && !resultPath)) throw new Error('Usage: capture snapshot.db corpus.json | replay snapshot.db corpus.json results.json');
const livePath = realpathSync(process.env.DATABASE_PATH || './data/emails.db');
if (realpathSync(dbPath) === livePath || resolve(dbPath) === resolve('./data/emails.db')) throw new Error('Use a database snapshot, never the live database.');
const db = new Database(dbPath, { readonly: true });
const run = db.query("SELECT * FROM runs WHERE scope='v3' AND status='completed' ORDER BY started_at DESC LIMIT 1").get() as any;
if (!run) throw new Error('No completed v3 run');
const original = db.query('SELECT a.* FROM v3_assessments a JOIN v3_run_items i ON i.assessment_id=a.id WHERE i.run_id=? ORDER BY a.created_at,a.id').all(run.id) as any[];
const save = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 });
if (mode === 'capture') {
  const token = db.query('SELECT access_token,refresh_token,expires_at FROM tokens WHERE id=?').get(run.account_id) as any;
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID,process.env.GOOGLE_CLIENT_SECRET,process.env.GOOGLE_REDIRECT_URI);
  auth.setCredentials({access_token:token.access_token,refresh_token:token.refresh_token,expiry_date:token.expires_at*1000});
  const gmail = google.gmail({version:'v1',auth});
  const ids = [...new Set(original.flatMap((r) => (JSON.parse(r.representation) as Representation).messageIds))];
  const fetched: any[] = []; let next = 0;
  await Promise.all(Array.from({length:4},async () => { while(next<ids.length) { const id=ids[next++]; const response=await gmail.users.messages.get({userId:'me',id,format:'full'}); fetched.push(response.data); } }));
  save(corpusPath,{runId:run.id,assessmentTime:new Date(run.started_at).toISOString(),messages:fetched});
  console.log(JSON.stringify({capturedMessages:fetched.length,threads:original.length,runId:run.id}));
} else {
  const corpus=JSON.parse(readFileSync(corpusPath,'utf8'));
  if(corpus.runId!==run.id) throw new Error('Corpus must match snapshot run');
  const fetched=new Map<string,any>(corpus.messages.map((m:any)=>[m.id,m]));
  const rows=original.map((r)=>{
    const previous=JSON.parse(r.representation) as Representation;
    const rep=prepareThread(r.thread_id, [...previous.messageIds,...Array.from({length:previous.omittedUnread},(_,i)=>`unavailable-${i}`)],fetched);
    const baseline=db.query(`SELECT p.action,p.status,p.created_at,r.name, p.message_ids FROM proposals p JOIN rules r ON p.rule_id=r.id WHERE p.account_id=? AND p.thread_id=? AND p.created_at<=? ORDER BY p.created_at DESC LIMIT 1`).get(run.account_id,r.thread_id,Math.floor(run.started_at/1000)) as any;
    const leave=db.query(`SELECT a.action,r.name FROM ai_classifications a JOIN rules r ON r.id=a.rule_id WHERE a.account_id=? AND a.thread_id=? ORDER BY a.created_at DESC LIMIT 1`).get(run.account_id,r.thread_id);
    return {threadId:r.thread_id,subject:rep.messages[0]?.subject,baseline:baseline??leave??null,original:{lane:r.lane,action:r.proposed_action,finalAction:r.final_action,reason:r.reason,answers:JSON.parse(r.answers)},rep,candidate:null as any};
  });
  const batches = rows.map((row) => [row]);
  const calls:any[]=[];let next=0;
  await Promise.all(Array.from({length:3},async()=>{while(next<batches.length){const index=next++;const batch=batches[index];const result=await callJev(batch.map(r=>r.rep),AUDIT_POLICY,fetch,corpus.assessmentTime);batch.forEach((row,i)=>{const a=result.assessments[i];if(a instanceof Error)throw a;row.candidate={...resolveHandling(a,row.rep),answers:a};});calls.push({batch:index,model:result.model,usage:result.usage,durationMs:result.durationMs,promptChars:result.promptChars});console.log(`Evaluated batch ${index+1}/${batches.length}`);}}));
  const count=(field:'original'|'candidate')=>Object.fromEntries(['needs_action','worth_reading','show_me','decision','cleanup'].map(lane=>[lane,rows.filter(r=>r[field].lane===lane).length]));
  const summary={runId:run.id,rubricVersion:RUBRIC_VERSION,threads:rows.length,original:count('original'),candidate:count('candidate'),baselineAgreement:rows.filter(r=>r.baseline?.action===r.candidate.action).length,originalAgreement:rows.filter(r=>r.baseline?.action===r.original.action).length,calls:calls.length,inputTokens:calls.reduce((n,c)=>n+(c.usage.input_tokens??0),0),costUsd:calls.reduce((n,c)=>n+(c.usage.cost??0),0)};
  save(resultPath,{summary,policy:AUDIT_POLICY,assessmentTime:corpus.assessmentTime,calls,rows});console.log(JSON.stringify(summary,null,2));
}
db.close();

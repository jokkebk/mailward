import type { Database } from 'bun:sqlite';
import type { Representation } from '$lib/types/v3';
import type { HandlingResult } from './assessment';

export const CALENDAR_RESPONSE_RULE = { key: 'calendar-rsvp', version: 1, name: 'Bare calendar responses', modelKey: 'deterministic/calendar-rsvp/v1' };

/** A semantic template match, never a sender/subject-only trash rule. */
export function deterministicHandling(rep: Representation): HandlingResult | null {
  if (!rep.messages.length || rep.unavailable.length || rep.omittedUnread) return null;
  if (!rep.messages.every((m) => m.calendar?.responseOnly === true && !m.calendar.note && !m.missingBody && !m.clipped && !m.attachmentsNotRead)) return null;
  return { action:'trash', finalAction:'trash', lane:'cleanup', reason:'Bare calendar response · no human note', priority:0, status:'ready' };
}

export function saveDeterministicAssessment(db: Database, accountId: string, runId: string, policyId: string, rubricVersion: number, rep: Representation, inputKey: string): string {
  const rule=CALENDAR_RESPONSE_RULE, result=deterministicHandling(rep);
  if(!result) throw new Error('Thread does not match the calendar response rule');
  const cached=db.query("SELECT id FROM v3_assessments WHERE account_id=? AND thread_id=? AND input_key=? AND policy_id=? AND model=? AND assessment_source='rule' AND deterministic_version=? ORDER BY created_at DESC LIMIT 1").get(accountId,rep.threadId,inputKey,policyId,rule.modelKey,rule.version) as {id:string}|null;
  const id=cached?.id??crypto.randomUUID();
  if(!cached) db.query(`INSERT INTO v3_assessments(id,account_id,thread_id,input_key,policy_id,rubric_version,model,representation,proposed_action,final_action,lane,reason,priority,status,assessment_source,deterministic_rule,deterministic_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'rule',?,?,?)`).run(id,accountId,rep.threadId,inputKey,policyId,rubricVersion,rule.modelKey,JSON.stringify(rep),result.action,result.finalAction,result.lane,result.reason,result.priority,result.status,rule.key,rule.version,Date.now());
  db.query('INSERT OR IGNORE INTO v3_run_items(run_id,assessment_id) VALUES(?,?)').run(runId,id);
  return id;
}

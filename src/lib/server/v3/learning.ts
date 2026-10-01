import type { Database } from 'bun:sqlite';
import type { Assessment, Handling, Representation } from '$lib/types/v3';

interface ReviewRow {
  assessment_id: string; policy_id: string; version_no: number; rubric_version: number;
  model: string; actual_model: string | null; assessment_source: string;
  deterministic_rule: string | null; deterministic_version: number | null;
  representation: string; answers: string | null; lane: string; status: string;
  proposed_action: Handling; final_action: Handling; reason: string;
  kind: string; disposition: Handling; final_disposition: Handling | null;
  chip: string | null; note: string | null; actor: string; created_at: number;
  execution_status: string; action_status: string | null; error: string | null;
}
interface Cohort {
  policyId: string; policyVersion: number; rubricVersion: number; model: string;
  actualModel: string | null; source: string; rule: string | null; ruleVersion: number | null;
  reviewed: number; comparable: number; matched: number; agreementPct: number | null;
  skipped: number; completed: number; unresolved: number; undone: number; failed: number;
  matrix: Record<string, number>;
}

/** Review-time window; each persisted review is counted once, regardless of run reuse. */
export function weeklyPacket(db: Database, accountId: string, since: number, limit = 30) {
  const policies = db.query('SELECT id,version_no,text,rubric_version,status,created_by,created_at,import_report FROM v3_policies WHERE account_id=? ORDER BY version_no DESC').all(accountId) as { id: string; version_no: number; text: string; rubric_version: number; status: string; created_by: string; created_at: number; import_report: string | null }[];
  const rows = db.query(`SELECT r.assessment_id,r.kind,r.disposition,r.final_disposition,r.chip,r.note,r.actor,r.created_at,
    r.execution_status,r.error,x.status AS action_status,a.policy_id,p.version_no,a.rubric_version,a.model,a.actual_model,
    a.assessment_source,a.deterministic_rule,a.deterministic_version,a.representation,a.answers,a.lane,a.status,
    a.proposed_action,a.final_action,a.reason FROM v3_reviews r
    JOIN v3_assessments a ON a.id=r.assessment_id AND a.account_id=r.account_id
    JOIN v3_policies p ON p.id=a.policy_id
    LEFT JOIN actions x ON x.id=r.action_id AND x.account_id=r.account_id
    WHERE r.account_id=? AND r.created_at>=? ORDER BY r.created_at DESC,r.id`).all(accountId, since) as ReviewRow[];
  const cohorts = new Map<string, Cohort>();
  for (const row of rows) {
    const key = JSON.stringify([row.policy_id,row.rubric_version,row.model,row.actual_model,row.assessment_source,row.deterministic_rule,row.deterministic_version]);
    let cohort = cohorts.get(key);
    if (!cohort) {
      cohort = { policyId: row.policy_id, policyVersion: row.version_no, rubricVersion: row.rubric_version, model: row.model,
        actualModel: row.actual_model, source: row.assessment_source, rule: row.deterministic_rule, ruleVersion: row.deterministic_version,
        reviewed: 0, comparable: 0, matched: 0, agreementPct: null, skipped: 0, completed: 0, unresolved: 0, undone: 0, failed: 0, matrix: {} };
      cohorts.set(key, cohort);
    }
    cohort.reviewed++;
    if (row.kind === 'skip') cohort.skipped++;
    if (row.kind === 'done') cohort.completed++;
    if (row.status !== 'ready') cohort.unresolved++;
    if (row.execution_status === 'undone' || row.action_status === 'rolled_back') cohort.undone++;
    if (row.execution_status === 'failed' || row.action_status === 'failed') cohort.failed++;
    if (row.status === 'ready' && (row.kind === 'approve' || row.kind === 'correct')) {
      const suggestion = row.lane === 'show_me' ? row.final_action : row.proposed_action;
      cohort.comparable++;
      if (suggestion === row.disposition) cohort.matched++;
      const transition = `${suggestion} → ${row.disposition}`;
      cohort.matrix[transition] = (cohort.matrix[transition] ?? 0) + 1;
    }
  }
  for (const cohort of cohorts.values()) cohort.agreementPct = cohort.comparable ? Math.round(cohort.matched / cohort.comparable * 1000) / 10 : null;
  const isFeedback = (r: ReviewRow) => r.kind === 'correct' || r.note !== null || r.chip !== null || r.execution_status === 'undone' || r.action_status === 'rolled_back' || r.execution_status === 'failed';
  const prioritized = [...rows.filter(isFeedback), ...rows.filter((r) => !isFeedback(r))];
  const cases = prioritized.slice(0, limit).map((row) => {
    const rep = JSON.parse(row.representation) as Representation;
    const answers = row.answers ? JSON.parse(row.answers) as Assessment : null;
    return {
      assessmentId: row.assessment_id, policyId: row.policy_id, policyVersion: row.version_no, rubricVersion: row.rubric_version,
      source: row.assessment_source, rule: row.deterministic_rule, ruleVersion: row.deterministic_version,
      reviewedAt: new Date(row.created_at).toISOString(), actor: row.actor,
      sender: rep.messages[0]?.from, subject: rep.messages[0]?.subject, lane: row.lane, assessmentStatus: row.status,
      suggestion: row.lane === 'show_me' ? row.final_action : row.proposed_action,
      finalSuggestion: row.final_action, decision: row.disposition, kind: row.kind, finalDecision: row.final_disposition,
      chip: row.chip, note: row.note, reason: row.reason, execution: row.execution_status, actionStatus: row.action_status, error: row.error,
      judgments: answers ? Object.fromEntries(Object.entries(answers).map(([key,value]) => [key, { value: 'choice' in value ? value.choice : value.score, confidence: value.confidence }])) : null,
      evidence: { unavailable: rep.unavailable, omittedUnread: rep.omittedUnread, clipped: rep.messages.some((m) => m.clipped), unreadAttachments: rep.messages.some((m) => m.attachmentsNotRead) }
    };
  });
  const assessmentMix = db.query(`SELECT policy_id,assessment_source,lane,status,proposed_action,COUNT(*) AS n FROM v3_assessments
    WHERE account_id=? AND created_at>=? GROUP BY policy_id,assessment_source,lane,status,proposed_action`).all(accountId,since);
  const usage = db.query(`SELECT model,status,COUNT(*) AS calls,SUM(thread_count) AS threads,SUM(input_tokens) AS input_tokens,
    SUM(duration_ms) AS duration_ms FROM v3_call_logs WHERE account_id=? AND created_at>=? GROUP BY model,status`).all(accountId,since);
  return { accountId, since: new Date(since).toISOString(), currentPolicy: policies[0] ?? null,
    policyLineage: policies.map(({ text, ...policy }) => policy), cohorts: [...cohorts.values()], assessmentMix, usage,
    caseCount: rows.length, omittedCases: Math.max(0, rows.length - cases.length), cases,
    interpretation: 'Agreement is among reviewed ready proposals only, not accuracy on all mail. Done, Skip and unresolved decisions are excluded from the denominator. Failures and undos are shown separately. Deterministic rules and Jev are separate cohorts. Inspect exact representations before changing policy.' };
}

/** Exact stored evidence, account-scoped; no Gmail or model calls. */
export function learningCase(db: Database, accountId: string, assessmentId: string) {
  const row = db.query(`SELECT a.*,p.text AS policy_text,p.version_no AS policy_version,r.kind,r.disposition,r.final_disposition,
    r.chip,r.note,r.actor,r.execution_status,r.error AS review_error,x.status AS action_status FROM v3_assessments a
    JOIN v3_policies p ON p.id=a.policy_id LEFT JOIN v3_reviews r ON r.assessment_id=a.id
    LEFT JOIN actions x ON x.id=r.action_id WHERE a.account_id=? AND a.id=?`).get(accountId,assessmentId) as any;
  if (!row) throw new Error('Assessment not found for this account');
  return { ...row, representation: JSON.parse(row.representation), answers: row.answers ? JSON.parse(row.answers) : null };
}

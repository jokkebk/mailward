/** Read-only weekly packet for a capable policy-maintenance agent. */
import { Database } from 'bun:sqlite';

const db = new Database(process.env.DATABASE_PATH || './data/emails.db', { readonly: true });
const account = process.argv[2];
if (!account) throw new Error('Usage: bun run v3-report <accountId>');
const policy = db.query('SELECT id,version_no,rubric_version,status,created_by,import_report FROM v3_policies WHERE account_id = ? ORDER BY version_no DESC LIMIT 1').get(account) as any;
console.log(`# Mailward v3 learning packet — ${account}`);
if (!policy) { console.log('No v3 policy yet.'); db.close(); process.exit(0); }
console.log(`Policy v${policy.version_no} (${policy.status}, ${policy.created_by}); rubric v${policy.rubric_version}; id ${policy.id}`);
console.log(`Import report: ${policy.import_report ?? 'none'}`);
const distribution = db.query(`SELECT a.lane, a.proposed_action, COUNT(*) n FROM v3_assessments a
  WHERE a.account_id = ? GROUP BY a.lane,a.proposed_action ORDER BY n DESC`).all(account);
console.log('\n## Assessment mix\n');
for (const row of distribution as any[]) console.log(`- ${row.lane} / ${row.proposed_action}: ${row.n}`);
console.log('\n## Review outcomes\n');
for (const row of db.query(`SELECT r.kind,r.disposition,r.execution_status,COUNT(*) n FROM v3_reviews r
  WHERE r.account_id = ? GROUP BY r.kind,r.disposition,r.execution_status ORDER BY n DESC`).all(account) as any[])
  console.log(`- ${row.kind} → ${row.disposition}: ${row.n} (${row.execution_status})`);
console.log('\n## Corrections and optional feedback\n');
for (const row of db.query(`SELECT r.created_at,r.kind,r.disposition,r.final_disposition,r.chip,r.note,a.lane,a.proposed_action,a.reason
  FROM v3_reviews r JOIN v3_assessments a ON r.assessment_id = a.id
  WHERE r.account_id = ? AND (r.kind = 'correct' OR r.chip IS NOT NULL OR r.note IS NOT NULL)
  ORDER BY r.created_at DESC LIMIT 100`).all(account) as any[])
  console.log(`- ${new Date(row.created_at).toISOString()}: ${row.lane}/${row.proposed_action} → ${row.kind}/${row.disposition}${row.final_disposition ? ` then ${row.final_disposition}` : ''}; ${row.chip ?? ''}; ${row.note ?? ''}; reason ${row.reason}`);
console.log('\n## Usage\n');
for (const row of db.query(`SELECT model,COUNT(*) calls,SUM(thread_count) threads,SUM(input_tokens) input_tokens,SUM(duration_ms) duration_ms,status
  FROM v3_call_logs WHERE account_id = ? GROUP BY model,status`).all(account) as any[])
  console.log(`- ${row.model} ${row.status}: ${row.calls} calls, ${row.threads} threads, ${row.input_tokens ?? 'unknown'} input tokens, ${row.duration_ms} ms`);
console.log('\nSkipped and done outcomes are reported separately; neither is a negative classifier example by default. Validate policy edits on held-out fixtures before replacing the current version.');
db.close();

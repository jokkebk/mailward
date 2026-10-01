/** Preview a policy replacement; --apply appends an approved revision atomically. */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { createPolicyRevision, validatePolicyText } from '../src/lib/server/v3/policy';

const [path,...flags] = process.argv.slice(2);
if (!path || flags.some((f) => f !== '--apply') || flags.length > 1) throw new Error('Usage: bun run v3-policy proposal.json [--apply]');
const input = JSON.parse(readFileSync(path,'utf8'));
for (const key of ['accountId','expectedPolicyId','text','note']) if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`Missing ${key}`);
validatePolicyText(input.text);
const apply = flags.includes('--apply');
const db = new Database(process.env.DATABASE_PATH || './data/emails.db', apply ? { readwrite: true } : { readonly: true });
try {
  db.exec('PRAGMA foreign_keys = ON');
  const update = () => {
    const current = db.query('SELECT id,version_no,text FROM v3_policies WHERE account_id=? ORDER BY version_no DESC LIMIT 1').get(input.accountId) as { id: string; version_no: number; text: string } | null;
    if (!current) throw new Error('No policy for this account; initialize the account in the app first');
    if (current.id !== input.expectedPolicyId) throw new Error('Policy changed since proposal; rebase and review the diff again');
    if (current.text.trim() === input.text.trim()) throw new Error('Policy text is unchanged');
    const preview = { accountId: input.accountId, previousPolicyId: current.id, nextVersion: current.version_no + 1, note: input.note,
      before: current.text, after: input.text.trim(), gmailActions: 0, reviewRequired: true };
    if (!apply) return { ...preview, applied: false };
    const revised = createPolicyRevision(db,input.accountId,input.text,'weekly-review',input.note);
    return { ...preview, applied: true, policyId: revised.id };
  };
  console.log(JSON.stringify(apply ? db.transaction(update).immediate() : update(),null,2));
} finally { db.close(); }

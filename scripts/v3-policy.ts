/** Preview a policy replacement (full `text` or guidance `cards`); --apply appends an approved revision atomically. */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { cardsOf, createPolicyRevision, policyText, validatePolicyText } from '../src/lib/server/v3/policy';
import type { PolicyCard } from '../src/lib/types/v3';

const [path,...flags] = process.argv.slice(2);
if (!path || flags.some((f) => f !== '--apply') || flags.length > 1) throw new Error('Usage: bun run v3-policy proposal.json [--apply]');
const input = JSON.parse(readFileSync(path,'utf8'));
for (const key of ['accountId','expectedPolicyId','note']) if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`Missing ${key}`);
const cards = Array.isArray(input.cards) ? input.cards as PolicyCard[] : null;
if (!cards && typeof input.text !== 'string') throw new Error('Provide text or cards');
const text = cards ? policyText(cards) : input.text.trim();
validatePolicyText(text);
const apply = flags.includes('--apply');
const db = new Database(process.env.DATABASE_PATH || './data/emails.db', apply ? { readwrite: true } : { readonly: true });
try {
  db.exec('PRAGMA foreign_keys = ON');
  const update = () => {
    const current = db.query('SELECT id,version_no,text,sections FROM v3_policies WHERE account_id=? ORDER BY version_no DESC LIMIT 1').get(input.accountId) as { id: string; version_no: number; text: string; sections: string | null } | null;
    if (!current) throw new Error('No policy for this account; initialize the account in the app first');
    if (current.id !== input.expectedPolicyId) throw new Error('Policy changed since proposal; rebase and review the diff again');
    if (current.text.trim() === text && !cards) throw new Error('Policy text is unchanged');
    const preview = { accountId: input.accountId, previousPolicyId: current.id, nextVersion: current.text.trim() === text ? current.version_no : current.version_no + 1, note: input.note,
      before: current.text, after: text, cardsBefore: cardsOf(current), cardsAfter: cards, gmailActions: 0, reviewRequired: true };
    if (!apply) return { ...preview, applied: false };
    const revised = createPolicyRevision(db,input.accountId,cards ?? text,'weekly-review',input.note,input.expectedPolicyId);
    return { ...preview, applied: true, policyId: revised.id };
  };
  console.log(JSON.stringify(apply ? db.transaction(update).immediate() : update(),null,2));
} finally { db.close(); }

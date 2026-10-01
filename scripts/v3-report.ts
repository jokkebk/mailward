/** Read-only weekly packet; exact evidence on demand. Never calls Gmail or Jev. */
import { Database } from 'bun:sqlite';
import { weeklyPacket, learningCase } from '../src/lib/server/v3/learning';

const args = process.argv.slice(2);
const account = args.shift();
let days = 7, limit = 30, caseId: string | undefined, json = false;
while (args.length) {
  const flag = args.shift();
  if (flag === '--json') json = true;
  else if (flag === '--days') days = Number(args.shift());
  else if (flag === '--limit') limit = Number(args.shift());
  else if (flag === '--case') { caseId = args.shift(); if (!caseId || caseId.startsWith('--')) throw new Error('--case requires an assessment ID'); }
  else throw new Error(`Unknown option: ${flag}`);
}
if (!Number.isFinite(days) || days <= 0 || !Number.isInteger(limit) || limit < 0 || limit > 500) throw new Error('Use positive --days and --limit 0–500');
const db = new Database(process.env.DATABASE_PATH || './data/emails.db', { readonly: true });
try {
  if (!account) {
    console.log('Usage: bun run v3-report <accountId> [--days 7] [--limit 30] [--json] [--case assessmentId]');
    console.log('Accounts:', (db.query('SELECT id FROM tokens ORDER BY id').all() as { id: string }[]).map((r) => r.id).join(', '));
  } else if (caseId) console.log(JSON.stringify(learningCase(db,account,caseId), null, 2));
  else {
    const packet = weeklyPacket(db,account,Date.now() - days * 86400000,limit);
    if (json) console.log(JSON.stringify(packet,null,2));
    else {
      console.log(`# Mailward v3 weekly review — ${account}\nSince ${packet.since}\n`);
      console.log('## Current policy\n');
      console.log(packet.currentPolicy ? `v${packet.currentPolicy.version_no}, id ${packet.currentPolicy.id}, rubric ${packet.currentPolicy.rubric_version}\n\n${packet.currentPolicy.text}` : 'No v3 policy yet.');
      console.log('\n## Agreement by policy / rubric / model / source\n');
      for (const c of packet.cohorts) {
        console.log(`- Policy v${c.policyVersion} (${c.policyId}), rubric ${c.rubricVersion}, ${c.source === 'rule' ? `${c.rule} v${c.ruleVersion}` : `${c.model} / actual ${c.actualModel ?? 'unknown'}`}: ${c.matched}/${c.comparable} matched (${c.agreementPct ?? 'n/a'}%); ${c.reviewed} reviews, ${c.skipped} skipped, ${c.completed} done, ${c.unresolved} unresolved, ${c.undone} undone, ${c.failed} failed`);
        console.log(`  ${JSON.stringify(c.matrix)}`);
      }
      console.log('\n## Policy lineage\n', JSON.stringify(packet.policyLineage,null,2));
      console.log('\n## Assessment mix\n', JSON.stringify(packet.assessmentMix,null,2));
      console.log('\n## Cases (corrections, notes, undos and failures first)\n', JSON.stringify(packet.cases,null,2));
      console.log(`\n${packet.omittedCases} cases omitted; use --limit or --case for more evidence.`);
      console.log('\n## Usage\n', JSON.stringify(packet.usage,null,2));
      console.log(`\n${packet.interpretation}`);
    }
  }
} finally { db.close(); }

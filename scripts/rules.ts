/**
 * Text helper for rules — the readable surface the analysis skill (and you)
 * use instead of poking at SQLite. v1: dump current rules per account.
 *
 *   bun run scripts/rules.ts <accountId>
 */
import { Database } from 'bun:sqlite';

const DB_PATH = process.env.DATABASE_PATH || './data/emails.db';
const accountId = process.argv[2];

const db = new Database(DB_PATH, { readonly: true });

const accounts = accountId
	? [accountId]
	: db.query('SELECT id FROM tokens').all().map((r: any) => r.id);

for (const acc of accounts) {
	console.log(`\n# Rules for ${acc}\n`);
	const rows = db
		.query(
			`SELECT r.id, r.name, r.status, v.priority, v.action, v.tier, v.version_no,
			        v.intent, v.match_criteria, v.change_note
			 FROM rules r
			 JOIN rule_versions v ON r.current_version_id = v.id
			 WHERE r.account_id = ?
			 ORDER BY v.priority ASC`
		)
		.all(acc) as any[];

	if (!rows.length) {
		console.log('(no rules yet — run the app and let it triage, then mine the uncovered pool)\n');
		continue;
	}

	for (const r of rows) {
		console.log(`## [${r.priority}] ${r.name}  (${r.status}, v${r.version_no}, ${r.tier})`);
		console.log(`action: ${r.action}`);
		if (r.intent) console.log(`intent: ${r.intent}`);
		console.log(`match: ${r.match_criteria}`);
		if (r.change_note) console.log(`note: ${r.change_note}`);
		console.log('');
	}
}

db.close();

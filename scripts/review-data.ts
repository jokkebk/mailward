/**
 * Review packet for the weekly-review analysis skill — the readable surface the
 * skill consumes instead of poking at SQLite (DESIGN.md §"Analysis skill").
 *
 * Emits a single markdown report per account with four sections:
 *   1. Current rules (definitions + lineage)
 *   2. Per-version metrics (the promotion-gate inputs, as DECISION SUPPORT only)
 *   3. Feedback log (reject reasons, amend notes, manual notes)
 *   4. Uncovered training corpus (manual dispositions + undecided-pool clusters)
 *
 *   bun run scripts/review-data.ts [accountId] [--window N]
 *
 * Read-only. Never mutates. Timestamps in the DB are epoch SECONDS
 * (drizzle `mode:'timestamp'`).
 */
import { Database } from 'bun:sqlite';

const DB_PATH = process.env.DATABASE_PATH || './data/emails.db';

const argv = process.argv.slice(2);
const windowFlagIdx = argv.indexOf('--window');
const WINDOW = windowFlagIdx >= 0 ? Number(argv[windowFlagIdx + 1]) : 50;
const accountArg = argv.find((a) => !a.startsWith('--') && a !== String(WINDOW));

const db = new Database(DB_PATH, { readonly: true });

const accounts = accountArg
	? [accountArg]
	: (db.query('SELECT id FROM tokens').all() as { id: string }[]).map((r) => r.id);

function fmtDate(epochSeconds: number | null): string {
	if (!epochSeconds) return '—';
	return new Date(epochSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ');
}

function ageDays(epochSeconds: number): number {
	return Math.max(0, Math.floor((Date.now() / 1000 - epochSeconds) / 86_400));
}

function out(s = '') {
	console.log(s);
}

for (const acc of accounts) {
	out(`# Weekly review packet — ${acc}`);
	out(`_generated ${fmtDate(Math.floor(Date.now() / 1000))} · metric window = last ${WINDOW} verdicts/version_`);
	out();

	// ─────────────────────────────────────────────────────────────────────────
	// 1. Current rules
	// ─────────────────────────────────────────────────────────────────────────
	const ruleRows = db
		.query(
			`SELECT r.id AS rule_id, r.name, r.status, r.current_version_id,
			        v.id AS version_id, v.version_no, v.priority, v.action, v.tier,
			        v.needs_body, v.intent, v.match_criteria, v.change_note, v.created_by
			 FROM rules r
			 JOIN rule_versions v ON r.current_version_id = v.id
			 WHERE r.account_id = ?
			 ORDER BY v.priority ASC`
		)
		.all(acc) as any[];

	out('## 1. Current rules');
	out();
	if (!ruleRows.length) {
		out('_No rules yet. Cold start: mine the uncovered clusters in §4 into starter rules._');
		out();
	} else {
		for (const r of ruleRows) {
			out(`### [${r.priority}] ${r.name}`);
			out(
				`- rule_id: \`${r.rule_id}\` · status: **${r.status}** · v${r.version_no} (${r.created_by}) · ${r.tier} · action: **${r.action}**${r.needs_body ? ' · needs_body' : ''}`
			);
			if (r.intent) out(`- intent: ${r.intent}`);
			out(`- match: \`${r.match_criteria}\``);
			if (r.change_note) out(`- last change note: ${r.change_note}`);

			// Version lineage (history) for this rule.
			const versions = db
				.query(
					`SELECT version_no, priority, action, created_by, change_note, created_at, is_current
					 FROM rule_versions WHERE rule_id = ? ORDER BY version_no DESC`
				)
				.all(r.rule_id) as any[];
			if (versions.length > 1) {
				out(`- lineage:`);
				for (const v of versions) {
					out(
						`    - v${v.version_no}${v.is_current ? ' (current)' : ''} · ${fmtDate(v.created_at)} · ${v.created_by} · ${v.action} · ${v.change_note ?? ''}`
					);
				}
			}
			out();
		}
	}

	// ─────────────────────────────────────────────────────────────────────────
	// 2. Per-version metrics (promotion-gate inputs — DECISION SUPPORT ONLY)
	// ─────────────────────────────────────────────────────────────────────────
	//
	// Gate mapping (DESIGN.md §"Promotion to auto-apply"):
	//   approve                 -> success
	//   reject                  -> failure
	//   amend_skip WITH note    -> failure (corrective)
	//   amend_skip WITHOUT note -> excluded
	//   save                    -> excluded
	// The skill NEVER promotes/demotes — promotion is the app's gate + your click.
	out('## 2. Per-version metrics (decision support only — the app owns promotion)');
	out();
	out(
		'> Mapping: approve=success · reject / amend_skip-with-note=failure · amend_skip-no-note / save=excluded.'
	);
	out('> Delete demands ~99% approval; archive/label a looser bar. Mind sample size + time.');
	out();

	for (const r of ruleRows) {
		const verdictRows = db
			.query(
				`SELECT verdict, exclude_from_metric, note, created_at
				 FROM verdicts
				 WHERE rule_version_id = ?
				 ORDER BY created_at DESC`
			)
			.all(r.version_id) as any[];

		const windowed = verdictRows.slice(0, WINDOW);
		let success = 0;
		let failure = 0;
		let excluded = 0;
		for (const v of windowed) {
			const hasNote = Boolean(v.note && String(v.note).trim());
			if (v.verdict === 'approve') success++;
			else if (v.verdict === 'reject') failure++;
			else if (v.verdict === 'amend_skip') hasNote ? failure++ : excluded++;
			else if (v.verdict === 'save') excluded++;
			else excluded++;
		}
		const scored = success + failure;
		const rate = scored ? `${Math.round((success / scored) * 100)}%` : 'n/a';

		// Applied actions / rollbacks for this version (rollbacks = strong failure signal).
		const act = db
			.query(
				`SELECT status, count(*) AS n FROM actions
				 WHERE rule_version_id = ? GROUP BY status`
			)
			.all(r.version_id) as any[];
		const actMap = Object.fromEntries(act.map((a) => [a.status, a.n]));

		out(
			`- **${r.name}** (v${r.version_no}, ${r.action}, ${r.status}): approval ${rate} ` +
				`[✓${success} ✗${failure} ⊘${excluded} over ${windowed.length}] · ` +
				`applied ${actMap['applied'] ?? 0} · rolled_back ${actMap['rolled_back'] ?? 0} · failed ${actMap['failed'] ?? 0}` +
				(verdictRows.length > windowed.length ? ` · (lifetime ${verdictRows.length} verdicts)` : '')
		);
	}
	out();

	// ─────────────────────────────────────────────────────────────────────────
	// 3. Feedback log (the qualitative signal)
	// ─────────────────────────────────────────────────────────────────────────
	out('## 3. Feedback log (reject reasons · amend notes · manual notes)');
	out();
	const feedback = db
		.query(
			`SELECT v.created_at, v.verdict, v.note, r.name AS rule_name, v.thread_id
			 FROM verdicts v
			 LEFT JOIN rules r ON v.rule_id = r.id
			 WHERE v.account_id = ? AND v.note IS NOT NULL AND TRIM(v.note) != ''
			 ORDER BY v.created_at DESC
			 LIMIT 100`
		)
		.all(acc) as any[];

	const manualNotes = db
		.query(
			`SELECT created_at, action, note, thread_id
			 FROM actions
			 WHERE account_id = ? AND mode = 'manual' AND note IS NOT NULL AND TRIM(note) != ''
			 ORDER BY created_at DESC
			 LIMIT 100`
		)
		.all(acc) as any[];

	if (!feedback.length && !manualNotes.length) {
		out('_No notes yet — reject reasons and leftover notes show up here once you triage._');
		out();
	} else {
		for (const f of feedback) {
			out(`- ${fmtDate(f.created_at)} · **${f.verdict}** on _${f.rule_name ?? '?'}_ (${f.thread_id}): ${f.note}`);
		}
		for (const m of manualNotes) {
			out(`- ${fmtDate(m.created_at)} · **manual ${m.action}** (${m.thread_id}): ${m.note}`);
		}
		out();
	}

	// ─────────────────────────────────────────────────────────────────────────
	// 4. Uncovered training corpus
	// ─────────────────────────────────────────────────────────────────────────
	out('## 4. Uncovered training corpus');
	out();

	// 4a. Manual dispositions = what you did to leftovers by hand (mode=manual).
	const manualFates = db
		.query(
			`SELECT action, count(*) AS n FROM actions
			 WHERE account_id = ? AND mode = 'manual' GROUP BY action ORDER BY n DESC`
		)
		.all(acc) as any[];
	out('### 4a. Manual leftover dispositions (your hand-triage = the strongest new-rule signal)');
	if (!manualFates.length) {
		out('_None yet._');
	} else {
		for (const m of manualFates) out(`- ${m.action}: ${m.n}`);
		// Cluster manual dispositions by sender domain to spot rule-worthy patterns.
		const manualClusters = db
			.query(
				`SELECT t.from_domain, a.action, count(*) AS n
				 FROM actions a JOIN threads t ON a.thread_id = t.id
				 WHERE a.account_id = ? AND a.mode = 'manual'
				 GROUP BY t.from_domain, a.action
				 HAVING n >= 2
				 ORDER BY n DESC LIMIT 40`
			)
			.all(acc) as any[];
		if (manualClusters.length) {
			out();
			out('Repeated manual dispositions by domain (≥2 — candidate rules):');
			for (const c of manualClusters) out(`- \`${c.from_domain}\` → **${c.action}** ×${c.n}`);
		}
	}
	out();

	// 4b. Undecided pool = unread, not TODO, no verdict on any rule version yet.
	// Some of these may still be claimed by existing rules on the next run; focus
	// on clusters that no current rule covers.
	out('### 4b. Undecided pool clusters (unread · not TODO · no verdict yet)');
	const undecidedClusters = db
		.query(
			`SELECT from_domain, count(*) AS n,
			        group_concat(subject, ' ⏐ ') AS subjects
			 FROM threads t
			 WHERE t.account_id = ?
			   AND t.is_unread = 1
			   AND (t.label_ids IS NULL OR t.label_ids NOT LIKE '%"TODO"%')
			   AND t.id NOT IN (SELECT thread_id FROM verdicts WHERE account_id = ?)
			 GROUP BY from_domain
			 ORDER BY n DESC
			 LIMIT 40`
		)
		.all(acc, acc) as any[];

	const totalUndecided = undecidedClusters.reduce((s, c) => s + c.n, 0);
	if (!totalUndecided) {
		out('_Pool is empty — everything unread has a verdict._');
	} else {
		out(`_${totalUndecided} undecided threads across ${undecidedClusters.length} domains (top 40):_`);
		out();
		for (const c of undecidedClusters) {
			const samples = String(c.subjects ?? '')
				.split(' ⏐ ')
				.filter(Boolean)
				.slice(0, 3)
				.map((s: string) => (s.length > 70 ? s.slice(0, 67) + '…' : s));
			out(`- \`${c.from_domain}\` ×${c.n}`);
			for (const s of samples) out(`    - ${s}`);
		}
	}
	out();
	out('---');
	out();
}

db.close();

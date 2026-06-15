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

// Gmail's auto-categories — the labels you triage by glance. Mapped to short names.
const CATEGORY_NAMES: Record<string, string> = {
	CATEGORY_PERSONAL: 'Personal',
	CATEGORY_SOCIAL: 'Social',
	CATEGORY_PROMOTIONS: 'Promotions',
	CATEGORY_UPDATES: 'Updates',
	CATEGORY_FORUMS: 'Forums'
};

function parseLabels(json: string | null): string[] {
	if (!json) return [];
	try {
		const a = JSON.parse(json);
		return Array.isArray(a) ? a : [];
	} catch {
		return [];
	}
}

/** The single Gmail auto-category for a thread (or '—' if none / Primary). */
function categoryOf(labels: string[]): string {
	const c = labels.find((l) => l in CATEGORY_NAMES);
	return c ? CATEGORY_NAMES[c] : '—';
}

/**
 * A coarse "shape" for a subject so look-alike mail clusters across senders —
 * this is what surfaces deterministic-rule candidates (e.g. "[JIRA]",
 * "Invitation:", "Your receipt from") that per-domain bucketing hides.
 * Strips reply/forward markers, then keys on a leading [tag], a short prefix
 * before a colon, or the first three words.
 */
function subjectSignature(subject: string | null): string {
	let s = String(subject ?? '').trim();
	s = s.replace(/^((re|fwd|fw|aw|sv|vs|vl|wg)\s*:\s*)+/i, '').trim();
	const bracket = s.match(/^\[([^\]]{1,24})\]/);
	if (bracket) return `[${bracket[1]}]`;
	const colon = s.indexOf(':');
	if (colon > 0 && colon <= 30 && s.slice(0, colon).trim().split(/\s+/).length <= 5) {
		return s.slice(0, colon).trim() + ':';
	}
	const words = s.split(/\s+/).slice(0, 3).join(' ');
	return words || '(no subject)';
}

/** AI router rules store `action` as a JSON array of allowed dispositions. */
function fmtAction(tier: string, stored: string): string {
	if (tier !== 'ai') return stored;
	try {
		const arr = JSON.parse(stored);
		return Array.isArray(arr) ? `${arr.join('/')} (+leave)` : stored;
	} catch {
		return stored;
	}
}

function trunc(s: unknown, n: number): string {
	const str = String(s ?? '').replace(/\s+/g, ' ').trim();
	return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

function mixLine(counts: Map<string, number>): string {
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([k, n]) => `${k}×${n}`)
		.join(', ');
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
				`- rule_id: \`${r.rule_id}\` · status: **${r.status}** · v${r.version_no} (${r.created_by}) · ${r.tier} · action: **${fmtAction(r.tier, r.action)}**${r.needs_body ? ' · needs_body' : ''}`
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
		const neverMatched =
			verdictRows.length === 0 &&
			(actMap['applied'] ?? 0) === 0 &&
			(actMap['rolled_back'] ?? 0) === 0 &&
			(actMap['failed'] ?? 0) === 0;

		out(
			`- **${r.name}** (v${r.version_no}, ${fmtAction(r.tier, r.action)}, ${r.status}): approval ${rate} ` +
				`[✓${success} ✗${failure} ⊘${excluded} over ${windowed.length}] · ` +
				`applied ${actMap['applied'] ?? 0} · rolled_back ${actMap['rolled_back'] ?? 0} · failed ${actMap['failed'] ?? 0}` +
				(verdictRows.length > windowed.length ? ` · (lifetime ${verdictRows.length} verdicts)` : '') +
				(neverMatched ? ' · ⚠ no verdicts yet (never matched, or proposals still pending review)' : '')
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
	out('### 4b. Undecided pool (unread · not TODO · no verdict yet)');
	const pool = db
		.query(
			`SELECT from_domain, subject, snippet, label_ids, received_at
			 FROM threads t
			 WHERE t.account_id = ?
			   AND t.is_unread = 1
			   AND (t.label_ids IS NULL OR t.label_ids NOT LIKE '%"TODO"%')
			   AND t.id NOT IN (SELECT thread_id FROM verdicts WHERE account_id = ?)
			 ORDER BY t.received_at DESC
			 LIMIT 2000`
		)
		.all(acc, acc) as any[];

	if (!pool.length) {
		out('_Pool is empty — everything unread has a verdict._');
	} else {
		const ownDomain = acc.includes('@') ? acc.split('@')[1].toLowerCase() : '';
		out(`_${pool.length} undecided threads._`);
		out();

		// Gmail-category mix — Promotions/Updates/Forums/Social are usually
		// glance-and-clear, a strong archive/trash signal on their own.
		const catMix = new Map<string, number>();
		for (const r of pool) {
			const c = categoryOf(parseLabels(r.label_ids));
			catMix.set(c, (catMix.get(c) ?? 0) + 1);
		}
		out(`**By Gmail category:** ${mixLine(catMix)}`);
		out('_(Promotions / Updates / Forums / Social are usually bulk-clearable; — = Primary/uncategorised.)_');
		out();

		// Recurring subject shapes — cross-domain look-alikes = rule candidates.
		const sig = new Map<string, { n: number; cats: Map<string, number> }>();
		for (const r of pool) {
			const s = subjectSignature(r.subject);
			if (!sig.has(s)) sig.set(s, { n: 0, cats: new Map() });
			const e = sig.get(s)!;
			e.n++;
			const c = categoryOf(parseLabels(r.label_ids));
			e.cats.set(c, (e.cats.get(c) ?? 0) + 1);
		}
		const sigRows = [...sig.entries()]
			.filter(([, e]) => e.n >= 2)
			.sort((a, b) => b[1].n - a[1].n)
			.slice(0, 20);
		if (sigRows.length) {
			out('**Recurring subject shapes (≥2 — cross-domain rule candidates):**');
			for (const [s, e] of sigRows) {
				out(`- \`${trunc(s, 42)}\` ×${e.n}  · [${mixLine(e.cats)}]`);
			}
			out();
		}

		// By sender domain — each sample annotated with category · age · snippet
		// so trash-vs-keep is judgeable without opening Gmail. Own domain flagged.
		const byDom = new Map<string, any[]>();
		for (const r of pool) {
			if (!byDom.has(r.from_domain)) byDom.set(r.from_domain, []);
			byDom.get(r.from_domain)!.push(r);
		}
		const domRows = [...byDom.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 40);
		out(`**By sender domain (top ${domRows.length} of ${byDom.size}):**`);
		for (const [dom, rows] of domRows) {
			const own =
				ownDomain && dom.toLowerCase().endsWith(ownDomain)
					? ' ⚠ your own domain — heterogeneous, do not blanket'
					: '';
			const dcat = new Map<string, number>();
			for (const r of rows) {
				const c = categoryOf(parseLabels(r.label_ids));
				dcat.set(c, (dcat.get(c) ?? 0) + 1);
			}
			out(`- \`${dom}\` ×${rows.length}  · [${mixLine(dcat)}]${own}`);
			for (const r of rows.slice(0, 3)) {
				const c = categoryOf(parseLabels(r.label_ids));
				const snip = r.snippet ? ` — ${trunc(r.snippet, 72)}` : '';
				out(`    - "${trunc(r.subject, 66)}"${snip} · [${c}·${ageDays(r.received_at)}d]`);
			}
		}
	}
	out();
	out('---');
	out();
}

db.close();

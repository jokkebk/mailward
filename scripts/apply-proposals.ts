/**
 * Apply a set of skill-authored rule proposals to SQLite, enforcing the DESIGN
 * invariants by construction (DESIGN.md §"Analysis skill"):
 *
 *   - The skill can only ever create/leave rules at status `proposing` — NEVER `auto`.
 *   - Every written version is stamped `created_by = 'skill'`.
 *   - An `edit` appends a NEW immutable version (version_no + 1), flips is_current,
 *     and DEMOTES the rule to `proposing` (it must re-earn trust).
 *   - A `revert` is just an edit that copies an older version's definition forward
 *     (lineage preserved — never an in-place rollback).
 *
 * Usage:
 *   bun run scripts/apply-proposals.ts <proposals.json>            # dry-run (default)
 *   bun run scripts/apply-proposals.ts <proposals.json> --apply    # actually write
 *
 * Proposals file shape:
 *   {
 *     "accountId": "you@example.com",
 *     "proposals": [
 *       // Deterministic rule: a single action, executed in code by a pure match.
 *       { "op": "create", "name": "...", "priority": 100, "action": "archive",
 *         "tier": "deterministic", "needsBody": false, "intent": "...",
 *         "matchCriteria": { "type": "all", "conditions": [...] },
 *         "changeNote": "why" },
 *       // AI ROUTER rule: ONE category -> MANY dispositions. `action` is the SET of
 *       // dispositions the model may assign; 'leave' (don't claim) is always implicit.
 *       // The matchCriteria is a cheap prefilter that narrows candidates; the model
 *       // adjudicates each one. Set needsBody:true when the call must read the body
 *       // (e.g. "trash the bare calendar response, but TODO it if there's a note").
 *       { "op": "create", "name": "Calendar invites", "priority": 20,
 *         "action": ["trash", "label_todo"], "tier": "ai", "needsBody": true,
 *         "intent": "Trash bare accept/decline responses; TODO invites that need a reply.",
 *         "matchCriteria": { "type": "all",
 *           "conditions": [{ "field": "isCalendarInvite", "operator": "is", "value": true }] },
 *         "changeNote": "why" },
 *       { "op": "edit", "ruleId": "<id>", "priority": 90, "action": "trash",
 *         "matchCriteria": {...}, "intent": "...", "changeNote": "why" },
 *       { "op": "suspend", "ruleId": "<id>", "changeNote": "why" },
 *       { "op": "delete", "ruleId": "<id>", "changeNote": "why" }
 *     ]
 *   }
 *
 * `action`: a string for deterministic rules; a non-empty array for AI rules (the
 *   allowed dispositions, each one of archive|trash|label_todo). 'leave' is implicit.
 * `edit` fields are optional — omitted fields inherit from the current version. An
 *   edit reseeds the rule's per-disposition promotion rows to `proposing`.
 * A MERGE = compose: edit/keep the survivor + suspend|delete the absorbed rules.
 * `delete` is refused if any action/verdict references the rule (suspend instead),
 * so the reversible log is never orphaned.
 */
import { Database } from 'bun:sqlite';

type Action = 'archive' | 'trash' | 'label_todo';
// Deterministic rules take a single action; AI router rules take a set (array).
type ActionInput = Action | Action[];
type Op =
	| {
			op: 'create';
			name: string;
			priority: number;
			action: ActionInput;
			matchCriteria: unknown;
			intent?: string | null;
			tier?: 'deterministic' | 'ai';
			needsBody?: boolean;
			changeNote?: string;
	  }
	| {
			op: 'edit';
			ruleId: string;
			priority?: number;
			action?: ActionInput;
			matchCriteria?: unknown;
			intent?: string | null;
			tier?: 'deterministic' | 'ai';
			needsBody?: boolean;
			changeNote?: string;
	  }
	| { op: 'suspend'; ruleId: string; changeNote?: string }
	| { op: 'delete'; ruleId: string; changeNote?: string };

interface Proposals {
	accountId: string;
	proposals: Op[];
}

const file = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!file || file.startsWith('--')) {
	console.error('usage: bun run scripts/apply-proposals.ts <proposals.json> [--apply]');
	process.exit(1);
}

const raw = await Bun.file(file).text();
const doc = JSON.parse(raw) as Proposals;
if (!doc.accountId || !Array.isArray(doc.proposals)) {
	console.error('proposals file needs { accountId, proposals: [...] }');
	process.exit(1);
}

const DB_PATH = process.env.DATABASE_PATH || './data/emails.db';
const db = new Database(DB_PATH, { readwrite: true, create: false });
const now = () => Math.floor(Date.now() / 1000);

const VALID_ACTIONS: Action[] = ['archive', 'trash', 'label_todo'];

const asActions = (a: ActionInput): Action[] => (Array.isArray(a) ? a : [a]);
const allValid = (a: ActionInput): boolean => asActions(a).every((x) => VALID_ACTIONS.includes(x));
/** Serialise for storage: scalar for deterministic, JSON array for AI router rules. */
const serializeAction = (tier: string, a: ActionInput): string =>
	tier === 'ai' ? JSON.stringify(asActions(a)) : asActions(a)[0];
/** Parse a stored action column back to its allowed dispositions. */
const parseStored = (tier: string, stored: string): Action[] => {
	if (tier !== 'ai') return [stored as Action];
	try {
		const arr = JSON.parse(stored);
		return Array.isArray(arr) && arr.length ? (arr as Action[]) : [stored as Action];
	} catch {
		return [stored as Action];
	}
};
/** Reset (rule, disposition) promotion rows to the given allowed set, all 'proposing'. */
function reseedDispositions(ruleId: string, actions: Action[], ts: number) {
	db.query('DELETE FROM rule_dispositions WHERE rule_id = ?').run(ruleId);
	for (const action of [...new Set(actions)]) {
		db.query(
			`INSERT INTO rule_dispositions (id, rule_id, action, status, created_at, updated_at)
			 VALUES (?, ?, ?, 'proposing', ?, ?)`
		).run(crypto.randomUUID(), ruleId, action, ts, ts);
	}
}

function getRule(ruleId: string): any {
	return db
		.query('SELECT * FROM rules WHERE id = ? AND account_id = ?')
		.get(ruleId, doc.accountId) as any;
}
function getCurrentVersion(rule: any): any {
	return db.query('SELECT * FROM rule_versions WHERE id = ?').get(rule.current_version_id) as any;
}

// ── Validate everything up front (a bad proposal aborts the whole batch) ──────
const plan: string[] = [];
for (const [i, p] of doc.proposals.entries()) {
	const tag = `#${i + 1} ${p.op}`;
	if (p.op === 'create') {
		if (!p.name?.trim()) throw new Error(`${tag}: name required`);
		if (!allValid(p.action)) throw new Error(`${tag}: bad action ${JSON.stringify(p.action)}`);
		if (!p.matchCriteria) throw new Error(`${tag}: matchCriteria required`);
		plan.push(`${tag}: create "${p.name}" [${p.priority}] → ${asActions(p.action).join('/')} (proposing, by skill)`);
	} else if (p.op === 'edit') {
		const rule = getRule(p.ruleId);
		if (!rule) throw new Error(`${tag}: rule ${p.ruleId} not found`);
		if (p.action !== undefined && !allValid(p.action)) throw new Error(`${tag}: bad action ${JSON.stringify(p.action)}`);
		const cur = getCurrentVersion(rule);
		plan.push(
			`${tag}: "${rule.name}" v${cur.version_no} → v${cur.version_no + 1} ` +
				`(demote ${rule.status}→proposing; ${p.action ?? cur.action})`
		);
	} else if (p.op === 'suspend') {
		const rule = getRule(p.ruleId);
		if (!rule) throw new Error(`${tag}: rule ${p.ruleId} not found`);
		plan.push(`${tag}: suspend "${rule.name}" (${rule.status}→suspended)`);
	} else if (p.op === 'delete') {
		const rule = getRule(p.ruleId);
		if (!rule) throw new Error(`${tag}: rule ${p.ruleId} not found`);
		const refs =
			(db.query('SELECT count(*) AS n FROM actions WHERE rule_id = ?').get(p.ruleId) as any).n +
			(db.query('SELECT count(*) AS n FROM verdicts WHERE rule_id = ?').get(p.ruleId) as any).n;
		if (refs > 0)
			throw new Error(
				`${tag}: "${rule.name}" is referenced by ${refs} action/verdict rows — delete would orphan the log. Use "suspend" instead.`
			);
		plan.push(`${tag}: DELETE "${rule.name}" (no log references)`);
	} else {
		throw new Error(`${tag}: unknown op`);
	}
}

console.log(`# Proposal plan for ${doc.accountId} (${APPLY ? 'APPLYING' : 'DRY-RUN'})\n`);
for (const line of plan) console.log('  ' + line);
console.log();

if (!APPLY) {
	console.log('Dry-run only. Re-run with --apply to write.');
	db.close();
	process.exit(0);
}

// ── Apply transactionally ────────────────────────────────────────────────────
const apply = db.transaction(() => {
	for (const p of doc.proposals) {
		if (p.op === 'create') {
			const ruleId = crypto.randomUUID();
			const versionId = crypto.randomUUID();
			const ts = now();
			const tier = p.tier ?? 'deterministic';
			db.query(
				`INSERT INTO rules (id, account_id, name, status, current_version_id, created_at, updated_at)
				 VALUES (?, ?, ?, 'proposing', ?, ?, ?)`
			).run(ruleId, doc.accountId, p.name.trim(), versionId, ts, ts);
			db.query(
				`INSERT INTO rule_versions
				 (id, rule_id, version_no, priority, match_criteria, intent, action, tier, needs_body,
				  created_by, change_note, is_current, created_at)
				 VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, 'skill', ?, 1, ?)`
			).run(
				versionId,
				ruleId,
				p.priority,
				JSON.stringify(p.matchCriteria),
				p.intent ?? null,
				serializeAction(tier, p.action),
				tier,
				p.needsBody ? 1 : 0,
				p.changeNote ?? 'created by analysis skill',
				ts
			);
			reseedDispositions(ruleId, asActions(p.action), ts);
		} else if (p.op === 'edit') {
			const rule = getRule(p.ruleId);
			const cur = getCurrentVersion(rule);
			const versionId = crypto.randomUUID();
			const ts = now();
			const tier = p.tier ?? cur.tier;
			const storedAction =
				p.action !== undefined
					? serializeAction(tier, p.action)
					: serializeAction(tier, parseStored(cur.tier, cur.action));
			db.query('UPDATE rule_versions SET is_current = 0 WHERE rule_id = ?').run(p.ruleId);
			db.query(
				`INSERT INTO rule_versions
				 (id, rule_id, version_no, priority, match_criteria, intent, action, tier, needs_body,
				  created_by, change_note, is_current, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'skill', ?, 1, ?)`
			).run(
				versionId,
				p.ruleId,
				cur.version_no + 1,
				p.priority ?? cur.priority,
				p.matchCriteria !== undefined ? JSON.stringify(p.matchCriteria) : cur.match_criteria,
				p.intent !== undefined ? p.intent : cur.intent,
				storedAction,
				tier,
				p.needsBody !== undefined ? (p.needsBody ? 1 : 0) : cur.needs_body,
				p.changeNote ?? 'edited by analysis skill',
				ts
			);
			// Demote to proposing — a new version must re-earn trust (rule + each disposition).
			db.query(
				`UPDATE rules SET current_version_id = ?, status = 'proposing', updated_at = ? WHERE id = ?`
			).run(versionId, ts, p.ruleId);
			reseedDispositions(p.ruleId, parseStored(tier, storedAction), ts);
		} else if (p.op === 'suspend') {
			db.query(`UPDATE rules SET status = 'suspended', updated_at = ? WHERE id = ?`).run(
				now(),
				p.ruleId
			);
		} else if (p.op === 'delete') {
			db.query('DELETE FROM rule_dispositions WHERE rule_id = ?').run(p.ruleId);
			db.query('DELETE FROM rule_versions WHERE rule_id = ?').run(p.ruleId);
			db.query('DELETE FROM rules WHERE id = ?').run(p.ruleId);
		}
	}
});

apply();
console.log(`✅ Applied ${doc.proposals.length} proposal(s). New/edited rules are 'proposing'.`);
console.log('Re-run a triage in the app to see them in action.');
db.close();

/** Read-only Jev replay of the latest two completed runs with fresh AI calls.
 * Fetches body text in memory and prints aggregate results; stores no mail content.
 * Run with: bun run scripts/eval-jev.ts
 */
import { Database } from 'bun:sqlite';
import { google } from 'googleapis';
import sanitizeHtml from 'sanitize-html';

type Action = 'trash' | 'archive' | 'label_todo' | 'leave';
type ReplayRow = {
	runId: string;
	runStartedAt: number;
	accountId: string;
	ruleVersionId: string;
	ruleName: string;
	intent: string;
	allowedActions: Action[];
	needsBody: boolean;
	threadId: string;
	messageId: string | null;
	messageIdsMatch: boolean;
	from: string;
	to: string;
	subject: string;
	snippet: string;
	ageDays: number;
	labels: string[];
	labelsSource: 'action_prior_state' | 'thread_snapshot';
	isCalendarInvite: boolean;
	hasUnsubscribe: boolean;
	body?: string;
	baseline: Action;
	human: Action | null;
	humanVerdict: string | null;
};
type ReplayInput = { version: number; createdAt: string; runs: string[]; rows: ReplayRow[]; bodyFetchFailures: number };
type ReplayResult = { row: ReplayRow; jev: Action; confidence: number | null; probability: number | null };

const dbPath = process.env.DATABASE_PATH || './data/emails.db';

function parseArray(raw: string | null): string[] {
	try { return raw ? JSON.parse(raw) : []; } catch { return []; }
}

function parseActions(raw: string): Action[] {
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [raw as Action];
	} catch { return [raw as Action]; }
}

function decode(data: string): string {
	return Buffer.from(data, 'base64url').toString('utf8');
}

function findPart(payload: any, mime: string): any {
	if (payload?.mimeType === mime && payload.body?.data) return payload;
	for (const part of payload?.parts ?? []) {
		const found = findPart(part, mime);
		if (found) return found;
	}
	return null;
}

function extractBody(payload: any): string {
	const plain = findPart(payload, 'text/plain');
	const html = findPart(payload, 'text/html');
	const raw = plain?.body?.data ? decode(plain.body.data)
		: html?.body?.data ? sanitizeHtml(decode(html.body.data), { allowedTags: [], allowedAttributes: {} })
		: payload?.body?.data ? decode(payload.body.data) : '';
	const text = raw.replace(/\s+/g, ' ').trim();
	return text.length > 4000 ? text.slice(0, 4000) + '…' : text;
}

async function prepare(): Promise<ReplayInput> {
	const db = new Database(dbPath, { readonly: true });
	try {
		const runRows = db.query(`
			SELECT r.id FROM runs r
			WHERE r.status = 'completed' AND EXISTS
				(SELECT 1 FROM ai_call_logs l WHERE l.run_id = r.id
					AND l.status = 'completed' AND l.provider IN ('openai', 'gemini'))
			ORDER BY r.started_at DESC LIMIT 2
		`).all() as { id: string }[];
		if (runRows.length < 2) throw new Error('Fewer than two completed AI runs');
		const runs = runRows.map((r) => r.id);
		const raw = db.query(`
			SELECT ac.rowid AS ordering, ac.source_run_id AS runId, run.started_at AS runStartedAt,
				ac.account_id AS accountId, ac.rule_version_id AS ruleVersionId,
				r.name AS ruleName, rv.intent AS intent, rv.action AS allowed,
				rv.needs_body AS needsBody, ac.thread_id AS threadId,
				ac.message_ids AS originalMessageIds, t.message_ids AS currentMessageIds,
				t."from" AS sender, t."to" AS recipient, t.subject, t.snippet,
				t.received_at AS receivedAt, t.label_ids AS labels,
				(SELECT a.prior_state FROM actions a WHERE a.account_id = ac.account_id
					AND a.thread_id = ac.thread_id AND a.created_at >= run.started_at
					AND a.status IN ('applied', 'rolled_back')
					ORDER BY a.created_at ASC LIMIT 1) AS priorState,
				t.is_calendar_invite AS isCalendarInvite,
				t.has_unsubscribe AS hasUnsubscribe, ac.action AS baseline,
				(SELECT v.verdict FROM verdicts v WHERE v.run_id = ac.source_run_id
					AND v.rule_version_id = ac.rule_version_id AND v.thread_id = ac.thread_id
					ORDER BY v.created_at DESC LIMIT 1) AS humanVerdict,
				(SELECT a.action FROM actions a WHERE a.run_id = ac.source_run_id
					AND a.rule_version_id = ac.rule_version_id AND a.thread_id = ac.thread_id
					AND a.source = 'ai' AND a.verdict IN ('approve', 'correct')
					ORDER BY a.created_at DESC LIMIT 1) AS human
			FROM ai_classifications ac
			JOIN runs run ON run.id = ac.source_run_id
			JOIN rule_versions rv ON rv.id = ac.rule_version_id
			JOIN rules r ON r.id = ac.rule_id
			JOIN threads t ON t.id = ac.thread_id
			WHERE ac.source_run_id IN (?, ?) AND ac.cache_key = 'legacy'
			ORDER BY run.started_at DESC, rv.priority, ac.rowid
		`).all(...runs) as any[];
		const rows: ReplayRow[] = raw.map((r) => {
			const messageIds = parseArray(r.originalMessageIds);
			let priorLabels: string[] | null = null;
			try {
				const parsed = r.priorState ? JSON.parse(r.priorState) : null;
				if (Array.isArray(parsed?.labelIds)) priorLabels = parsed.labelIds;
			} catch { /* use thread snapshot */ }
			return {
				runId: r.runId, runStartedAt: r.runStartedAt, accountId: r.accountId,
				ruleVersionId: r.ruleVersionId, ruleName: r.ruleName,
				intent: r.intent || r.ruleName, allowedActions: parseActions(r.allowed),
				needsBody: Boolean(r.needsBody), threadId: r.threadId,
				messageId: messageIds[0] || null,
				messageIdsMatch: r.originalMessageIds === r.currentMessageIds,
				from: r.sender, to: r.recipient || '', subject: r.subject || '',
				snippet: r.snippet || '',
				ageDays: Math.max(0, Math.floor((r.runStartedAt - r.receivedAt) / 86400)),
				labels: priorLabels ?? parseArray(r.labels),
				labelsSource: priorLabels ? 'action_prior_state' : 'thread_snapshot',
				isCalendarInvite: Boolean(r.isCalendarInvite),
				hasUnsubscribe: Boolean(r.hasUnsubscribe), baseline: r.baseline,
				human: r.human || null, humanVerdict: r.humanVerdict || null
			};
		});
		const accountId = rows[0]?.accountId;
		if (!accountId) throw new Error('No replay rows');
		const token = db.query('SELECT access_token, refresh_token, expires_at FROM tokens WHERE id = ?')
			.get(accountId) as { access_token: string; refresh_token: string; expires_at: number } | null;
		if (!token) throw new Error('No Gmail token for replay account');
		const auth = new google.auth.OAuth2(
			process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET,
			process.env.GOOGLE_REDIRECT_URI
		);
		auth.setCredentials({ access_token: token.access_token, refresh_token: token.refresh_token,
			expiry_date: token.expires_at * 1000 });
		const gmail = google.gmail({ version: 'v1', auth });
		const bodyRows = rows.filter((r) => r.needsBody && r.messageId);
		const bodyByMessage = new Map<string, string>();
		let failures = 0;
		let next = 0;
		const uniqueIds = [...new Set(bodyRows.map((r) => r.messageId!))];
		await Promise.all(Array.from({ length: Math.min(4, uniqueIds.length) }, async () => {
			while (next < uniqueIds.length) {
				const id = uniqueIds[next++];
				try {
					const response = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
					bodyByMessage.set(id, extractBody(response.data.payload));
				} catch { failures++; bodyByMessage.set(id, ''); }
			}
		}));
		for (const row of bodyRows) row.body = bodyByMessage.get(row.messageId!) || '';
		return { version: 2, createdAt: new Date().toISOString(), runs, rows, bodyFetchFailures: failures };
	} finally { db.close(); }
}

const criteria: Record<Action, string> = {
	trash: 'Move to Trash. The rule clearly applies and the mail is safe to discard.',
	archive: 'Remove from inbox, but keep. The rule clearly applies and no action is needed.',
	label_todo: 'Keep unread and flag for the user to handle or reply. The rule clearly applies.',
	leave: 'Do not claim this thread for this rule. The rule does not clearly apply, or the provided evidence is insufficient.'
};

function buildRequest(batch: ReplayRow[]) {
	const rule = batch[0];
	const state = {
		rule: { intent: rule.intent, allowedDispositions: [...rule.allowedActions, 'leave'] },
		threads: batch.map((r) => ({
			threadId: r.threadId, from: r.from, to: r.to,
			subject: r.subject, snippet: r.snippet, ageDays: r.ageDays,
			labels: r.labels, isCalendarInvite: r.isCalendarInvite,
			hasUnsubscribe: r.hasUnsubscribe,
			...(r.needsBody ? { body: r.body || '' } : {})
		}))
	};
	const questions = Object.fromEntries(batch.map((_, i) => [
		`thread_${i}`,
		{
			type: 'choice',
			instructions: `For only \`threads[${i}]\`, given \`rule.intent\`, which allowed disposition best fits? Judge from the supplied fields only. If the rule does not clearly apply, choose leave.`,
			criteria: Object.fromEntries([...rule.allowedActions, 'leave'].map((a) => [a, criteria[a]]))
		}
	]));
	return { model: 'typesafe/jev-1.13', state, questions };
}

async function callJev(batch: ReplayRow[]) {
	const key = process.env.OPENROUTER_API_KEY;
	if (!key) throw new Error('OPENROUTER_API_KEY is missing');
	const started = performance.now();
	let response: Response | null = null;
	for (let attempt = 0; attempt < 4; attempt++) {
		response = await fetch('https://openrouter.ai/api/alpha/decisions', {
			method: 'POST',
			headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
			body: JSON.stringify(buildRequest(batch)),
			signal: AbortSignal.timeout(60000)
		});
		if (response.ok) break;
		if (response.status !== 429 && response.status < 500) throw new Error(`Jev HTTP ${response.status}`);
		await Bun.sleep((attempt + 1) * 1000);
	}
	if (!response?.ok) throw new Error(`Jev HTTP ${response?.status ?? 'unknown'}`);
	const data = await response.json() as any;
	const choices = batch.map((row, i) => {
		const answer = data.answers?.[`thread_${i}`];
		const allowed = new Set([...row.allowedActions, 'leave']);
		if (answer?.type !== 'choice' || !allowed.has(answer.choice))
			throw new Error(`Invalid Jev choice for item ${i}`);
		return { row, jev: answer.choice as Action,
			confidence: typeof answer.confidence === 'number' ? answer.confidence : null,
			probability: typeof answer.probabilities?.[answer.choice] === 'number'
				? answer.probabilities[answer.choice] : null };
	});
	return { choices, ms: Math.round(performance.now() - started),
		inputTokens: data.usage?.input_tokens ?? null, cost: data.usage?.cost ?? null,
		model: data.model ?? null };
}

async function main() {
	const input = await prepare();
	console.log(`Prepared ${input.rows.length} classifications from ${input.runs.length} runs; ${input.rows.filter((r) => r.needsBody).length} body-dependent, ${input.bodyFetchFailures} body fetch failures.`);
	const groups = new Map<string, ReplayRow[]>();
	for (const row of input.rows) {
		const key = `${row.runId}:${row.ruleVersionId}`;
		groups.set(key, [...(groups.get(key) || []), row]);
	}
	const batches = [...groups.values()].flatMap((rows) =>
		Array.from({ length: Math.ceil(rows.length / 15) }, (_, i) => rows.slice(i * 15, i * 15 + 15)));
	const results: ReplayResult[] = [];
	const calls: { count: number; ms: number; inputTokens: number | null; cost: number | null; model: string | null }[] = [];
	for (const [i, batch] of batches.entries()) {
		const response = await callJev(batch);
		results.push(...response.choices);
		calls.push({ count: batch.length, ms: response.ms, inputTokens: response.inputTokens,
			cost: response.cost, model: response.model });
		console.log(`Jev batch ${i + 1}/${batches.length}: ${batch.length} threads, ${response.ms} ms`);
	}
	const agreement = results.filter((r) => r.jev === r.row.baseline).length;
	const reviewed = results.filter((r) => r.row.human);
	const humanAgreement = reviewed.filter((r) => r.jev === r.row.human).length;
	const baselineHumanAgreement = reviewed.filter((r) => r.row.baseline === r.row.human).length;
	console.log(JSON.stringify({ runs: input.runs, total: results.length,
		baselineAgreement: agreement, reviewed: reviewed.length,
		jevHumanAgreement: humanAgreement, baselineHumanAgreement,
		bodyFetchFailures: input.bodyFetchFailures,
		calls: calls.length, totalMs: calls.reduce((n, c) => n + c.ms, 0),
		totalInputTokens: calls.reduce((n, c) => n + (c.inputTokens || 0), 0),
		totalCostUsd: calls.reduce((n, c) => n + (c.cost || 0), 0)
	}, null, 2));
}

await main();

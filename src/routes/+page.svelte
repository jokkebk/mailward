<script lang="ts">
	import { onMount } from 'svelte';
	import type { Confidence, ProposalGroup, ProposalItem, RuleAction, ThreadView } from '$lib/types/rules';
	import { STORAGE_KEYS } from '$lib/constants';
	import ThreadList from '$lib/components/ThreadList.svelte';
	import EmailViewModal from '$lib/components/EmailViewModal.svelte';

	let accountId = $state<string | null>(null);
	let accounts = $state<string[]>([]);
	let running = $state(false);
	let reauthNeeded = $state(false);
	let status = $state('');
	let progress = $state<any | null>(null);

	let runId = $state<string | null>(null);
	let proposals = $state<ProposalGroup[]>([]);
	let leftovers = $state<ThreadView[]>([]);
	let history = $state<any[]>([]);

	// Per-group UI state, keyed by versionId.
	let unchecked = $state<Record<string, Set<string>>>({});
	let saved = $state<Record<string, Set<string>>>({});
	let aiChoices = $state<Record<string, Record<string, AiDisposition>>>({});
	let aiNotes = $state<Record<string, Record<string, string>>>({});
	let noteOpen = $state<Record<string, Set<string>>>({});
	let deciding = $state<Record<string, boolean>>({});
	let ruleDispositionDialog = $state<RuleDispositionDialog | null>(null);
	let viewingEmail = $state<ThreadView | null>(null);

	// Collapse state for history runs (ThreadList owns its own expand state).
	let expandedRuns = $state<Record<string, boolean>>({});

	const actionLabel: Record<string, string> = {
		archive: 'Archive',
		trash: 'Trash',
		label_todo: '→ TODO',
		mark_read: 'Mark read'
	};
	const reviewLabel: Record<AiDisposition, string> = {
		trash: 'Trash',
		archive: 'Archive',
		label_todo: 'TODO',
		skip: 'Skip',
		correct: 'Correct'
	};
	const applyAllLabel: Record<AiDisposition, string> = {
		trash: 'Trash all',
		archive: 'Archive all',
		label_todo: 'Mark all TODO',
		skip: 'Skip all',
		correct: 'Correct all'
	};
	const DISPOSITION_ORDER: RuleAction[] = ['trash', 'archive', 'label_todo'];
	const AI_REVIEW_CHOICES: AiDisposition[] = ['trash', 'archive', 'label_todo', 'skip', 'correct'];

	type AiDisposition = RuleAction | 'skip' | 'correct';
	type RuleDispositionDialog = {
		ruleId: string;
		versionId: string;
		name: string;
		currentAction: RuleAction;
		action: RuleAction;
		note: string;
	};

	onMount(async () => {
		const params = new URLSearchParams(location.search);
		const fromUrl = params.get('accountId');
		if (fromUrl) localStorage.setItem(STORAGE_KEYS.accountId, fromUrl);
		accountId = fromUrl || localStorage.getItem(STORAGE_KEYS.accountId);
		await loadAccounts();
		if (accountId) {
			await loadHistory();
			await rehydrate();
		}
	});

	async function loadAccounts() {
		const r = await fetch('/api/accounts');
		if (r.ok) accounts = (await r.json()).accounts ?? [];
		if (!accountId && accounts.length) selectAccount(accounts[0]);
	}

	function selectAccount(id: string) {
		accountId = id;
		localStorage.setItem(STORAGE_KEYS.accountId, id);
		loadHistory();
		rehydrate();
	}

	/** Restore the latest run's open proposals on load / account switch (no re-run). */
	async function rehydrate() {
		try {
			const r = await api('/api/proposals');
			if (!r.ok) return;
			const data = await r.json();
			runId = data.runId;
			proposals = data.proposals ?? [];
			leftovers = data.leftovers ?? [];
			initChecks(proposals);
		} catch {
			/* reauth handled in api() */
		}
	}

	/** Pre-check high/med, pre-uncheck low — approve-all does the safe thing. */
	function initChecks(groups: ProposalGroup[]) {
		const u: Record<string, Set<string>> = {};
		const choices: Record<string, Record<string, AiDisposition>> = {};
		for (const g of groups) {
			if (g.tier === 'ai') {
				choices[g.versionId] = Object.fromEntries(g.threads.map((t) => [t.id, t.action]));
			} else {
				const low = new Set(g.threads.filter((t) => t.confidence === 'low').map((t) => t.id));
				if (low.size) u[g.versionId] = low;
			}
		}
		unchecked = u;
		saved = {};
		aiChoices = choices;
		aiNotes = {};
		noteOpen = {};
	}

	/** Split a group's threads into per-disposition sub-lists (router rules fan out). */
	function dispositionGroups(g: ProposalGroup): { action: RuleAction; items: ProposalItem[] }[] {
		if (g.tier !== 'ai') return [{ action: g.action, items: g.threads }];
		const byAction = new Map<RuleAction, ProposalItem[]>();
		for (const t of g.threads) {
			if (!byAction.has(t.action)) byAction.set(t.action, []);
			byAction.get(t.action)!.push(t);
		}
		return DISPOSITION_ORDER.filter((a) => byAction.has(a)).map((a) => ({
			action: a,
			items: byAction.get(a)!
		}));
	}

	const confidenceLabel: Record<Confidence, string> = { high: 'high', med: 'med', low: 'low' };
	const stageLabel: Record<string, string> = {
		setup: 'Preparing run',
		gmail_list: 'Fetching Gmail unread list',
		metadata_sync: 'Fetching message metadata',
		load_pool: 'Loading local candidate pool',
		rule_filter: 'Running rule filters',
		body_fetch: 'Fetching message bodies',
		ai_batch: 'Running AI classifier',
		write_proposals: 'Writing proposals',
		finalize: 'Finalizing'
	};

	function sleep(ms: number) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function fmtInt(n: number | null | undefined) {
		return n == null ? 'n/a' : new Intl.NumberFormat().format(n);
	}

	function fmtMs(ms: number | null | undefined) {
		if (ms == null) return '…';
		if (ms < 1000) return `${ms} ms`;
		return `${(ms / 1000).toFixed(1)} s`;
	}

	function progressLine(p: any | null) {
		const step = p?.activeStep;
		if (!step) return p?.status === 'running' ? 'Starting…' : '';
		const label = stageLabel[step.stage] ?? step.stage;
		const rule = step.ruleName ? ` · ${step.ruleName}` : '';
		const batch = step.batchIndex && step.batchTotal ? ` · batch ${step.batchIndex}/${step.batchTotal}` : '';
		const count = step.total ? ` · ${fmtInt(step.current ?? 0)}/${fmtInt(step.total)}` : '';
		return `${label}${rule}${batch}${count}`;
	}

	async function api(path: string, init?: RequestInit) {
		const sep = path.includes('?') ? '&' : '?';
		const r = await fetch(`${path}${sep}accountId=${encodeURIComponent(accountId!)}`, init);
		if (r.status === 401) {
			const body = await r.json().catch(() => ({}));
			if (body?.code === 'reauth_required') {
				reauthNeeded = true;
				throw new Error('reauth');
			}
		}
		return r;
	}

	async function runTriage(sync = true) {
		if (!accountId) return;
		running = true;
		reauthNeeded = false;
		progress = null;
		status = sync ? 'Starting fetch & analyze…' : 'Starting analysis…';
		try {
			const r = await api(`/api/run?sync=${sync}`, { method: 'POST' });
			const data = await r.json();
			if (!r.ok) throw new Error(data.error || 'run failed');
			runId = data.runId;
			while (true) {
				const pr = await api(`/api/run/progress?runId=${encodeURIComponent(runId!)}`);
				const progressData = await pr.json();
				if (!pr.ok) throw new Error(progressData.error || 'progress failed');
				progress = progressData;
				status = progressLine(progressData);

				if (progressData.status === 'completed') {
					proposals = progressData.result?.proposals ?? [];
					leftovers = progressData.result?.leftovers ?? [];
					initChecks(proposals);
					status = `Done · ${proposals.length} rule group(s) · ${leftovers.length} uncovered`;
					await loadHistory();
					break;
				}
				if (progressData.status === 'reauth_required') {
					reauthNeeded = true;
					status = 'Gmail access expired — reauthorize and run again.';
					break;
				}
				if (progressData.status === 'failed') {
					const failed = progressData.recentSteps?.find((s: any) => s.status === 'failed');
					throw new Error(failed?.error || 'run failed');
				}

				await sleep(900);
			}
		} catch (e) {
			if ((e as Error).message !== 'reauth') status = `Error: ${(e as Error).message}`;
		} finally {
			running = false;
		}
	}

	function isChecked(g: ProposalGroup, id: string) {
		return !(unchecked[g.versionId]?.has(id));
	}
	function toggleCheck(g: ProposalGroup, id: string) {
		const set = new Set(unchecked[g.versionId] ?? []);
		if (set.has(id)) set.delete(id);
		else {
			set.add(id);
			// unchecking clears any "saved" mark until re-toggled
		}
		unchecked = { ...unchecked, [g.versionId]: set };
	}
	function isSaved(g: ProposalGroup, id: string) {
		return saved[g.versionId]?.has(id) ?? false;
	}
	function toggleSaved(g: ProposalGroup, id: string) {
		const set = new Set(saved[g.versionId] ?? []);
		if (set.has(id)) set.delete(id);
		else set.add(id);
		saved = { ...saved, [g.versionId]: set };
	}

	function aiChoice(g: ProposalGroup, t: ProposalItem): AiDisposition {
		return aiChoices[g.versionId]?.[t.id] ?? t.action;
	}

	function setAiChoice(g: ProposalGroup, t: ProposalItem, choice: AiDisposition) {
		aiChoices = {
			...aiChoices,
			[g.versionId]: {
				...(aiChoices[g.versionId] ?? {}),
				[t.id]: choice
			}
		};
	}

	function aiNote(g: ProposalGroup, id: string): string {
		return aiNotes[g.versionId]?.[id] ?? '';
	}

	function setAiNote(g: ProposalGroup, id: string, note: string) {
		aiNotes = {
			...aiNotes,
			[g.versionId]: {
				...(aiNotes[g.versionId] ?? {}),
				[id]: note
			}
		};
	}

	function isNoteOpen(g: ProposalGroup, id: string) {
		return noteOpen[g.versionId]?.has(id) ?? false;
	}

	function toggleNote(g: ProposalGroup, id: string) {
		const set = new Set(noteOpen[g.versionId] ?? []);
		if (set.has(id)) set.delete(id);
		else set.add(id);
		noteOpen = { ...noteOpen, [g.versionId]: set };
	}

	function resetSuggestions(g: ProposalGroup) {
		aiChoices = {
			...aiChoices,
			[g.versionId]: Object.fromEntries(g.threads.map((t) => [t.id, t.action]))
		};
		aiNotes = { ...aiNotes, [g.versionId]: {} };
		noteOpen = { ...noteOpen, [g.versionId]: new Set() };
	}

	function applyReviewedLabel(g: ProposalGroup) {
		if (!g.threads.length) return 'Apply reviewed';
		const first = aiChoice(g, g.threads[0]);
		return g.threads.every((t) => aiChoice(g, t) === first) ? applyAllLabel[first] : 'Apply reviewed';
	}

	function openRuleDispositionDialog(g: ProposalGroup) {
		if (g.tier === 'ai') return;
		ruleDispositionDialog = {
			ruleId: g.ruleId,
			versionId: g.versionId,
			name: g.name,
			currentAction: g.action,
			action: g.action,
			note: ''
		};
	}

	function closeRuleDispositionDialog() {
		ruleDispositionDialog = null;
	}

	function setRuleDispositionAction(action: RuleAction) {
		if (!ruleDispositionDialog) return;
		ruleDispositionDialog = { ...ruleDispositionDialog, action };
	}

	function setRuleDispositionNote(note: string) {
		if (!ruleDispositionDialog) return;
		ruleDispositionDialog = { ...ruleDispositionDialog, note };
	}

	function moveVersionState(oldVersionId: string, newVersionId: string) {
		const oldUnchecked = unchecked[oldVersionId];
		const oldSaved = saved[oldVersionId];
		const { [oldVersionId]: _u, ...restUnchecked } = unchecked;
		const { [oldVersionId]: _s, ...restSaved } = saved;
		const { [oldVersionId]: _d, ...restDeciding } = deciding;
		unchecked = oldUnchecked ? { ...restUnchecked, [newVersionId]: oldUnchecked } : restUnchecked;
		saved = oldSaved ? { ...restSaved, [newVersionId]: oldSaved } : restSaved;
		deciding = restDeciding;
	}

	async function applyRuleDispositionChange() {
		const dialog = ruleDispositionDialog;
		if (!dialog || dialog.action === dialog.currentAction || !runId) return;

		deciding = { ...deciding, [dialog.versionId]: true };
		try {
			const r = await api('/api/rules/disposition', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					runId,
					ruleId: dialog.ruleId,
					versionId: dialog.versionId,
					action: dialog.action,
					note: dialog.note.trim() || null
				})
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error || 'disposition change failed');
			const newVersionId = data.versionId as string;
			const action = data.action as RuleAction;
			proposals = proposals.map((g) =>
				g.versionId === dialog.versionId && g.ruleId === dialog.ruleId
					? {
							...g,
							versionId: newVersionId,
							action,
							intent: data.intent ?? g.intent,
							priority: data.priority ?? g.priority,
							status: 'proposing',
							threads: g.threads.map((t) => ({ ...t, action }))
						}
					: g
			);
			moveVersionState(dialog.versionId, newVersionId);
			ruleDispositionDialog = null;
			status = `Changed "${dialog.name}" to ${actionLabel[action]}. Apply the card when ready.`;
		} catch (e) {
			if ((e as Error).message !== 'reauth') status = `Error: ${(e as Error).message}`;
		} finally {
			const { [dialog.versionId]: _old, ...rest } = deciding;
			deciding = rest;
		}
	}

	async function applyReviewed(g: ProposalGroup) {
		const missing = g.threads.filter((t) => aiChoice(g, t) === 'correct' && !aiNote(g, t.id).trim());
		if (missing.length) {
			status = `Add a note for ${missing.length} Correct row(s) before applying "${g.name}".`;
			const open = new Set(noteOpen[g.versionId] ?? []);
			for (const t of missing) open.add(t.id);
			noteOpen = { ...noteOpen, [g.versionId]: open };
			return;
		}

		const reviews = g.threads.map((t) => ({
			threadId: t.id,
			disposition: aiChoice(g, t),
			note: aiNote(g, t.id).trim() || null
		}));

		deciding = { ...deciding, [g.versionId]: true };
		try {
			const r = await api('/api/decisions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ runId, ruleId: g.ruleId, versionId: g.versionId, verb: 'review', reviews })
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error || 'review failed');
			proposals = proposals.filter((p) => p.versionId !== g.versionId);
			status = `${data.appliedCount ?? 0} applied for "${g.name}"${data.failed ? `, ${data.failed} failed` : ''}.`;
			await loadHistory();
		} catch (e) {
			if ((e as Error).message !== 'reauth') status = `Error: ${(e as Error).message}`;
		} finally {
			deciding = { ...deciding, [g.versionId]: false };
		}
	}

	async function decide(g: ProposalGroup, verb: 'approve' | 'amend' | 'reject') {
		const all = g.threads.map((t) => t.id);
		const uncheckedSet = unchecked[g.versionId] ?? new Set();
		const savedSet = saved[g.versionId] ?? new Set();

		let body: any = { runId, ruleId: g.ruleId, versionId: g.versionId, verb };

		if (verb === 'approve') {
			body.apply = all;
		} else if (verb === 'amend') {
			body.apply = all.filter((id) => !uncheckedSet.has(id));
			body.save = all.filter((id) => uncheckedSet.has(id) && savedSet.has(id));
			body.skip = all.filter((id) => uncheckedSet.has(id) && !savedSet.has(id));
			const note = prompt('Optional note for this amend (helps the analysis skill learn):') ?? '';
			body.note = note;
		} else {
			const note = prompt(`Why reject this ${g.tier === 'ai' ? 'group' : 'batch'}? (required)`);
			if (!note?.trim()) {
				status = 'Reject cancelled — a note is required.';
				return;
			}
			body.note = note;
			body.allThreadIds = all;
			body.suspend = confirm('Also SUSPEND this rule until you revise it?');
		}

		deciding = { ...deciding, [g.versionId]: true };
		try {
			const r = await api('/api/decisions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body)
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error || 'decision failed');
			proposals = proposals.filter((p) => p.versionId !== g.versionId);
			status =
				verb === 'reject'
					? `Rejected "${g.name}"${data.suspended ? ' and suspended it' : ''}.`
					: `${data.appliedCount ?? 0} applied for "${g.name}"${data.failed ? `, ${data.failed} failed` : ''}.`;
			await loadHistory();
		} catch (e) {
			if ((e as Error).message !== 'reauth') status = `Error: ${(e as Error).message}`;
		} finally {
			deciding = { ...deciding, [g.versionId]: false };
		}
	}

	async function leftoverAction(t: ThreadView, action: string) {
		try {
			const r = await api('/api/leftover', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ threadId: t.id, action, runId })
			});
			const data = await r.json();
			if (!r.ok || !data.ok) throw new Error(data.error || 'failed');
			if (action !== 'label_todo') leftovers = leftovers.filter((x) => x.id !== t.id);
			status = `${actionLabel[action]} · ${t.subject ?? '(no subject)'}`;
			await loadHistory();
		} catch (e) {
			if ((e as Error).message !== 'reauth') status = `Error: ${(e as Error).message}`;
		}
	}

	async function loadHistory() {
		try {
			const r = await api('/api/actions');
			if (r.ok) history = (await r.json()).actions ?? [];
		} catch {
			/* reauth handled in api() */
		}
	}

	async function undo(scope: 'run' | 'batch' | 'action', opts: any) {
		try {
			const r = await api('/api/undo', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ scope, ...opts })
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error || 'undo failed');
			status = `Rolled back ${data.undone}${data.failed ? `, ${data.failed} failed` : ''}.`;
			await loadHistory();
		} catch (e) {
			if ((e as Error).message !== 'reauth') status = `Error: ${(e as Error).message}`;
		}
	}

	// Group applied history by run for the rollback UI.
	let historyByRun = $derived.by(() => {
		const groups: Record<string, any[]> = {};
		for (const a of history) {
			const key = a.runId ?? 'manual';
			(groups[key] ??= []).push(a);
		}
		return Object.entries(groups);
	});

	function gmailLink(threadId: string) {
		return `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
	}
</script>

<div class="bar">
	{#if accounts.length}
		<select onchange={(e) => selectAccount((e.target as HTMLSelectElement).value)} value={accountId}>
			{#each accounts as a}<option value={a}>{a}</option>{/each}
		</select>
	{/if}
	<a class="btn ghost" href="/auth">{accountId ? 'Add / re-connect account' : 'Connect Gmail'}</a>
	{#if accountId}
		<button class="btn primary" onclick={() => runTriage(true)} disabled={running}>
			{running ? 'Running…' : 'Fetch & analyze'}
		</button>
		<button class="btn" onclick={() => runTriage(false)} disabled={running} title="Re-run rules against the already-fetched threads (no Gmail fetch)">
			Analyze only
		</button>
	{/if}
</div>

{#if status}<p class="status">{status}</p>{/if}

{#if progress && (running || progress.rules?.length || progress.aiTotals?.calls)}
	<section class="progress-panel">
		<div class="progress-head">
			<div>
				<strong>{progressLine(progress) || 'Run progress'}</strong>
				<span class="muted"> · run {progress.runId.slice(0, 8)} · {progress.status}</span>
			</div>
			<div class="usage">
				AI calls {fmtInt(progress.aiTotals?.calls ?? 0)} · tokens {fmtInt(progress.aiTotals?.totalTokens)} · chars {fmtInt((progress.aiTotals?.promptChars ?? 0) + (progress.aiTotals?.responseChars ?? 0))}
			</div>
		</div>
		{#if progress.warnings?.length}
			<div class="warnings">
				{#each progress.warnings as warning}
					<div>{warning}</div>
				{/each}
			</div>
		{/if}
		{#if progress.rules?.length}
			<div class="rule-grid">
				<div class="rule-grid-head">Rule</div>
				<div class="rule-grid-head">Filter</div>
				<div class="rule-grid-head">Body</div>
				<div class="rule-grid-head">AI</div>
				<div class="rule-grid-head">Claimed</div>
				<div class="rule-grid-head">Time</div>
				<div class="rule-grid-head">Usage</div>
				{#each progress.rules as r (r.ruleId)}
					<div>
						<strong>{r.name}</strong>
						<span class="muted"> · {r.tier ?? 'rule'}{r.needsBody ? ' · body' : ''}</span>
					</div>
					<div>{fmtInt(r.matchedCount)} / {fmtInt(r.poolSize)}</div>
					<div>{fmtInt(r.bodyFetchCount)}</div>
					<div>{fmtInt(r.aiBatchCount)}</div>
					<div>{fmtInt(r.claimedCount)}</div>
					<div>{fmtMs(r.durationMs)}</div>
					<div>{fmtInt(r.totalTokens)} tok · {fmtInt(r.promptChars + r.responseChars)} chars</div>
				{/each}
			</div>
		{/if}
	</section>
{/if}

{#if reauthNeeded}
	<div class="reauth">
		🔑 Gmail access expired (experimental apps reauth weekly).
		<a class="btn primary" href="/auth">Reauthorize</a>
	</div>
{/if}

{#if accountId && (proposals.length || leftovers.length)}
	<!-- Proposals -->
	{#each proposals as g (g.versionId)}
		<section class="card" class:busy={deciding[g.versionId]}>
			{#if deciding[g.versionId]}
				<div class="overlay"><span class="spinner"></span> Applying…</div>
			{/if}
			<div class="card-head">
				<div>
					<strong>{g.name}</strong>
					{#if g.tier === 'ai'}<span class="tier">AI</span>{/if}
					<span class="muted">· {g.threads.length} thread(s) · prio {g.priority}</span>
				</div>
				<div class="verbs">
					{#if g.tier === 'ai'}
						<button class="btn primary" disabled={deciding[g.versionId]} onclick={() => applyReviewed(g)}>
							{applyReviewedLabel(g)}
						</button>
						<button class="btn" disabled={deciding[g.versionId]} onclick={() => resetSuggestions(g)}>Reset suggestions</button>
					{:else}
						<button class="btn approve {g.action}" disabled={deciding[g.versionId]} onclick={() => decide(g, 'approve')}>
							{actionLabel[g.action]} (Approve)
						</button>
						<button class="btn" disabled={deciding[g.versionId]} onclick={() => openRuleDispositionDialog(g)}>Change disposition</button>
						<button class="btn" disabled={deciding[g.versionId]} onclick={() => decide(g, 'amend')}>Amend</button>
					{/if}
					<button class="btn danger" disabled={deciding[g.versionId]} onclick={() => decide(g, 'reject')}>{g.tier === 'ai' ? 'Reject...' : 'Reject'}</button>
				</div>
			</div>
			{#if g.intent}<p class="intent">{g.intent}</p>{/if}
			{#each dispositionGroups(g) as sub (sub.action)}
				{#if g.tier === 'ai'}
					<div class="subhead">
						<span class="badge {sub.action}">{actionLabel[sub.action]}</span>
						<span class="muted">{sub.items.length}</span>
					</div>
				{/if}
				<ThreadList
					items={sub.items}
					dim={(t) => g.tier !== 'ai' && !isChecked(g, t.id)}
					onOpen={(t) => (viewingEmail = t)}
				>
					{#snippet lead(t)}
						{@const it = t as ProposalItem}
						{#if g.tier !== 'ai'}
							<input type="checkbox" checked={isChecked(g, t.id)} onchange={() => toggleCheck(g, t.id)} />
						{/if}
						{#if it.confidence}
							<span class="conf {it.confidence}" title={it.reason ?? ''}>{confidenceLabel[it.confidence]}</span>
						{/if}
					{/snippet}
					{#snippet trail(t)}
						{@const it = t as ProposalItem}
						{#if g.tier === 'ai'}
							<div class="ai-review">
								<div class="choice-row">
									<div class="seg" aria-label="Reviewed disposition">
										{#each AI_REVIEW_CHOICES as choice}
											<button
												class:active={aiChoice(g, it) === choice}
												class:original={it.action === choice}
												class:needs-note={choice === 'correct' && aiChoice(g, it) === 'correct' && !aiNote(g, it.id).trim()}
												title={it.action === choice ? 'AI suggestion' : 'Choose disposition'}
												onclick={() => setAiChoice(g, it, choice)}
											>
												{reviewLabel[choice]}
											</button>
										{/each}
									</div>
									<button
										class="note-btn {isNoteOpen(g, it.id) || aiNote(g, it.id) ? 'on' : ''}"
										title="Show AI reason and review note"
										onclick={() => toggleNote(g, it.id)}
									>
										Note
									</button>
									<a class="gmail" href={gmailLink(t.id)} target="_blank" rel="noreferrer">open</a>
								</div>
								{#if isNoteOpen(g, it.id)}
									<div class="note-panel">
										{#if it.reason}<p><strong>AI reason:</strong> {it.reason}</p>{/if}
										<textarea
											value={aiNote(g, it.id)}
											placeholder={aiChoice(g, it) === 'correct' ? 'Required: what should the rule learn?' : 'Optional review note'}
											oninput={(e) => setAiNote(g, it.id, (e.target as HTMLTextAreaElement).value)}
										></textarea>
									</div>
								{/if}
							</div>
						{:else}
							{#if !isChecked(g, t.id)}
								<button
									class="save {isSaved(g, t.id) ? 'on' : ''}"
									title="Save this one — right rule, not this instance (excluded from metrics)"
									onclick={() => toggleSaved(g, t.id)}>★</button
								>
							{/if}
							<a class="gmail" href={gmailLink(t.id)} target="_blank" rel="noreferrer">open</a>
						{/if}
					{/snippet}
				</ThreadList>
			{/each}
		</section>
	{/each}

	<!-- Leftover / uncovered launchpad -->
	{#if leftovers.length}
		<section class="card leftover">
			<div class="card-head">
				<div><strong>Uncovered</strong> <span class="muted">· {leftovers.length} thread(s) no rule claimed</span></div>
			</div>
			<p class="intent">Handle manually (captured as training data), or open in Gmail for anything needing a reply.</p>
			<ThreadList items={leftovers} onOpen={(t) => (viewingEmail = t)}>
				{#snippet trail(t)}
					<button class="mini" onclick={() => leftoverAction(t, 'archive')}>Archive</button>
					<button class="mini" onclick={() => leftoverAction(t, 'trash')}>Trash</button>
					<button class="mini" onclick={() => leftoverAction(t, 'label_todo')}>TODO</button>
					<a class="gmail" href={gmailLink(t.id)} target="_blank" rel="noreferrer">open</a>
				{/snippet}
			</ThreadList>
		</section>
	{/if}
{:else if accountId && runId}
	<p class="empty">✨ Inbox clear — nothing left to triage from the last run.</p>
{/if}

{#if viewingEmail && accountId}
	<EmailViewModal thread={viewingEmail} {accountId} onClose={() => (viewingEmail = null)} />
{/if}

{#if ruleDispositionDialog}
	<div class="modal-backdrop" role="presentation">
		<div class="modal" role="dialog" aria-modal="true" aria-labelledby="rule-disposition-title">
			<div class="modal-head">
				<strong id="rule-disposition-title">Change rule disposition</strong>
				<button class="icon-btn" aria-label="Close" onclick={closeRuleDispositionDialog}>×</button>
			</div>
			<p class="intent">
				{ruleDispositionDialog.name} will recommend this disposition on the current card and future proposals.
				No email is changed until you approve or amend the card.
			</p>
			<div class="disposition-picker" aria-label="New rule disposition">
				{#each DISPOSITION_ORDER as action}
					<button
						class="pick {action}"
						class:active={ruleDispositionDialog.action === action}
						onclick={() => setRuleDispositionAction(action)}
					>
						{actionLabel[action]}
					</button>
				{/each}
			</div>
			<label class="note-label">
				<span>Note</span>
				<textarea
					value={ruleDispositionDialog.note}
					placeholder={`Optional: why ${actionLabel[ruleDispositionDialog.currentAction]} should become ${actionLabel[ruleDispositionDialog.action]}`}
					oninput={(e) => setRuleDispositionNote((e.target as HTMLTextAreaElement).value)}
				></textarea>
			</label>
			<div class="modal-actions">
				<button class="btn" onclick={closeRuleDispositionDialog}>Cancel</button>
				<button
					class="btn primary"
					disabled={ruleDispositionDialog.action === ruleDispositionDialog.currentAction || deciding[ruleDispositionDialog.versionId]}
					onclick={applyRuleDispositionChange}
				>
					Apply
				</button>
			</div>
		</div>
	</div>
{/if}

<!-- History + rollback -->
{#if history.length}
	<section class="card history">
		<div class="card-head"><strong>History</strong></div>
		{#each historyByRun as [rid, items]}
			<div class="run">
				<div class="run-head">
					<button
						class="disclose"
						aria-expanded={!!expandedRuns[rid]}
						onclick={() => (expandedRuns = { ...expandedRuns, [rid]: !expandedRuns[rid] })}
					>
						<span class="arrow" class:open={expandedRuns[rid]}>▶</span>
						<span class="muted">Run {rid === 'manual' ? '(manual)' : rid.slice(0, 8)} · {items.length} action(s)</span>
					</button>
					{#if rid !== 'manual'}
						<button class="mini" onclick={() => undo('run', { runId: rid })}>Undo run</button>
					{/if}
				</div>
				{#if expandedRuns[rid]}
					{#each items as a (a.id)}
						<div class="hrow {a.status}">
							<span class="badge {a.action}">{actionLabel[a.action] ?? a.action}</span>
							<span class="muted">{a.ruleName ?? (a.mode === 'manual' ? 'manual' : '—')}</span>
							<span class="tid">{a.threadId.slice(0, 10)}</span>
							<span class="st">{a.status}{a.error ? `: ${a.error}` : ''}</span>
							{#if a.status === 'applied'}
								<button class="mini" onclick={() => undo('action', { actionId: a.id })}>Undo</button>
							{/if}
						</div>
					{/each}
				{/if}
			</div>
		{/each}
	</section>
{/if}

<style>
	.bar {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 0.75rem;
	}
	select {
		padding: 0.4rem 0.5rem;
		border-radius: 6px;
		border: 1px solid #cfd4dc;
	}
	.btn {
		border: 1px solid #cfd4dc;
		background: #fff;
		padding: 0.4rem 0.8rem;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.85rem;
		text-decoration: none;
		color: #1d2330;
	}
	.btn.primary {
		background: #2f6df6;
		border-color: #2f6df6;
		color: #fff;
	}
	.btn.approve.trash {
		background: #b42318;
		border-color: #b42318;
		color: #fff;
	}
	.btn.approve.archive {
		background: #667085;
		border-color: #667085;
		color: #fff;
	}
	.btn.approve.label_todo {
		background: #f5a623;
		border-color: #f5a623;
		color: #1d2330;
	}
	.btn.approve.mark_read {
		background: #1d2330;
		border-color: #1d2330;
		color: #fff;
	}
	.btn.approve.ai {
		background: #2f6df6;
		border-color: #2f6df6;
		color: #fff;
	}
	.btn.danger {
		border-color: #e0b4b4;
		color: #b42318;
	}
	.btn.ghost {
		color: #6b7280;
	}
	.btn:disabled {
		opacity: 0.6;
		cursor: default;
	}
	.icon-btn {
		border: 0;
		background: transparent;
		color: #475467;
		cursor: pointer;
		font-size: 1.3rem;
		line-height: 1;
		padding: 0.1rem 0.25rem;
	}
	.status {
		font-size: 0.85rem;
		color: #475467;
		background: #eef2ff;
		padding: 0.4rem 0.6rem;
		border-radius: 6px;
	}
	.progress-panel {
		background: #fff;
		border: 1px solid #d0d5dd;
		border-radius: 8px;
		padding: 0.75rem;
		margin-bottom: 1rem;
		font-size: 0.82rem;
	}
	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 20;
		display: grid;
		place-items: center;
		background: rgba(15, 23, 42, 0.34);
		padding: 1rem;
	}
	.modal {
		width: min(34rem, 100%);
		background: #fff;
		border: 1px solid #d0d5dd;
		border-radius: 8px;
		box-shadow: 0 18px 45px rgba(15, 23, 42, 0.2);
		padding: 1rem;
	}
	.modal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.5rem;
	}
	.disposition-picker {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 0.5rem;
		margin: 0.8rem 0;
	}
	.pick {
		border: 1px solid #cfd4dc;
		background: #fff;
		border-radius: 6px;
		padding: 0.55rem 0.6rem;
		cursor: pointer;
		font-size: 0.86rem;
	}
	.pick.active.archive {
		background: #667085;
		border-color: #667085;
		color: #fff;
	}
	.pick.active.trash {
		background: #b42318;
		border-color: #b42318;
		color: #fff;
	}
	.pick.active.label_todo {
		background: #f5a623;
		border-color: #f5a623;
		color: #1d2330;
	}
	.note-label {
		display: grid;
		gap: 0.35rem;
		color: #344054;
		font-size: 0.84rem;
	}
	.note-label textarea {
		min-height: 5rem;
		resize: vertical;
		border: 1px solid #d0d5dd;
		border-radius: 6px;
		padding: 0.55rem;
		font: inherit;
	}
	.modal-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 0.9rem;
	}
	.progress-head {
		display: flex;
		justify-content: space-between;
		gap: 0.75rem;
		flex-wrap: wrap;
		align-items: center;
	}
	.usage {
		color: #475467;
		font-variant-numeric: tabular-nums;
	}
	.warnings {
		margin-top: 0.6rem;
		padding: 0.45rem 0.55rem;
		border: 1px solid #fed7aa;
		border-radius: 6px;
		background: #fff7ed;
		color: #9a3412;
	}
	.rule-grid {
		display: grid;
		grid-template-columns: minmax(13rem, 1.6fr) repeat(6, minmax(4.5rem, 0.7fr));
		gap: 0;
		margin-top: 0.7rem;
		border: 1px solid #eaecf0;
		border-radius: 6px;
		overflow-x: auto;
	}
	.rule-grid > div {
		padding: 0.35rem 0.45rem;
		border-bottom: 1px solid #f2f4f7;
		min-width: 0;
		white-space: nowrap;
	}
	.rule-grid-head {
		background: #f9fafb;
		color: #667085;
		font-weight: 700;
	}
	.reauth {
		background: #fff7ed;
		border: 1px solid #fed7aa;
		padding: 0.6rem 0.8rem;
		border-radius: 8px;
		display: flex;
		gap: 0.75rem;
		align-items: center;
		margin-bottom: 1rem;
	}
	.card {
		position: relative;
		background: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 10px;
		padding: 0.85rem 1rem;
		margin-bottom: 1rem;
		box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
	}
	.card.busy {
		opacity: 0.85;
	}
	.overlay {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		background: rgba(255, 255, 255, 0.6);
		border-radius: 10px;
		z-index: 2;
		font-size: 0.85rem;
		color: #475467;
	}
	.spinner {
		width: 1.05rem;
		height: 1.05rem;
		border: 2px solid #c7d2fe;
		border-top-color: #2f6df6;
		border-radius: 50%;
		animation: spin 0.7s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	.disclose {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		border: none;
		background: none;
		cursor: pointer;
		padding: 0;
		text-align: left;
	}
	.arrow {
		color: #98a2b3;
		font-size: 0.65rem;
		transition: transform 0.12s ease;
	}
	.arrow.open {
		transform: rotate(90deg);
	}
	.card-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	.verbs {
		display: flex;
		gap: 0.4rem;
	}
	.intent {
		font-size: 0.82rem;
		color: #667085;
		margin: 0.4rem 0 0.6rem;
	}
	.badge {
		font-size: 0.72rem;
		padding: 0.12rem 0.45rem;
		border-radius: 999px;
		background: #eef2ff;
		color: #3538cd;
		margin-right: 0.3rem;
	}
	.badge.trash {
		background: #fef3f2;
		color: #b42318;
	}
	.badge.archive {
		background: #ecfdf3;
		color: #027a48;
	}
	.badge.label_todo {
		background: #fffaeb;
		color: #b54708;
	}
	.muted {
		color: #98a2b3;
		font-size: 0.8rem;
	}
	.tier {
		font-size: 0.66rem;
		font-weight: 700;
		letter-spacing: 0.03em;
		padding: 0.08rem 0.4rem;
		border-radius: 999px;
		background: #eef2ff;
		color: #3538cd;
		vertical-align: middle;
	}
	.subhead {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin: 0.6rem 0 0.1rem;
	}
	.conf {
		font-size: 0.62rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		padding: 0.05rem 0.35rem;
		border-radius: 999px;
		cursor: help;
	}
	.conf.high {
		background: #ecfdf3;
		color: #027a48;
	}
	.conf.med {
		background: #fffaeb;
		color: #b54708;
	}
	.conf.low {
		background: #fef3f2;
		color: #b42318;
	}
	.ai-review {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 0.35rem;
		min-width: 19rem;
	}
	.choice-row {
		display: flex;
		align-items: center;
		justify-content: flex-end;
		gap: 0.4rem;
		flex-wrap: wrap;
	}
	.seg {
		display: inline-flex;
		border: 1px solid #d0d5dd;
		border-radius: 6px;
		overflow: hidden;
		background: #fff;
	}
	.seg button {
		border: 0;
		border-right: 1px solid #d0d5dd;
		background: #fff;
		color: #344054;
		padding: 0.24rem 0.42rem;
		font-size: 0.72rem;
		cursor: pointer;
		box-shadow: inset 0 0 0 0 transparent;
	}
	.seg button:last-child {
		border-right: 0;
	}
	.seg button.original {
		box-shadow: inset 0 0 0 2px #344054;
	}
	.seg button.active {
		background: #2f6df6;
		color: #fff;
	}
	.seg button.active.original {
		box-shadow: inset 0 0 0 2px #0b3ea8;
	}
	.seg button.needs-note {
		background: #fef3f2;
		color: #b42318;
	}
	.note-btn {
		border: 1px solid #cfd4dc;
		background: #fff;
		color: #475467;
		padding: 0.22rem 0.45rem;
		border-radius: 6px;
		font-size: 0.72rem;
		cursor: pointer;
	}
	.note-btn.on {
		border-color: #2f6df6;
		color: #2f6df6;
	}
	.note-panel {
		width: min(28rem, 100%);
		border: 1px solid #e5e7eb;
		border-radius: 6px;
		background: #f9fafb;
		padding: 0.45rem;
	}
	.note-panel p {
		margin: 0 0 0.35rem;
		color: #475467;
		font-size: 0.74rem;
	}
	.note-panel textarea {
		width: 100%;
		min-height: 3.3rem;
		resize: vertical;
		border: 1px solid #d0d5dd;
		border-radius: 6px;
		padding: 0.35rem 0.45rem;
		font: inherit;
		font-size: 0.78rem;
	}
	.save {
		border: none;
		background: none;
		cursor: pointer;
		color: #cbd2dc;
		font-size: 1rem;
	}
	.save.on {
		color: #f5a623;
	}
	.gmail {
		font-size: 0.75rem;
		color: #2f6df6;
	}
	.mini {
		border: 1px solid #cfd4dc;
		background: #fff;
		padding: 0.2rem 0.5rem;
		border-radius: 5px;
		cursor: pointer;
		font-size: 0.75rem;
	}
	.empty {
		text-align: center;
		color: #667085;
		padding: 2rem;
	}
	.history .run {
		margin-top: 0.6rem;
		border-top: 1px solid #f2f4f7;
		padding-top: 0.4rem;
	}
	.run-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.hrow {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.25rem 0;
		font-size: 0.8rem;
	}
	.hrow.rolled_back {
		opacity: 0.45;
		text-decoration: line-through;
	}
	.hrow.failed .st {
		color: #b42318;
	}
	.tid {
		color: #98a2b3;
		font-family: ui-monospace, monospace;
	}
	.st {
		color: #667085;
		flex: 1;
	}
</style>

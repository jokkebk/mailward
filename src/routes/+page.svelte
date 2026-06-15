<script lang="ts">
	import { onMount } from 'svelte';
	import type { Confidence, ProposalGroup, ProposalItem, RuleAction, ThreadView } from '$lib/types/rules';
	import { STORAGE_KEYS } from '$lib/constants';
	import ThreadList from '$lib/components/ThreadList.svelte';

	let accountId = $state<string | null>(null);
	let accounts = $state<string[]>([]);
	let running = $state(false);
	let reauthNeeded = $state(false);
	let status = $state('');

	let runId = $state<string | null>(null);
	let proposals = $state<ProposalGroup[]>([]);
	let leftovers = $state<ThreadView[]>([]);
	let history = $state<any[]>([]);

	// Per-group UI state, keyed by versionId.
	let unchecked = $state<Record<string, Set<string>>>({});
	let saved = $state<Record<string, Set<string>>>({});
	let deciding = $state<Record<string, boolean>>({});

	// Collapse state for history runs (ThreadList owns its own expand state).
	let expandedRuns = $state<Record<string, boolean>>({});

	const actionLabel: Record<string, string> = {
		archive: 'Archive',
		trash: 'Trash',
		label_todo: '→ TODO',
		mark_read: 'Mark read'
	};
	const DISPOSITION_ORDER: RuleAction[] = ['trash', 'archive', 'label_todo'];

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
		for (const g of groups) {
			const low = new Set(g.threads.filter((t) => t.confidence === 'low').map((t) => t.id));
			if (low.size) u[g.versionId] = low;
		}
		unchecked = u;
		saved = {};
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
		status = sync ? 'Syncing and crunching…' : 'Re-running rules…';
		try {
			const r = await api(`/api/run?sync=${sync}`, { method: 'POST' });
			const data = await r.json();
			if (!r.ok) throw new Error(data.error || 'run failed');
			runId = data.runId;
			proposals = data.proposals;
			leftovers = data.leftovers;
			initChecks(proposals);
			const synced = data.synced === null ? 'No sync' : `Synced ${data.synced} threads`;
			status = `${synced} · ${proposals.length} rule group(s) · ${leftovers.length} uncovered`;
			await loadHistory();
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
			const note = prompt('Why reject this batch? (required)');
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
					<button class="btn approve {g.tier === 'ai' ? 'ai' : g.action}" disabled={deciding[g.versionId]} onclick={() => decide(g, 'approve')}>
						{g.tier === 'ai' ? 'Approve' : `${actionLabel[g.action]} (Approve)`}
					</button>
					<button class="btn" disabled={deciding[g.versionId]} onclick={() => decide(g, 'amend')}>Amend</button>
					<button class="btn danger" disabled={deciding[g.versionId]} onclick={() => decide(g, 'reject')}>Reject</button>
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
				<ThreadList items={sub.items} dim={(t) => !isChecked(g, t.id)}>
					{#snippet lead(t)}
						{@const it = t as ProposalItem}
						<input type="checkbox" checked={isChecked(g, t.id)} onchange={() => toggleCheck(g, t.id)} />
						{#if it.confidence}
							<span class="conf {it.confidence}" title={it.reason ?? ''}>{confidenceLabel[it.confidence]}</span>
						{/if}
					{/snippet}
					{#snippet trail(t)}
						{#if !isChecked(g, t.id)}
							<button
								class="save {isSaved(g, t.id) ? 'on' : ''}"
								title="Save this one — right rule, not this instance (excluded from metrics)"
								onclick={() => toggleSaved(g, t.id)}>★</button
							>
						{/if}
						<a class="gmail" href={gmailLink(t.id)} target="_blank" rel="noreferrer">open</a>
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
			<ThreadList items={leftovers}>
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
	.status {
		font-size: 0.85rem;
		color: #475467;
		background: #eef2ff;
		padding: 0.4rem 0.6rem;
		border-radius: 6px;
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

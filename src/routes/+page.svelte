<script lang="ts">
	import { onMount } from 'svelte';
	import type { ProposalGroup, ThreadView } from '$lib/types/rules';
	import { STORAGE_KEYS } from '$lib/constants';

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

	const actionLabel: Record<string, string> = {
		archive: 'Archive',
		trash: 'Trash',
		label_todo: '→ TODO',
		mark_read: 'Mark read'
	};

	onMount(async () => {
		const params = new URLSearchParams(location.search);
		const fromUrl = params.get('accountId');
		if (fromUrl) localStorage.setItem(STORAGE_KEYS.accountId, fromUrl);
		accountId = fromUrl || localStorage.getItem(STORAGE_KEYS.accountId);
		await loadAccounts();
		if (accountId) await loadHistory();
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

	async function runTriage() {
		if (!accountId) return;
		running = true;
		reauthNeeded = false;
		status = 'Syncing and crunching…';
		try {
			const r = await api('/api/run', { method: 'POST' });
			const data = await r.json();
			if (!r.ok) throw new Error(data.error || 'run failed');
			runId = data.runId;
			proposals = data.proposals;
			leftovers = data.leftovers;
			unchecked = {};
			saved = {};
			status = `Synced ${data.synced} threads · ${proposals.length} rule group(s) · ${leftovers.length} uncovered`;
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

		let body: any = { runId, ruleId: g.ruleId, versionId: g.versionId, action: g.action, verb };

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
	function fmtAge(d: number) {
		return d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`;
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
		<button class="btn primary" onclick={runTriage} disabled={running}>
			{running ? 'Running…' : 'Run triage'}
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
		<section class="card">
			<div class="card-head">
				<div>
					<span class="badge {g.action}">{actionLabel[g.action]}</span>
					<strong>{g.name}</strong>
					<span class="muted">· {g.threads.length} thread(s) · prio {g.priority}</span>
				</div>
				<div class="verbs">
					<button class="btn primary" onclick={() => decide(g, 'approve')}>Approve</button>
					<button class="btn" onclick={() => decide(g, 'amend')}>Amend</button>
					<button class="btn danger" onclick={() => decide(g, 'reject')}>Reject</button>
				</div>
			</div>
			{#if g.intent}<p class="intent">{g.intent}</p>{/if}
			<ul class="threads">
				{#each g.threads as t (t.id)}
					<li class:unchecked={!isChecked(g, t.id)}>
						<input type="checkbox" checked={isChecked(g, t.id)} onchange={() => toggleCheck(g, t.id)} />
						<div class="meta">
							<span class="from">{t.from}</span>
							<span class="subj">{t.subject ?? '(no subject)'}</span>
							<span class="snip">{t.snippet}</span>
						</div>
						<span class="age">{fmtAge(t.ageDays)}</span>
						{#if !isChecked(g, t.id)}
							<button
								class="save {isSaved(g, t.id) ? 'on' : ''}"
								title="Save this one — right rule, not this instance (excluded from metrics)"
								onclick={() => toggleSaved(g, t.id)}>★</button
							>
						{/if}
						<a class="gmail" href={gmailLink(t.id)} target="_blank" rel="noreferrer">open</a>
					</li>
				{/each}
			</ul>
		</section>
	{/each}

	<!-- Leftover / uncovered launchpad -->
	{#if leftovers.length}
		<section class="card leftover">
			<div class="card-head">
				<div><strong>Uncovered</strong> <span class="muted">· {leftovers.length} thread(s) no rule claimed</span></div>
			</div>
			<p class="intent">Handle manually (captured as training data), or open in Gmail for anything needing a reply.</p>
			<ul class="threads">
				{#each leftovers as t (t.id)}
					<li>
						<div class="meta">
							<span class="from">{t.from}</span>
							<span class="subj">{t.subject ?? '(no subject)'}</span>
							<span class="snip">{t.snippet}</span>
						</div>
						<span class="age">{fmtAge(t.ageDays)}</span>
						<button class="mini" onclick={() => leftoverAction(t, 'archive')}>Archive</button>
						<button class="mini" onclick={() => leftoverAction(t, 'trash')}>Trash</button>
						<button class="mini" onclick={() => leftoverAction(t, 'label_todo')}>TODO</button>
						<a class="gmail" href={gmailLink(t.id)} target="_blank" rel="noreferrer">open</a>
					</li>
				{/each}
			</ul>
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
					<span class="muted">Run {rid === 'manual' ? '(manual)' : rid.slice(0, 8)} · {items.length} action(s)</span>
					{#if rid !== 'manual'}
						<button class="mini" onclick={() => undo('run', { runId: rid })}>Undo run</button>
					{/if}
				</div>
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
		background: #fff;
		border: 1px solid #e5e7eb;
		border-radius: 10px;
		padding: 0.85rem 1rem;
		margin-bottom: 1rem;
		box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
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
	ul.threads {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	ul.threads li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0;
		border-top: 1px solid #f2f4f7;
	}
	ul.threads li.unchecked {
		opacity: 0.5;
	}
	.meta {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}
	.from {
		font-size: 0.78rem;
		color: #475467;
	}
	.subj {
		font-weight: 600;
		font-size: 0.9rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.snip {
		font-size: 0.78rem;
		color: #98a2b3;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.age {
		font-size: 0.75rem;
		color: #98a2b3;
		white-space: nowrap;
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

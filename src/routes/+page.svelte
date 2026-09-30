<script lang="ts">
	import { onMount } from 'svelte';
	import type {
		DigestGroup,
		DigestItem,
		Confidence,
		ProposalGroup,
		ProposalItem,
		RuleAction,
		RuleDispositionMetrics,
		ThreadView
	} from '$lib/types/rules';
	import { STORAGE_KEYS } from '$lib/constants';
	import ThreadList from '$lib/components/ThreadList.svelte';
	import EmailViewModal from '$lib/components/EmailViewModal.svelte';

	let accountId = $state<string | null>(null);
	let accounts = $state<string[]>([]);
	let running = $state(false);
	let useJev = $state(false);
	let jevAvailable = $state(false);
	let reauthNeeded = $state(false);
	let status = $state('');
	let progress = $state<any | null>(null);
	let progressOpen = $state(false);

	let runId = $state<string | null>(null);
	let proposals = $state<ProposalGroup[]>([]);
	let autoDigest = $state<DigestGroup[]>([]);
	// What your review did this run — applied, left alone, or declined. Same receipt
	// shape as autopilot, so a reviewed rule shrinks in place instead of vanishing.
	let reviewedDigest = $state<DigestGroup[]>([]);
	let leftovers = $state<ThreadView[]>([]);
	let history = $state<any[]>([]);

	// Per-rule disclosure and promotion state.
	let digestOpen = $state<Record<string, boolean>>({});
	let promotion = $state<RuleDispositionMetrics[]>([]);
	let promotionBusy = $state<Record<string, boolean>>({});

	// Per-group UI state, keyed by versionId.
	let unchecked = $state<Record<string, Set<string>>>({});
	let saved = $state<Record<string, Set<string>>>({});
	let aiChoices = $state<Record<string, Record<string, AiDisposition>>>({});
	let aiNotes = $state<Record<string, Record<string, string>>>({});
	let noteOpen = $state<Record<string, Set<string>>>({});
	let deciding = $state<Record<string, boolean>>({});
	// The rule prompt is reference material, not the task — keep it one click away.
	let intentOpen = $state<Record<string, boolean>>({});
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
	// Auto-applied work is described as a finished sentence: "Automatically <verb> N emails".
	// The verb carries the whole disposition so it can be highlighted as one unit.
	const autoVerb: Record<string, string> = {
		archive: 'Archived',
		trash: 'Trashed',
		label_todo: 'Marked as TODO',
		mark_read: 'Marked as read'
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
	type RuleFilter = 'current' | 'review' | 'automatic' | 'all';
	type RuleDispositionDialog = {
		ruleId: string;
		versionId: string;
		name: string;
		currentAction: RuleAction;
		action: RuleAction;
		note: string;
	};
	type RuleFlowItem = {
		ruleId: string;
		name: string;
		priority: number;
		tier: RuleDispositionMetrics['tier'];
		ruleStatus: RuleDispositionMetrics['ruleStatus'];
		dispositions: RuleDispositionMetrics[];
		proposal?: ProposalGroup;
		digests: DigestGroup[];
		/** Receipt for what your review already settled this run. */
		reviewed: DigestGroup[];
	};
	let ruleFilter = $state<RuleFilter>('current');

	onMount(async () => {
		const params = new URLSearchParams(location.search);
		const fromUrl = params.get('accountId');
		if (fromUrl) localStorage.setItem(STORAGE_KEYS.accountId, fromUrl);
		accountId = fromUrl || localStorage.getItem(STORAGE_KEYS.accountId);
		await loadAccounts();
		if (accountId) {
			await loadHistory();
			await rehydrate();
			await loadPromotion();
		}
	});

	async function loadAccounts() {
		const r = await fetch('/api/accounts');
		if (r.ok) {
			const data = await r.json();
			accounts = data.accounts ?? [];
			jevAvailable = data.jevAvailable === true;
			useJev = jevAvailable && localStorage.getItem(STORAGE_KEYS.useJev) !== 'false';
		}
		if (!accountId && accounts.length) selectAccount(accounts[0]);
	}

	function selectAccount(id: string) {
		accountId = id;
		localStorage.setItem(STORAGE_KEYS.accountId, id);
		loadHistory();
		rehydrate();
		loadPromotion();
	}

	function setUseJev(value: boolean) {
		useJev = value;
		localStorage.setItem(STORAGE_KEYS.useJev, String(value));
	}

	/** Restore the latest run's open proposals on load / account switch (no re-run). */
	async function rehydrate() {
		try {
			const r = await api('/api/proposals');
			if (!r.ok) return;
			const data = await r.json();
			runId = data.runId;
			proposals = data.proposals ?? [];
			autoDigest = data.autoDigest ?? [];
			reviewedDigest = data.reviewedDigest ?? [];
			leftovers = data.leftovers ?? [];
			initChecks(proposals);
			if (runId) {
				const pr = await api(`/api/run/progress?runId=${encodeURIComponent(runId)}`);
				if (pr.ok) progress = await pr.json();
			}
		} catch {
			/* reauth handled in api() */
		}
	}

	/** Reload both receipts for the current run (after a decision or an undo). */
	async function refreshDigests() {
		try {
			const r = await api('/api/proposals');
			if (!r.ok) return;
			const data = await r.json();
			autoDigest = data.autoDigest ?? [];
			reviewedDigest = data.reviewedDigest ?? [];
		} catch {
			/* reauth handled in api() */
		}
	}

	async function loadPromotion() {
		try {
			const r = await api('/api/rules/promotion');
			if (r.ok) promotion = (await r.json()).dispositions ?? [];
		} catch {
			/* reauth handled in api() */
		}
	}

	function promotionKey(d: Pick<RuleDispositionMetrics, 'ruleId' | 'action'>) {
		return `${d.ruleId}::${d.action}`;
	}

	/** The human's confirm click — the only path a disposition has to auto-apply. */
	async function changePromotion(
		d: RuleDispositionMetrics,
		op: 'promote' | 'demote' | 'pin' | 'unpin' | 'resume'
	) {
		const key = promotionKey(d);
		promotionBusy = { ...promotionBusy, [key]: true };
		try {
			const r = await api('/api/rules/promotion', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ruleId: d.ruleId, action: d.action, op })
			});
			const data = await r.json();
			if (!r.ok) throw new Error(data.error || 'promotion change failed');
			promotion = data.dispositions ?? promotion;
		} catch (e) {
			if ((e as Error).message !== 'reauth') status = `Error: ${(e as Error).message}`;
		} finally {
			promotionBusy = { ...promotionBusy, [key]: false };
		}
	}

	/** Undo one applied action from a receipt (autopilot or after-review). */
	async function undoDigestItem(item: DigestItem) {
		if (!item.actionId) return;
		await undo('action', { actionId: item.actionId });
		await refreshDigests();
		await loadPromotion();
	}

	/**
	 * Undo a whole digest group. Deliberately per-action rather than scope:'batch' —
	 * a router rule can have one disposition on auto and another still in review, so
	 * a batch undo would also reverse actions this group never showed.
	 */
	async function undoDigestGroup(g: DigestGroup) {
		for (const it of g.items.filter((i) => i.status === 'applied' && i.actionId)) {
			await undo('action', { actionId: it.actionId });
		}
		await refreshDigests();
		await loadPromotion();
	}

	let ruleFlow = $derived.by(() => {
		const byRule = new Map<string, RuleFlowItem>();
		const ensure = (
			ruleId: string,
			name: string,
			priority: number,
			tier: RuleFlowItem['tier'],
			ruleStatus: RuleFlowItem['ruleStatus']
		) => {
			let item = byRule.get(ruleId);
			if (!item) {
				item = { ruleId, name, priority, tier, ruleStatus, dispositions: [], digests: [], reviewed: [] };
				byRule.set(ruleId, item);
			}
			return item;
		};
		for (const d of promotion) {
			ensure(d.ruleId, d.ruleName, d.priority, d.tier, d.ruleStatus).dispositions.push(d);
		}
		for (const g of proposals) {
			ensure(g.ruleId, g.name, g.priority, g.tier, g.status).proposal = g;
		}
		for (const g of autoDigest) {
			const fallbackPriority = promotion.find((d) => d.ruleId === g.ruleId)?.priority ?? Number.MAX_SAFE_INTEGER;
			const fallbackTier = promotion.find((d) => d.ruleId === g.ruleId)?.tier ?? 'deterministic';
			const fallbackStatus = promotion.find((d) => d.ruleId === g.ruleId)?.ruleStatus ?? 'auto';
			ensure(g.ruleId, g.ruleName, fallbackPriority, fallbackTier, fallbackStatus).digests.push(g);
		}
		for (const g of reviewedDigest) {
			const d = promotion.find((p) => p.ruleId === g.ruleId);
			ensure(
				g.ruleId,
				g.ruleName,
				d?.priority ?? Number.MAX_SAFE_INTEGER,
				d?.tier ?? 'deterministic',
				d?.ruleStatus ?? 'proposing'
			).reviewed.push(g);
		}
		return [...byRule.values()].sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
	});
	let currentRuleCount = $derived(ruleFlow.filter(ruleHitThisRun).length);
	let reviewRuleCount = $derived(ruleFlow.filter((rule) => Boolean(rule.proposal?.threads.length)).length);
	let automaticRuleCount = $derived(ruleFlow.filter((rule) => rule.dispositions.some((d) => d.status === 'auto')).length);
	let visibleRuleFlow = $derived(
		ruleFlow.filter((rule) => {
			if (ruleFilter === 'current') return ruleHitThisRun(rule);
			if (ruleFilter === 'review') return Boolean(rule.proposal?.threads.length);
			if (ruleFilter === 'automatic') return rule.dispositions.some((d) => d.status === 'auto');
			return true;
		})
	);

	function ruleHitThisRun(rule: RuleFlowItem) {
		return (
			Boolean(rule.proposal?.threads.length) ||
			rule.digests.some((g) => g.items.length > 0) ||
			rule.reviewed.some((g) => g.items.length > 0)
		);
	}

	function digestFor(rule: RuleFlowItem, d: RuleDispositionMetrics) {
		return rule.digests.find((g) => g.action === d.action);
	}

	function reviewedDigestFor(rule: RuleFlowItem, d: RuleDispositionMetrics) {
		return rule.reviewed.find((g) => g.action === d.action);
	}

	/** The part of a reviewed receipt that didn't happen: left alone, or declined. */
	function declinedTail(rd: DigestGroup | undefined) {
		const parts: string[] = [];
		if (rd?.skipped) parts.push(`${rd.skipped} left alone`);
		if (rd?.rejected) parts.push(`${rd.rejected} declined`);
		return parts.join(' · ');
	}

	/** What still stands between a manual disposition and auto-apply, in words rather than ratios. */
	function automationGap(d: RuleDispositionMetrics) {
		const parts: string[] = [];
		const runsLeft = Math.max(0, d.minRun - d.leadingSuccessRun);
		if (runsLeft) parts.push(`${runsLeft} more clean approval${runsLeft === 1 ? '' : 's'} to automate`);
		if ((d.approvalPct ?? 0) < d.minApprovalPct) parts.push(`${d.approvalPct ?? 0}% approved, needs ${d.minApprovalPct}%`);
		if (d.rolledBack) parts.push(`${d.rolledBack} undone blocks automation`);
		return parts.join(' · ') || `${d.leadingSuccessRun} of ${d.minRun} approvals in a row`;
	}

	/**
	 * The muted tail after a status badge: what the run left to do. Suppressed once a
	 * receipt sentence has already accounted for this disposition's emails.
	 */
	function runPhrase(proposalCount: number, handled: number) {
		if (proposalCount) return `${proposalCount} to review this run · `;
		if (handled) return '';
		return 'none this run · ';
	}

	/** The raw gate numbers, kept as a tooltip so the visible line stays readable. */
	function automationDetail(d: RuleDispositionMetrics) {
		return `${d.leadingSuccessRun} of ${d.minRun} consecutive approvals · ${d.approvalPct ?? 0}% approved (needs ${d.minApprovalPct}%)${d.rolledBack ? ` · ${d.rolledBack} undone` : ''}`;
	}

	/**
	 * In the "this run" view a card only shows the dispositions that did something —
	 * plus any that are eligible, since those carry the promote CTA.
	 */
	function visibleDispositions(rule: RuleFlowItem) {
		if (ruleFilter !== 'current') return rule.dispositions;
		const active = rule.dispositions.filter(
			(d) =>
				digestFor(rule, d)?.items.length ||
				reviewedDigestFor(rule, d)?.items.length ||
				proposalCountFor(rule, d) ||
				d.eligible
		);
		return active.length ? active : rule.dispositions;
	}

	/** A rule running purely on autopilot: nothing on the card asks for a decision. */
	function isAutoOnly(rule: RuleFlowItem) {
		return (
			!rule.proposal &&
			!rule.reviewed.some((g) => g.items.length > 0) &&
			rule.dispositions.length > 0 &&
			rule.dispositions.every((d) => d.status === 'auto' && d.ruleStatus !== 'suspended')
		);
	}

	function proposalCountFor(rule: RuleFlowItem, d: RuleDispositionMetrics) {
		return rule.proposal?.threads.filter((t) => t.action === d.action).length ?? 0;
	}

	function progressPercent(p: any | null): number | null {
		if (p?.status === 'completed') return 100;
		const current = p?.activeStep?.current;
		const total = p?.activeStep?.total;
		if (typeof current !== 'number' || typeof total !== 'number' || total <= 0) return null;
		return Math.min(100, Math.max(2, Math.round((current / total) * 100)));
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
		auto_apply: 'Applying auto-approved rules',
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

	function fmtRunTime(ms: number | null | undefined) {
		if (!ms) return '';
		return new Intl.DateTimeFormat(undefined, {
			month: 'short',
			day: 'numeric',
			hour: '2-digit',
			minute: '2-digit'
		}).format(ms);
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
		progressOpen = false;
		status = sync ? 'Starting fetch & analyze…' : 'Starting analysis…';
		try {
			const r = await api(`/api/run?sync=${sync}&jev=${jevAvailable && useJev}`, { method: 'POST' });
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
					await refreshDigests();
					status = 'Sync complete';
					await loadHistory();
					await loadPromotion();
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
			await refreshDigests();
			await loadPromotion();
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
			await refreshDigests();
			await loadPromotion();
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

<div class="workspace-top">
	<a href="/v3" style="display:inline-block;margin-bottom:.5rem;color:#2855aa;font-weight:600">Open Mailward v3 review →</a>
<div class="bar">
	{#if accounts.length}
		<select onchange={(e) => selectAccount((e.target as HTMLSelectElement).value)} value={accountId}>
			{#each accounts as a}<option value={a}>{a}</option>{/each}
		</select>
	{/if}
	<a class="btn ghost" href="/auth">{accountId ? 'Add / re-connect account' : 'Connect Gmail'}</a>
	{#if accountId}
		{#if jevAvailable}
			<label class="jev-toggle" title="Use Jev for AI rules. While this trial is on, Jev trash suggestions wait for review.">
				<input type="checkbox" checked={useJev} disabled={running} onchange={(e) => setUseJev((e.currentTarget as HTMLInputElement).checked)} />
				<span>Jev</span>
				<strong>{useJev ? 'On' : 'Off'}</strong>
			</label>
		{/if}
		<button class="btn primary" onclick={() => runTriage(true)} disabled={running}>
			{running ? 'Running…' : 'Fetch & analyze'}
		</button>
		<button class="btn" onclick={() => runTriage(false)} disabled={running} title="Re-run rules against the already-fetched threads (no Gmail fetch)">
			Analyze only
		</button>
	{/if}
</div>

{#if status || progress}
	<section class="run-strip" class:running>
		<button
			class="run-summary"
			disabled={!progress}
			aria-expanded={progressOpen}
			onclick={() => progress && (progressOpen = !progressOpen)}
		>
			<span class="run-state" aria-hidden="true">{running ? '↻' : progress?.status === 'completed' ? '✓' : '!'}</span>
			<strong>{running ? progressLine(progress) || status : progress?.status === 'completed' ? 'Last run' : status || 'Run status'}</strong>
			{#if !running && progress?.status === 'completed'}<span class="complete-label">Complete</span>{/if}
			{#if progress}<span class="muted">{fmtRunTime(progress.startedAt)} · run {progress.runId.slice(0, 8)}</span>{/if}
			<span class="run-expand">{progressOpen ? 'Hide details' : 'Details'} {progressOpen ? '▴' : '▾'}</span>
		</button>
		<div class="progress-track" aria-label="Run progress">
			<div
				class="progress-fill"
				class:indeterminate={running && progressPercent(progress) == null}
				style:width={`${progressPercent(progress) ?? (running ? 35 : progress?.status === 'completed' ? 100 : 0)}%`}
			></div>
		</div>
		{#if progressOpen && progress}
			<div class="progress-details">
				<div class="usage">
					AI calls {fmtInt(progress.aiTotals?.calls ?? 0)} · tokens {fmtInt(progress.aiTotals?.totalTokens)} · chars {fmtInt((progress.aiTotals?.promptChars ?? 0) + (progress.aiTotals?.responseChars ?? 0))}
				</div>
				{#if progress.warnings?.length}
					<div class="warnings">
						{#each progress.warnings as warning}<div>{warning}</div>{/each}
					</div>
				{/if}
				{#if progress.rules?.length}
					<div class="rule-grid-wrap">
					<div class="rule-grid">
						<div class="rule-grid-head">Rule</div>
						<div class="rule-grid-head">Filter</div>
						<div class="rule-grid-head">Body</div>
						<div class="rule-grid-head">AI</div>
						<div class="rule-grid-head">Claimed</div>
						<div class="rule-grid-head">Time</div>
						<div class="rule-grid-head">Usage</div>
						{#each progress.rules as r (r.ruleId)}
							<div><strong>{r.name}</strong> <span class="muted">· {r.tier ?? 'rule'}{r.needsBody ? ' · body' : ''}</span></div>
							<div>{fmtInt(r.matchedCount)} / {fmtInt(r.poolSize)}</div>
							<div>{fmtInt(r.bodyFetchCount)}</div>
							<div>{fmtInt(r.aiBatchCount)}</div>
							<div>{fmtInt(r.claimedCount)}</div>
							<div>{fmtMs(r.durationMs)}</div>
							<div>{fmtInt(r.totalTokens)} tok · {fmtInt(r.promptChars + r.responseChars)} chars</div>
						{/each}
					</div>
					</div>
				{/if}
			</div>
		{/if}
	</section>
{/if}

{#if accountId && ruleFlow.length}
	<nav class="rule-filters" aria-label="Rule visibility">
		<span class="filter-label">Rules</span>
		<button class:active={ruleFilter === 'current'} onclick={() => (ruleFilter = 'current')}>
			This run <span>{currentRuleCount}</span>
		</button>
		<button class:active={ruleFilter === 'review'} onclick={() => (ruleFilter = 'review')}>
			Needs review <span>{reviewRuleCount}</span>
		</button>
		<button class:active={ruleFilter === 'automatic'} onclick={() => (ruleFilter = 'automatic')}>
			Automatic <span>{automaticRuleCount}</span>
		</button>
		<button class:active={ruleFilter === 'all'} onclick={() => (ruleFilter = 'all')}>
			All <span>{ruleFlow.length}</span>
		</button>
	</nav>
{/if}
</div>

{#if reauthNeeded}
	<div class="reauth">
		🔑 Gmail access expired (experimental apps reauth weekly).
		<a class="btn primary" href="/auth">Reauthorize</a>
	</div>
{/if}

{#snippet digestDetail(dg: DigestGroup)}
	<div class="digest-detail">
		{#if dg.applied}<button class="mini undo-all" onclick={() => undoDigestGroup(dg)}>Undo all {dg.applied}</button>{/if}
		<ul class="digest-list">
			{#each dg.items as it (it.threadId)}
				<li
					class:undone={it.status === 'rolled_back'}
					class:failed={it.status === 'failed'}
					class:untouched={it.status === 'skipped' || it.status === 'rejected'}
				>
					<div class="digest-item">
						<div class="digest-text">
							<span class="from">{it.from}</span>
							<span class="subject">{it.subject ?? '(no subject)'}</span>
							{#if it.flagged && it.status === 'applied'}<span class="badge flagged">low confidence</span>{/if}
							{#if it.status === 'rolled_back'}<span class="muted">undone</span>{/if}
							{#if it.status === 'skipped'}<span class="muted">left alone</span>{/if}
							{#if it.status === 'rejected'}<span class="muted">declined</span>{/if}
							{#if it.status === 'failed'}<span class="badge failed">failed{it.error ? `: ${it.error}` : ''}</span>{/if}
							{#if it.reason}<span class="reason">{it.reason}</span>{/if}
						</div>
						<div class="digest-actions">
							{#if it.status === 'applied'}<button class="mini" onclick={() => undoDigestItem(it)}>Undo</button>{/if}
							<a class="gmail" href={gmailLink(it.threadId)} target="_blank" rel="noreferrer">open</a>
						</div>
					</div>
				</li>
			{/each}
		</ul>
	</div>
{/snippet}

<!--
	A rule on autopilot has nothing to decide, so its card is a receipt: one past-tense
	sentence per disposition, and only the two verbs that still make sense afterwards.
-->
{#snippet autoReceipt(rule: RuleFlowItem)}
	{@const shown = visibleDispositions(rule)}
	{@const solo = shown.length === 1}
	{@const acted = rule.digests.some((g) => g.applied > 0)}
	<section class="card receipt-card" class:idle={!acted}>
		{#if !solo}
			<div class="receipt-head"><strong>{rule.name}</strong> <span class="muted">· prio {rule.priority}</span></div>
		{/if}
		{#each shown as d (promotionKey(d))}
			{@const dg = digestFor(rule, d)}
			{@const key = promotionKey(d)}
			{@const n = dg?.applied ?? 0}
			<div class="receipt">
				<div class="receipt-row">
					<p class="receipt-line" class:idle={!n}>
						{#if n}
							<span class="tick">✓</span>
							<em>Automatically</em>
							<strong class="verb {d.action}">{autoVerb[d.action]}</strong>
							{n}
							{n === 1 ? 'email' : 'emails'}{#if solo}{' '}in
								<strong>{rule.name}</strong> <span class="muted">(prio {rule.priority})</span>{/if}.
						{:else if solo}
							Nothing matched <strong>{rule.name}</strong>
							<span class="muted">(prio {rule.priority})</span> this run.
						{:else}
							<span class="badge {d.action}">{actionLabel[d.action]}</span>
							<span class="muted">nothing matched this run</span>
						{/if}
						{#if dg?.rolledBack}<span class="muted">· {dg.rolledBack} undone</span>{/if}
						{#if dg?.flagged}<span class="badge flagged">{dg.flagged} check</span>{/if}
						{#if dg?.failed}<span class="badge failed">{dg.failed} failed</span>{/if}
					</p>
					<div class="receipt-actions">
						{#if dg?.items.length}
							<button class="mini show" onclick={() => (digestOpen = { ...digestOpen, [key]: !digestOpen[key] })}>
								{digestOpen[key] ? 'Hide' : 'Show'}
							</button>
						{/if}
						<button class="mini" disabled={promotionBusy[key]} onclick={() => changePromotion(d, 'demote')}>Demote to manual</button>
					</div>
				</div>
				{#if d.rolledBack}
					<p class="mode-warning">Corrections detected — consider manual review</p>
				{/if}
				{#if dg && digestOpen[key]}
					{@render digestDetail(dg)}
				{/if}
			</div>
		{/each}
	</section>
{/snippet}

{#if accountId && (ruleFlow.length || leftovers.length)}
	<!-- One rule queue: priority order, regardless of auto/manual state. -->
	{#if !visibleRuleFlow.length}
		<p class="no-rule-hits">No rules in this view.</p>
	{/if}
	{#each visibleRuleFlow as rule (rule.ruleId)}
		{#if isAutoOnly(rule)}
			{@render autoReceipt(rule)}
		{:else}
		{@const g = rule.proposal}
		<section class="card rule-card" class:busy={g ? deciding[g.versionId] : false}>
			{#if g && deciding[g.versionId]}
				<div class="overlay"><span class="spinner"></span> Applying…</div>
			{/if}
			<div class="card-head">
				<div>
					<strong>{rule.name}</strong>
					{#if rule.tier === 'ai'}<span class="tier">AI</span>{/if}
					<span class="muted">· priority {rule.priority}</span>
				</div>
				{#if g}
					<div class="verbs">
						{#if g.tier === 'ai'}
							<button class="btn primary" disabled={deciding[g.versionId]} onclick={() => applyReviewed(g)}>{applyReviewedLabel(g)}</button>
							<button class="btn" disabled={deciding[g.versionId]} onclick={() => resetSuggestions(g)}>Reset suggestions</button>
						{:else}
							<button class="btn approve {g.action}" disabled={deciding[g.versionId]} onclick={() => decide(g, 'approve')}>{actionLabel[g.action]} (Approve)</button>
							<button class="btn" disabled={deciding[g.versionId]} onclick={() => openRuleDispositionDialog(g)}>Change disposition</button>
							<button class="btn" disabled={deciding[g.versionId]} onclick={() => decide(g, 'amend')}>Amend</button>
						{/if}
						<button class="btn danger" disabled={deciding[g.versionId]} onclick={() => decide(g, 'reject')}>{g.tier === 'ai' ? 'Reject...' : 'Reject'}</button>
					</div>
				{/if}
			</div>

			<div class="rule-modes">
				{#each visibleDispositions(rule) as d (promotionKey(d))}
					{@const dg = digestFor(rule, d)}
					{@const rd = reviewedDigestFor(rule, d)}
					{@const key = promotionKey(d)}
					{@const rKey = `${promotionKey(d)}::reviewed`}
					{@const proposalCount = proposalCountFor(rule, d)}
					<!-- The receipt sentence already names the action, so it drops the leading badge. -->
					{@const asReceipt = d.status === 'auto' && d.ruleStatus !== 'suspended' && Boolean(dg?.applied)}
					<!--
						What your review settled keeps its place in the priority queue and shrinks
						to the same one-line receipt autopilot gets — including a declined batch,
						which leaves no action behind and would otherwise vanish without trace.
						Promoting a rule mid-run doesn't retract what you already approved, so this
						is independent of the disposition's current status.
					-->
					{@const handled = rd?.applied ?? 0}
					{@const declined = declinedTail(rd)}
					{@const asReviewed = handled > 0 || Boolean(declined)}
					<div
						class="rule-mode"
						class:auto={d.status === 'auto'}
						class:reviewed={asReviewed}
						class:ready={d.eligible && !asReviewed}
					>
						<div class="mode-row">
							<div class="mode-summary">
								{#if !asReceipt && !asReviewed}<span class="badge {d.action}">{actionLabel[d.action]}</span>{/if}
								{#if asReviewed}
									<span class="receipt-line">
										{#if handled}
											<span class="tick">✓</span>
											<strong class="verb {d.action}">{autoVerb[d.action]}</strong>
											{handled}
											{handled === 1 ? 'email' : 'emails'}
											<em>after your review</em>.
										{:else}
											<span class="cross">✗</span>
											<em>Did not</em>
											<strong class="verb {d.action}">{actionLabel[d.action]}</strong>
											<em>the</em>
											{rd?.items.length}
											{rd?.items.length === 1 ? 'email' : 'emails'}
											<em>you reviewed</em>.
										{/if}
									</span>
									{#if handled && declined}<span class="muted">· {declined}</span>{/if}
									{#if rd?.rolledBack}<span class="muted">· {rd.rolledBack} undone</span>{/if}
									{#if rd?.failed}<span class="badge failed">{rd.failed} failed</span>{/if}
								{/if}
								{#if d.ruleStatus === 'suspended'}
									<span class="badge pinned">suspended</span>
									<span class="muted">switched off after a reject — not running</span>
								{:else if d.status === 'auto'}
									{#if dg?.applied}
										<span class="receipt-line">
											<span class="tick">✓</span>
											<em>Automatically</em>
											<strong class="verb {d.action}">{autoVerb[d.action]}</strong>
											{dg.applied}
											{dg.applied === 1 ? 'email' : 'emails'} this run.
										</span>
									{:else if !asReviewed}
										<span class="badge {d.action}">{actionLabel[d.action]}</span>
										<span class="muted">automatic · nothing matched this run</span>
									{:else}
										<span class="badge auto">automatic from now on</span>
									{/if}
									{#if dg?.rolledBack}<span class="muted">· {dg.rolledBack} undone</span>{/if}
									{#if dg?.flagged}<span class="badge flagged">{dg.flagged} check</span>{/if}
									{#if dg?.failed}<span class="badge failed">{dg.failed} failed</span>{/if}
									{#if d.rolledBack}<span class="mode-warning">Corrections detected — consider manual review</span>{/if}
								{:else if d.manualOnly}
									<span class="badge pinned">manual only</span>
									<span class="muted">{proposalCount ? `${proposalCount} to review this run` : handled ? 'stays manual by choice' : 'no email matched this run'}</span>
								{:else if d.eligible}
									<span class="badge ready">ready to automate</span>
									<span class="muted" title={automationDetail(d)}>{runPhrase(proposalCount, handled)}{d.leadingSuccessRun} approvals in a row · {d.approvalPct}% approved</span>
								{:else}
									<span class="badge manual">manual review</span>
									<span class="muted" title={automationDetail(d)}>{runPhrase(proposalCount, handled)}{automationGap(d)}</span>
								{/if}
							</div>
							<div class="mode-actions">
								{#if asReviewed && rd}
									<button class="mini show" onclick={() => (digestOpen = { ...digestOpen, [rKey]: !digestOpen[rKey] })}>
										{digestOpen[rKey] ? 'Hide' : 'Show'}
									</button>
									{#if handled}
										<button class="mini" onclick={() => undoDigestGroup(rd)}>Undo</button>
									{/if}
								{/if}
								<!-- Suspension is rule-level, so it outranks whatever the disposition says. -->
								{#if d.ruleStatus === 'suspended'}
									<button class="mini show" disabled={promotionBusy[key]} onclick={() => changePromotion(d, 'resume')}>Resume rule</button>
								{:else if d.status === 'auto'}
									{#if dg?.items.length}
										<button class="mini show" onclick={() => (digestOpen = { ...digestOpen, [key]: !digestOpen[key] })}>
											{digestOpen[key] ? 'Hide' : 'Show'}
										</button>
									{/if}
									<button class="mini" disabled={promotionBusy[key]} onclick={() => changePromotion(d, 'demote')}>Demote to manual</button>
								{:else if d.manualOnly}
									<button class="mini" disabled={promotionBusy[key]} onclick={() => changePromotion(d, 'unpin')}>Allow automation</button>
								{:else if d.eligible}
									<button class="btn primary" disabled={promotionBusy[key]} onclick={() => changePromotion(d, 'promote')}>Promote to automatic</button>
									<button class="mini" disabled={promotionBusy[key]} onclick={() => changePromotion(d, 'pin')}>Keep manual</button>
								{:else}
									<button class="mini" disabled={promotionBusy[key]} onclick={() => changePromotion(d, 'pin')}>Always manual</button>
								{/if}
							</div>
						</div>
						{#if dg && digestOpen[key]}
							{@render digestDetail(dg)}
						{/if}
						{#if rd && digestOpen[rKey]}
							{@render digestDetail(rd)}
						{/if}
					</div>
				{/each}
			</div>

			{#if g}
				<div class="manual-review">
					<p class="review-heading">
						<strong>Needs review</strong>
						<span class="muted">· {g.threads.length} thread(s)</span>
						{#if g.intent}
							<button
								class="link-btn"
								aria-expanded={intentOpen[g.versionId] ?? false}
								onclick={() => (intentOpen = { ...intentOpen, [g.versionId]: !intentOpen[g.versionId] })}
							>
								{intentOpen[g.versionId] ? 'Hide rule text' : 'What this rule does'}
							</button>
						{/if}
					</p>
					{#if g.intent && intentOpen[g.versionId]}<p class="intent">{g.intent}</p>{/if}
					{#each dispositionGroups(g) as sub (sub.action)}
						{#if g.tier === 'ai'}
							<div class="subhead"><span class="badge {sub.action}">{actionLabel[sub.action]}</span><span class="muted">{sub.items.length}</span></div>
						{/if}
						<ThreadList items={sub.items} dim={(t) => g.tier !== 'ai' && !isChecked(g, t.id)} onOpen={(t) => (viewingEmail = t)}>
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
				</div>
			{/if}
		</section>
		{/if}
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
	.workspace-top {
		position: sticky;
		top: 0;
		z-index: 10;
		margin: 0 -0.45rem 1rem;
		padding: 0.55rem 0.45rem;
		background: rgba(245, 246, 248, 0.94);
		backdrop-filter: blur(10px);
		border-bottom: 1px solid rgba(208, 213, 221, 0.8);
	}
	.bar {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
		margin-bottom: 0.5rem;
	}
	.jev-toggle {
		display: inline-flex;
		align-items: center;
		gap: 0.4rem;
		padding: 0.35rem 0.6rem;
		border: 1px solid #cfd4dc;
		border-radius: 6px;
		background: #fff;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.jev-toggle input { margin: 0; accent-color: #2f6df6; }
	.jev-toggle strong { color: #2f6df6; }
	.jev-toggle:has(input:disabled) { opacity: 0.65; cursor: default; }
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
	.run-strip {
		background: #fff;
		border: 1px solid #d0d5dd;
		border-radius: 8px;
		margin-bottom: 0.5rem;
		font-size: 0.82rem;
		overflow: hidden;
	}
	.rule-filters {
		display: flex;
		align-items: center;
		gap: 0.3rem;
		overflow-x: auto;
		padding-top: 0.05rem;
	}
	.filter-label {
		margin-right: 0.15rem;
		color: #667085;
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}
	.rule-filters button {
		display: inline-flex;
		align-items: center;
		gap: 0.35rem;
		border: 1px solid #d0d5dd;
		border-radius: 999px;
		background: #fff;
		color: #475467;
		padding: 0.25rem 0.55rem;
		font-size: 0.75rem;
		white-space: nowrap;
		cursor: pointer;
	}
	.rule-filters button span {
		color: #98a2b3;
		font-variant-numeric: tabular-nums;
	}
	.rule-filters button.active {
		border-color: #2f6df6;
		background: #eef4ff;
		color: #1849a9;
		font-weight: 700;
	}
	.rule-filters button.active span {
		color: #2f6df6;
	}
	.no-rule-hits {
		margin: 0 0 1rem;
		padding: 0.8rem;
		border: 1px dashed #d0d5dd;
		border-radius: 8px;
		color: #667085;
		font-size: 0.82rem;
		text-align: center;
	}
	.run-summary {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		padding: 0.48rem 0.65rem;
		border: 0;
		background: transparent;
		color: #344054;
		text-align: left;
		cursor: pointer;
	}
	.run-summary:disabled {
		cursor: default;
	}
	.run-state {
		display: grid;
		place-items: center;
		width: 1.1rem;
		height: 1.1rem;
		border-radius: 50%;
		background: #ecfdf3;
		color: #027a48;
		font-weight: 800;
	}
	.run-strip.running .run-state {
		background: #eef2ff;
		color: #3538cd;
		animation: spin 0.9s linear infinite;
	}
	.run-expand {
		margin-left: auto;
		color: #667085;
		font-size: 0.75rem;
	}
	.complete-label {
		padding: 0.08rem 0.38rem;
		border-radius: 999px;
		background: #ecfdf3;
		color: #027a48;
		font-size: 0.7rem;
		font-weight: 700;
	}
	.progress-track {
		height: 4px;
		background: #eaecf0;
		overflow: hidden;
	}
	.progress-fill {
		height: 100%;
		background: #12b76a;
		transition: width 0.25s ease;
	}
	.run-strip.running .progress-fill {
		background: #2f6df6;
	}
	.progress-fill.indeterminate {
		animation: progress-slide 1.1s ease-in-out infinite alternate;
	}
	@keyframes progress-slide {
		from { transform: translateX(-85%); }
		to { transform: translateX(185%); }
	}
	.progress-details {
		padding: 0.65rem;
		border-top: 1px solid #eaecf0;
		max-height: 55vh;
		overflow-y: auto;
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
	.rule-grid-wrap {
		overflow-x: auto;
		margin-top: 0.7rem;
		border: 1px solid #eaecf0;
		border-radius: 6px;
	}
	.rule-grid {
		display: grid;
		grid-template-columns: 17rem repeat(5, 4.5rem) 10rem;
		gap: 0;
		min-width: 49.5rem;
	}
	.rule-grid > div {
		padding: 0.35rem 0.45rem;
		border-bottom: 1px solid #f2f4f7;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
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

	/* --- Auto-apply: the "done automatically" receipt --- */
	.auto-digest {
		border-color: #b2ddc3;
		background: #f6fefa;
	}
	.badge.flagged {
		background: #fffaeb;
		color: #b54708;
	}
	.badge.failed {
		background: #fef3f2;
		color: #b42318;
	}
	.badge.auto {
		background: #ecfdf3;
		color: #027a48;
	}
	.badge.pinned {
		background: #f2f4f7;
		color: #475467;
	}
	.badge.manual {
		background: #f2f4f7;
		color: #475467;
	}
	.badge.ready {
		background: #fffaeb;
		color: #b54708;
	}
	.rule-card {
		padding-bottom: 0.75rem;
	}

	/* Autopilot receipt: a finished sentence, not a control panel. */
	.receipt-card {
		background: #f8fefb;
		border-color: #cdeadb;
		padding: 0.5rem 0.75rem;
		margin-bottom: 0.5rem;
	}
	.link-btn {
		border: none;
		background: none;
		padding: 0;
		margin-left: 0.45rem;
		color: #2f6df6;
		font-size: 0.78rem;
		cursor: pointer;
	}
	.receipt-card.idle {
		background: #fff;
		border-color: #eaecf0;
	}
	.receipt-head {
		font-size: 0.86rem;
		margin-bottom: 0.15rem;
	}
	.receipt + .receipt {
		margin-top: 0.3rem;
		border-top: 1px solid #e4f3ea;
		padding-top: 0.3rem;
	}
	.receipt-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.receipt-line {
		margin: 0;
		font-size: 0.88rem;
		color: #101828;
		min-width: 0;
	}
	.mode-summary .receipt-line {
		font-size: inherit;
	}
	.receipt-line.idle {
		color: #667085;
	}
	.receipt-line em {
		color: #667085;
	}
	.receipt-line .cross {
		color: #98a2b3;
		font-weight: 700;
		margin-right: 0.1rem;
	}
	.receipt-line .tick {
		color: #12b76a;
		font-weight: 700;
		margin-right: 0.1rem;
	}
	.receipt-line .verb.trash {
		color: #b42318;
	}
	.receipt-line .verb.archive {
		color: #027a48;
	}
	.receipt-line .verb.label_todo,
	.receipt-line .verb.mark_read {
		color: #b54708;
	}
	.receipt-actions {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-shrink: 0;
	}
	.mini.show {
		border-color: #2f6df6;
		color: #2f6df6;
		font-weight: 600;
	}
	.receipt p.mode-warning {
		margin: 0.15rem 0 0;
	}
	.receipt .digest-detail {
		margin-top: 0.35rem;
		border-radius: 6px;
		border: 1px solid #e4f3ea;
		padding: 0 0.55rem 0.4rem;
	}
	.rule-modes {
		margin-top: 0.55rem;
		border: 1px solid #eaecf0;
		border-radius: 8px;
		overflow: hidden;
	}
	.rule-mode + .rule-mode {
		border-top: 1px solid #eaecf0;
	}
	.rule-mode.auto {
		background: #f6fefa;
	}
	.rule-mode.ready {
		background: #fffcf5;
	}
	/* A reviewed receipt reads like autopilot's, but cooler than its green. */
	.rule-mode.reviewed {
		background: #f8fbff;
	}
	.digest-list li.untouched .subject,
	.digest-list li.untouched .from {
		color: #667085;
	}
	.mode-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.75rem;
		padding: 0.45rem 0.55rem;
		font-size: 0.82rem;
	}
	.mode-summary {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		flex-wrap: wrap;
		min-width: 0;
	}
	.mode-actions {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-shrink: 0;
	}
	.mode-warning {
		color: #b54708;
		font-size: 0.75rem;
	}
	.digest-detail {
		position: relative;
		padding: 0 0.55rem 0.4rem;
		border-top: 1px solid #d3f0e0;
		background: #fff;
	}
	.undo-all {
		margin-top: 0.4rem;
	}
	.manual-review {
		margin-top: 0.7rem;
		padding-top: 0.65rem;
		border-top: 1px solid #eaecf0;
	}
	.review-heading {
		margin: 0 0 0.35rem;
		font-size: 0.86rem;
	}
	.digest-list {
		list-style: none;
		margin: 0.3rem 0 0.2rem;
		padding: 0;
	}
	.digest-list li {
		border-top: 1px solid #f2f4f7;
		padding: 0.3rem 0;
	}
	.digest-list li.undone {
		opacity: 0.55;
	}
	.digest-list li.failed {
		background: #fffbfa;
	}
	.digest-item {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.6rem;
	}
	.digest-text {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 0.4rem;
		min-width: 0;
		font-size: 0.8rem;
	}
	.digest-text .from {
		color: #475467;
		font-weight: 600;
		max-width: 14rem;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.digest-text .subject {
		color: #101828;
	}
	.digest-text .reason {
		color: #98a2b3;
		font-style: italic;
		flex-basis: 100%;
	}
	.digest-actions {
		display: flex;
		align-items: center;
		gap: 0.4rem;
		flex-shrink: 0;
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

<script lang="ts">
  import { onMount } from 'svelte';
  import V3Row from '$lib/components/V3Row.svelte';
  import Icon from '$lib/components/v3/Icon.svelte';
  import type { ReviewDecision, ReviewItem } from '$lib/types/v3';
  import {
    ACTION_LABEL, APPLIED_LABEL, buildSections, bulkLabel, choiceOf, decide, needsSeen, parseSender, suggestionOf,
    type Choice, type SectionKey, type Subgroup
  } from '$lib/v3/review';

  type Run = { id: string; status: string; started_at: number; ended_at: number | null };
  type Policy = { id: string; version_no: number; text: string; import_report: string | null };
  type RunData = {
    run: Run | null; policy: Policy | null; items: ReviewItem[]; calls: unknown[]; steps: unknown[];
    replay?: { sourceRunId: string; assessedAt: number } | null; deterministicRules?: { name: string; version: number }[];
  };
  type Notice = { text: string; tone: 'info' | 'success' | 'error' };
  const EMPTY: RunData = { run: null, policy: null, items: [], calls: [], steps: [] };
  const KEY_CHOICE: Record<string, Choice> = { t: 'label_todo', e: 'archive', '#': 'trash', Delete: 'trash', Backspace: 'trash', l: 'leave', d: 'done' };
  const TALLY_ORDER: Choice[] = ['label_todo', 'archive', 'trash', 'leave', 'done'];

  let accounts = $state<string[]>([]);
  let accountId = $state('');
  let data = $state<RunData>(EMPTY);
  let loaded = $state(false);
  let drafts = $state<Record<string, ReviewDecision>>({});
  let open = $state<Record<string, boolean>>({});
  let collapsed = $state<Record<string, boolean>>({});
  let focusedId = $state<string | null>(null);
  let busy = $state(false);
  let notice = $state<Notice | null>(null);
  let showPolicy = $state(false);
  let showKeys = $state(false);

  const model = $derived(buildSections(data.items));
  const live = $derived(model.sections.flatMap((s) => s.rows));
  const liveById = $derived(new Map(live.map((i) => [i.id, i])));
  const pending = $derived(Object.values(drafts));
  const running = $derived(data.run?.status === 'running');
  const canApply = $derived(!!pending.length && !busy && data.run?.status === 'completed');
  const anyApplied = $derived(model.reviewed.some((i) => i.action_status === 'applied'));
  const policyParagraphs = $derived((data.policy?.text ?? '').split(/\n\s*\n/).map((p) => {
    const m = p.match(/^([A-Z][\w ,/&-]{2,40}):\s+([\s\S]*)$/);
    return m ? { label: m[1], text: m[2] } : { label: null, text: p };
  }));
  const importInfo = $derived.by(() => { try { return data.policy?.import_report ? JSON.parse(data.policy.import_report) : null; } catch { return null; } });
  const tally = $derived(TALLY_ORDER.map((c) => ({ choice: c, n: pending.filter((d) => choiceOf(d) === c).length })).filter((t) => t.n));
  // Keyboard order follows the page, skipping rows inside collapsed groups.
  const order = $derived(model.sections.flatMap((s) => s.groups
    ? s.groups.flatMap((g) => (groupCollapsed(s.def.key, g) ? [] : g.rows))
    : s.rows).map((r) => r.id));

  onMount(() => {
    void (async () => {
      const response = await fetch('/api/accounts');
      if (!response.ok) { notice = { text: 'Could not load connected Gmail accounts.', tone: 'error' }; loaded = true; return; }
      accounts = (await response.json()).accounts;
      const saved = localStorage.getItem('mailward-account');
      accountId = saved && accounts.includes(saved) ? saved : accounts[0] || '';
      if (accountId) { localStorage.setItem('mailward-account', accountId); await refresh(); }
      loaded = true;
    })();
    const timer = setInterval(() => { if (accountId && running) void refresh(); }, 2000);
    return () => clearInterval(timer);
  });

  async function refresh() {
    const response = await fetch(`/api/v3/run?accountId=${encodeURIComponent(accountId)}`);
    if (!response.ok) { notice = { text: (await response.json()).error || 'Could not load your inbox review.', tone: 'error' }; return; }
    const previousRun = data.run?.id;
    data = await response.json();
    // Unapplied decisions survive a reload of the same run; drop any whose row
    // was reviewed or left the run.
    const saved = previousRun === data.run?.id ? drafts : { ...restoreDrafts(data.run?.id), ...drafts };
    const liveIds = new Set(data.items.filter((i) => !i.review_kind).map((i) => i.id));
    drafts = Object.fromEntries(Object.entries(saved).filter(([id]) => liveIds.has(id)));
  }
  const draftKey = (runId: string) => `mailward-drafts:${runId}`;
  function restoreDrafts(runId: string | undefined): Record<string, ReviewDecision> {
    if (!runId) return {};
    try { return JSON.parse(localStorage.getItem(draftKey(runId)) ?? '{}'); } catch { return {}; }
  }
  $effect(() => {
    const runId = data.run?.id;
    if (!runId) return;
    try {
      if (pending.length) localStorage.setItem(draftKey(runId), JSON.stringify(drafts));
      else localStorage.removeItem(draftKey(runId));
    } catch { /* storage unavailable: drafts stay in memory */ }
  });

  function switchAccount(next: string) {
    if (pending.length && !confirm(`Discard ${pending.length} unapplied decision${pending.length === 1 ? '' : 's'}?`)) return;
    accountId = next; localStorage.setItem('mailward-account', next);
    drafts = {}; open = {}; focusedId = null; data = EMPTY; loaded = false;
    void refresh().then(() => (loaded = true));
  }

  async function start() {
    if (pending.length && !confirm(`You have ${pending.length} unapplied decision${pending.length === 1 ? '' : 's'}. Check for new mail anyway? Decisions on threads that change will be dropped.`)) return;
    busy = true; notice = null;
    try {
      const response = await fetch(`/api/v3/run?accountId=${encodeURIComponent(accountId)}`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'The check could not start.');
      await refresh();
    } catch (error) { notice = { text: error instanceof Error ? error.message : String(error), tone: 'error' }; }
    finally { busy = false; }
  }

  function choose(item: ReviewItem, choice: Choice | null) {
    if (!choice) { const { [item.id]: _, ...rest } = drafts; drafts = rest; return; }
    const next = decide(item, choice, drafts[item.id]);
    // Choosing on a visible row is the reviewer's acknowledgement that they saw it.
    drafts = { ...drafts, [item.id]: needsSeen(item, next) ? { ...next, acknowledged: true } : next };
  }
  function patch(item: ReviewItem, change: Partial<ReviewDecision>) {
    const current = drafts[item.id];
    if (!current) return;
    const next = { ...current, ...change };
    drafts = { ...drafts, [item.id]: needsSeen(item, next) ? { ...next, acknowledged: true } : next };
  }
  function acceptAll(rows: ReviewItem[]) {
    for (const row of rows) {
      const s = suggestionOf(row);
      if (!drafts[row.id] && s?.firm) choose(row, s.choice);
    }
  }
  function clearAll(rows: ReviewItem[]) {
    const ids = new Set(rows.map((r) => r.id));
    drafts = Object.fromEntries(Object.entries(drafts).filter(([id]) => !ids.has(id)));
  }
  const undecidedFirm = (rows: ReviewItem[]) => rows.filter((r) => !drafts[r.id] && suggestionOf(r)?.firm);
  const decidedCount = (rows: ReviewItem[]) => rows.filter((r) => drafts[r.id]).length;

  function groupCollapsed(section: SectionKey, g: Subgroup) { return collapsed[`${section}:${g.key}`] ?? g.rule; }
  function toggleGroup(section: SectionKey, g: Subgroup) { collapsed = { ...collapsed, [`${section}:${g.key}`]: !groupCollapsed(section, g) }; }
  function senders(rows: ReviewItem[]) {
    const names = [...new Set(rows.map((r) => parseSender(r.representation.messages[0]?.from ?? '').name))];
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
  }

  async function submit() {
    if (!canApply || !data.run) return;
    busy = true; notice = null;
    try {
      const response = await fetch(`/api/v3/review?accountId=${encodeURIComponent(accountId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: data.run.id, decisions: pending })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Gmail was not changed: the review could not be applied.');
      const outcomes = result.results as { assessmentId: string; status: string }[];
      const byId = new Map(pending.map((d) => [d.assessmentId, d]));
      const counts = new Map<string, number>();
      let failed = 0;
      for (const o of outcomes) {
        if (o.status === 'failed') { failed++; continue; }
        const d = byId.get(o.assessmentId);
        const target = d?.kind === 'done' ? d.finalDisposition ?? 'leave' : d?.disposition ?? 'leave';
        counts.set(target, (counts.get(target) ?? 0) + 1);
      }
      const parts = [...counts].map(([target, n]) => `${n} ${APPLIED_LABEL[target as keyof typeof APPLIED_LABEL].toLowerCase()}`);
      drafts = {};
      notice = failed
        ? { text: `Applied with ${failed} failure${failed === 1 ? '' : 's'}: ${parts.join(', ') || 'nothing else changed'}. See Applied in this review.`, tone: 'error' }
        : { text: `Applied: ${parts.join(', ')}.`, tone: 'success' };
      await refresh();
    } catch (error) { notice = { text: error instanceof Error ? error.message : String(error), tone: 'error' }; }
    finally { busy = false; }
  }
  async function undo(body: { actionId: string } | { runId: string }) {
    busy = true; notice = null;
    try {
      const response = await fetch(`/api/v3/undo?accountId=${encodeURIComponent(accountId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if ('actionId' in body && (!response.ok || result.status !== 'applied')) throw new Error(result.error || 'Undo failed.');
      if (!response.ok) throw new Error(result.error || 'Undo failed.');
      if ('runId' in body) notice = { text: `Undid ${result.undone} change${result.undone === 1 ? '' : 's'}${result.failed ? `; ${result.failed} could not be undone` : ''}.`, tone: result.failed ? 'error' : 'success' };
      await refresh();
    } catch (error) { notice = { text: error instanceof Error ? error.message : String(error), tone: 'error' }; }
    finally { busy = false; }
  }

  function focusRow(id: string | undefined) {
    if (!id) return;
    focusedId = id;
    const el = document.querySelector<HTMLElement>(`[data-row="${id}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest' });
  }
  function move(step: number) {
    const i = focusedId ? order.indexOf(focusedId) : -1;
    focusRow(order[i < 0 ? (step > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, i + step))]);
  }
  function onKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (e.metaKey || e.ctrlKey || e.altKey || target.closest('input, textarea, select, [contenteditable]')) return;
    if (!data.run || busy) return;
    if (e.key === '?') { showKeys = !showKeys; e.preventDefault(); return; }
    if (e.key === 'Escape') { if (focusedId && open[focusedId]) open = { ...open, [focusedId]: false }; else showKeys = false; return; }
    if (e.key === 'j' || e.key === 'k') { move(e.key === 'j' ? 1 : -1); e.preventDefault(); return; }
    const item = focusedId ? liveById.get(focusedId) : undefined;
    if (!item) return;
    const onButton = target.closest('button, a');
    if (e.key in KEY_CHOICE) { choose(item, KEY_CHOICE[e.key]); move(1); }
    else if (e.key === 'y') { const s = suggestionOf(item); if (!s) return; choose(item, s.choice); move(1); }
    else if (e.key === 'u') choose(item, null);
    else if (e.key === 'o' || (e.key === 'Enter' && !onButton)) open = { ...open, [item.id]: !open[item.id] };
    else return;
    e.preventDefault();
  }
  function jump(key: string) {
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(`sec-${key}`)?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' });
  }
  function when(time: number) {
    const d = new Date(time);
    const today = new Date();
    const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === today.toDateString()) return `today at ${hm}`;
    if (d.toDateString() === new Date(today.getTime() - 86_400_000).toDateString()) return `yesterday at ${hm}`;
    return `on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} at ${hm}`;
  }
  $effect(() => {
    if (notice?.tone !== 'success') return;
    const current = notice;
    const timer = setTimeout(() => { if (notice === current) notice = null; }, 7000);
    return () => clearTimeout(timer);
  });
</script>

<svelte:head><title>{pending.length ? `(${pending.length}) ` : ''}Inbox review · Mailward</title></svelte:head>
<svelte:window onkeydown={onKeydown} />

<main>
  <header class="top">
    <strong class="brand">Mailward</strong>
    {#if accounts.length > 1}
      <select class="account" aria-label="Gmail account" value={accountId} onchange={(e) => switchAccount(e.currentTarget.value)}>
        {#each accounts as account}<option value={account}>{account}</option>{/each}
      </select>
    {:else if accountId}<span class="account">{accountId}</span>{/if}
    {#if data.run}
      <span class="runinfo">
        {#if running}<span class="spinner" aria-hidden="true"></span> Checking unread mail…
        {:else}{data.items.length} unread thread{data.items.length === 1 ? '' : 's'}, assessed {when(data.replay?.assessedAt ?? data.run.started_at)}{#if data.replay}<span class="replay" title="These assessments were replayed from an earlier run">replay</span>{/if}{/if}
      </span>
    {/if}
    <span class="spacer"></span>
    {#if data.policy}<button class="quiet" aria-expanded={showPolicy} onclick={() => (showPolicy = !showPolicy)}>Policy v{data.policy.version_no}</button>{/if}
    {#if data.run}<button class="btn" disabled={!accountId || busy || running} onclick={start}><Icon name="refresh" size={13} /> Check for new mail</button>{/if}
  </header>

  {#if showPolicy && data.policy}
    <section class="policy" aria-label="Assessment policy">
      <p class="lede">Jev reads each thread against this versioned policy. Your review feedback can help refine it. Nothing changes in Gmail until you apply your decisions.
        {#if data.deterministicRules?.length} Fixed rules ({data.deterministicRules.map((r) => `${r.name} v${r.version}`).join(', ')}) propose trash without asking Jev.{/if}</p>
      <div class="policytext">
        {#each policyParagraphs as p}<p>{#if p.label}<strong>{p.label}.</strong>{' '}{/if}{p.text}</p>{/each}
      </div>
      {#if importInfo}<details><summary>Policy history</summary><pre>{JSON.stringify(importInfo, null, 2)}</pre></details>{/if}
    </section>
  {/if}

  {#if data.run?.status === 'reauth_required'}
    <p class="banner warn">Gmail signed Mailward out. <a href="/auth">Reconnect Gmail</a>, then check for new mail.</p>
  {:else if data.run?.status === 'failed'}
    <p class="banner warn">The last check stopped before finishing. Rows below are what it assessed. <button class="linkish" onclick={start}>Check again</button></p>
  {:else if running}
    <p class="banner">Jev is assessing new threads. Rows appear as they are ready; you can apply once the check finishes.</p>
  {/if}

  {#if !loaded}
    <div class="sheet placeholder" aria-busy="true"><span class="spinner"></span> Loading your review…</div>
  {:else if !accounts.length}
    <div class="sheet welcome"><h2>Connect Gmail to start</h2><p>Mailward reads your unread mail, suggests what needs you and what can be cleared, and changes nothing until you apply.</p><a class="btn primary" href="/auth">Connect Gmail</a></div>
  {:else if !data.run}
    <div class="sheet welcome"><h2>Review your unread mail</h2><p>Jev sorts unread threads into what needs action, what is worth reading and what can be cleared. You decide each one; nothing changes in Gmail until you apply.</p><button class="btn primary" disabled={busy} onclick={start}>Check unread mail</button></div>
  {:else}
    <nav class="jump" aria-label="Sections">
      {#each model.sections as s (s.def.key)}
        {@const done = decidedCount(s.rows)}
        <button class="jumpto {s.def.key}" class:empty={!s.rows.length} class:complete={s.rows.length > 0 && done === s.rows.length} disabled={!s.rows.length} onclick={() => jump(s.def.key)}
          title={s.rows.length ? `${done} of ${s.rows.length} decided` : 'Nothing here'}>
          <span class="marker"></span>{s.def.title}<span class="n">{s.rows.length}</span>
          {#if s.rows.length}<span class="fill" style:width="{(done / s.rows.length) * 100}%"></span>{/if}
        </button>
      {/each}
      {#if model.reviewed.length}<button class="jumpto reviewed" onclick={() => jump('reviewed')}><span class="marker"></span>Applied<span class="n">{model.reviewed.length}</span></button>{/if}
    </nav>

    <div class="sheet">
      {#each model.sections as s (s.def.key)}
        {#if s.rows.length}
          {@const firm = undecidedFirm(s.rows)}
          {@const done = decidedCount(s.rows)}
          <section id="sec-{s.def.key}" class="section {s.def.key}" aria-labelledby="h-{s.def.key}">
            <header class="band">
              <span class="marker"></span>
              <h2 id="h-{s.def.key}">{s.def.title}</h2>
              <span class="n">{s.rows.length}</span>
              <span class="hint">{s.def.hint}</span>
              <span class="spacer"></span>
              {#if done}<span class="progress">{done} of {s.rows.length} decided</span>{/if}
              {#if s.def.bulk && firm.length}
                <button class="bulk {s.def.bulk}" onclick={() => acceptAll(s.rows)}>{bulkLabel(s.def.bulk, firm.length, firm.length === s.rows.length)}</button>
              {:else if done}
                <button class="quiet" onclick={() => clearAll(s.rows)}>Clear</button>
              {/if}
            </header>
            {#if s.groups}
              {#each s.groups as g (g.key)}
                {@const shut = groupCollapsed(s.def.key, g)}
                {@const gfirm = undecidedFirm(g.rows)}
                {@const gdone = decidedCount(g.rows)}
                <div class="group" class:shut>
                  <button class="grouphead" aria-expanded={!shut} onclick={() => toggleGroup(s.def.key, g)}>
                    <span class="chev"><Icon name="chevron" size={12} /></span>
                    <span class="gicon"><Icon name={g.icon} size={13} /></span>
                    <span class="gtitle">{g.title}</span><span class="n">{g.rows.length}</span>
                    {#if g.hint}<span class="hint">{g.hint}</span>{/if}
                    {#if shut}<span class="names">{senders(g.rows)}</span>{/if}
                  </button>
                  {#if gdone}<span class="progress">{gdone === g.rows.length ? 'All decided' : `${gdone} of ${g.rows.length}`}</span>{/if}
                  {#if s.def.bulk && gfirm.length && s.groups.length > 1}
                    <button class="minibulk {s.def.bulk}" onclick={() => acceptAll(g.rows)}>{ACTION_LABEL[s.def.bulk]} {gfirm.length}</button>
                  {/if}
                </div>
                {#if !shut}
                  {#each g.rows as item (item.id)}
                    <V3Row {item} section={s.def.key} {accountId} draft={drafts[item.id]} focused={focusedId === item.id} expanded={!!open[item.id]}
                      onToggle={() => (open = { ...open, [item.id]: !open[item.id] })} onChoose={(c) => choose(item, c)} onPatch={(p) => patch(item, p)}
                      onUndo={(actionId) => undo({ actionId })} onFocus={() => (focusedId = item.id)} />
                  {/each}
                {/if}
              {/each}
            {:else}
              {#each s.rows as item (item.id)}
                <V3Row {item} section={s.def.key} {accountId} draft={drafts[item.id]} focused={focusedId === item.id} expanded={!!open[item.id]}
                  onToggle={() => (open = { ...open, [item.id]: !open[item.id] })} onChoose={(c) => choose(item, c)} onPatch={(p) => patch(item, p)}
                  onUndo={(actionId) => undo({ actionId })} onFocus={() => (focusedId = item.id)} />
              {/each}
            {/if}
          </section>
        {/if}
      {/each}

      {#if !live.length && !running}
        <div class="allclear"><Icon name="check" size={18} /><div><strong>Every thread in this review has been handled.</strong> Check for new mail when more arrives.</div></div>
      {/if}

      {#if model.reviewed.length}
        <section id="sec-reviewed" class="section reviewed" aria-labelledby="h-reviewed">
          <header class="band">
            <span class="marker"></span>
            <h2 id="h-reviewed">Applied in this review</h2>
            <span class="n">{model.reviewed.length}</span>
            <span class="hint">What changed in Gmail; each change can be undone</span>
            <span class="spacer"></span>
            {#if anyApplied}<button class="quiet" disabled={busy} onclick={() => data.run && undo({ runId: data.run.id })}>Undo all</button>{/if}
          </header>
          {#each model.reviewed as item (item.id)}
            <V3Row {item} section={null} {accountId} expanded={!!open[item.id]} onToggle={() => (open = { ...open, [item.id]: !open[item.id] })}
              onChoose={() => {}} onPatch={() => {}} onUndo={(actionId) => undo({ actionId })} onFocus={() => (focusedId = item.id)} />
          {/each}
        </section>
      {/if}
    </div>

    <details class="rundetails"><summary>Run details</summary><pre>{JSON.stringify({ stages: data.steps, calls: data.calls }, null, 2)}</pre></details>
  {/if}

  {#if notice}
    <div class="notice {notice.tone}" role={notice.tone === 'error' ? 'alert' : 'status'}>
      <span>{notice.text}</span><button class="close" aria-label="Dismiss" onclick={() => (notice = null)}>×</button>
    </div>
  {/if}

  {#if data.run && (live.length || pending.length)}
    <footer class="applybar">
      <div class="count"><strong>{pending.length}</strong> of {live.length} decided</div>
      <div class="tally" aria-label="Decisions by action">
        {#each tally as t (t.choice)}<span class="t {t.choice}"><i></i>{t.n} {ACTION_LABEL[t.choice]}</span>{/each}
      </div>
      <span class="spacer"></span>
      <div class="keys-wrap">
        <button class="quiet" aria-expanded={showKeys} onclick={() => (showKeys = !showKeys)}>Shortcuts</button>
        {#if showKeys}
          <div class="keys" role="dialog" aria-label="Keyboard shortcuts">
            <p><kbd>j</kbd><kbd>k</kbd> next / previous</p>
            <p><kbd>y</kbd> accept Jev's suggestion</p>
            <p><kbd>t</kbd> TODO <kbd>e</kbd> archive <kbd>#</kbd> trash</p>
            <p><kbd>l</kbd> leave <kbd>d</kbd> done <kbd>u</kbd> clear</p>
            <p><kbd>o</kbd> open or close <kbd>?</kbd> this list</p>
          </div>
        {/if}
      </div>
      <button class="btn primary" disabled={!canApply} onclick={submit}>
        {busy ? 'Applying…' : pending.length ? `Apply ${pending.length} decision${pending.length === 1 ? '' : 's'}` : 'Apply decisions'}
      </button>
    </footer>
  {/if}
</main>

<style>
  main { --who-width: 11.5rem; max-width: 1240px; margin: 0 auto; padding-bottom: .6rem; font-size: 13px; }
  .spacer { flex: 1; }

  .top { display: flex; align-items: center; gap: .9rem; min-height: 52px; flex-wrap: wrap; }
  .brand { font-size: 15px; font-weight: 750; letter-spacing: -.01em; }
  .account { color: var(--ink-2); font: inherit; font-size: 12.5px; }
  select.account { height: 28px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--surface); padding: 0 .4rem; }
  .runinfo { display: inline-flex; align-items: center; gap: .4rem; color: var(--ink-3); font-size: 12.5px; }
  .replay { padding: 0 5px; border: 1px solid var(--line-strong); border-radius: 4px; font-size: 11px; color: var(--ink-3); }

  .btn { display: inline-flex; align-items: center; gap: .4rem; white-space: nowrap; height: 30px; padding: 0 .8rem; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--surface); color: var(--ink); font: inherit; font-size: 12.5px; font-weight: 600; text-decoration: none; cursor: pointer; }
  .btn:hover:not(:disabled) { border-color: var(--ink-4); }
  .btn.primary { border-color: var(--ink); background: var(--ink); color: #fff; }
  .btn.primary:hover:not(:disabled) { background: #2a3445; }
  .btn:disabled { opacity: .45; cursor: default; }
  .quiet { height: 28px; padding: 0 .55rem; border: 0; border-radius: 6px; background: none; color: var(--ink-3); font: inherit; font-size: 12.5px; font-weight: 550; text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; }
  .quiet:hover:not(:disabled), .quiet[aria-expanded='true'] { background: var(--sunken); color: var(--ink); }
  .quiet:disabled { opacity: .45; cursor: default; }
  button:focus-visible, a:focus-visible, select:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }

  .policy { margin: 0 0 .9rem; padding: .9rem 1.1rem; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
  .lede { margin: 0 0 .7rem; color: var(--ink-2); max-width: 80ch; line-height: 1.5; }
  .policytext { columns: 2 34ch; column-gap: 2rem; color: var(--ink-2); font-size: 12.5px; line-height: 1.55; }
  .policytext p { margin: 0 0 .7rem; break-inside: avoid; }
  .policytext strong { color: var(--ink); }
  .policy details summary { cursor: pointer; color: var(--ink-3); font-size: 12px; }
  .policy pre, .rundetails pre { max-height: 24rem; overflow: auto; padding: .7rem; border-radius: 6px; background: var(--sunken); font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }

  .banner { margin: 0 0 .7rem; padding: .5rem .8rem; border-radius: 8px; background: var(--sunken); color: var(--ink-2); }
  .banner.warn { background: var(--warn-bg); color: var(--warn); }
  .banner a, .linkish { color: inherit; font: inherit; font-weight: 650; background: none; border: 0; padding: 0; text-decoration: underline; cursor: pointer; }

  /* Section identity: where the mail is headed. Filled marker = firm, hollow = optional or conditional. */
  .needs_action, .worth_reading { --sec: var(--todo); }
  .decision { --sec: var(--warn); }
  .show_me, .trash { --sec: var(--trash); }
  .archive { --sec: var(--archive); }
  .reviewed { --sec: var(--ink-4); }
  .marker { width: 8px; height: 8px; flex-shrink: 0; border-radius: 50%; background: var(--sec); }
  .worth_reading .marker, .show_me .marker, .reviewed .marker { background: transparent; box-shadow: inset 0 0 0 2px var(--sec); }

  .jump { display: flex; flex-wrap: wrap; gap: .35rem; margin: 0 0 .6rem; }
  .jumpto { position: relative; display: inline-flex; align-items: center; gap: .45rem; height: 30px; padding: 0 .7rem; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); color: var(--ink-2); font: inherit; font-size: 12.5px; font-weight: 550; white-space: nowrap; cursor: pointer; overflow: hidden; }
  .jumpto:hover:not(:disabled) { border-color: var(--line-strong); color: var(--ink); }
  .jumpto .n { color: var(--ink); font-weight: 700; font-variant-numeric: tabular-nums; }
  .jumpto.empty { opacity: .5; cursor: default; }
  .jumpto.empty .n { color: var(--ink-3); font-weight: 550; }
  .jumpto .fill { position: absolute; left: 0; bottom: 0; height: 2px; background: var(--sec); transition: width .2s; }
  .jumpto.complete { color: var(--ink-3); }

  .sheet { border: 1px solid var(--line); border-radius: 10px; background: var(--surface); overflow: clip; }
  .placeholder, .welcome { padding: 2rem 1.5rem; color: var(--ink-3); }
  .placeholder { display: flex; align-items: center; gap: .6rem; }
  .welcome h2 { margin: 0 0 .4rem; font-size: 17px; color: var(--ink); }
  .welcome p { max-width: 60ch; margin: 0 0 1.1rem; line-height: 1.55; color: var(--ink-2); }

  .section + .section .band, .section.reviewed .band { border-top: 1px solid var(--line-strong); }
  .band {
    position: sticky; top: 0; z-index: 5;
    display: flex; align-items: center; gap: .55rem;
    min-height: 40px; padding: 0 .6rem 0 .8rem;
    background: color-mix(in srgb, var(--sec) 4%, var(--surface));
  }
  .band h2 { margin: 0; font-size: 13.5px; font-weight: 700; letter-spacing: -.005em; }
  .band .n { color: var(--ink-3); font-weight: 600; font-variant-numeric: tabular-nums; }
  .band .hint { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-3); font-size: 12px; }
  .progress { color: var(--ink-3); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .bulk, .minibulk { --c: var(--ink-2); flex-shrink: 0; height: 26px; padding: 0 .7rem; border: 1px solid color-mix(in srgb, var(--c) 45%, transparent); border-radius: 6px; background: var(--surface); color: var(--c); font: inherit; font-size: 12px; font-weight: 650; cursor: pointer; white-space: nowrap; }
  .bulk:hover, .minibulk:hover { background: var(--c); border-color: var(--c); color: #fff; }
  .bulk.label_todo { --c: var(--todo); } .bulk.archive, .minibulk.archive { --c: var(--archive); } .bulk.trash, .minibulk.trash { --c: var(--trash); }
  .minibulk { height: 22px; padding: 0 .55rem; font-size: 11.5px; }

  .group { display: flex; align-items: center; gap: .5rem; padding-right: .6rem; border-top: 1px solid var(--line); background: var(--surface); }
  .grouphead { display: flex; align-items: center; gap: .45rem; flex: 1; min-width: 0; height: 32px; padding: 0 0 0 .75rem; border: 0; background: none; color: var(--ink-2); font: inherit; font-size: 12.5px; text-align: left; cursor: pointer; }
  .grouphead:hover .gtitle { color: var(--ink); }
  .chev { display: flex; width: 12px; color: var(--ink-4); transform: rotate(90deg); transition: transform .15s; }
  .shut .chev { transform: none; }
  .gicon { display: flex; color: var(--ink-3); margin-left: .45rem; }
  .gtitle { font-weight: 650; color: var(--ink-2); }
  .grouphead .n { color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .grouphead .hint { color: var(--ink-4); font-size: 12px; white-space: nowrap; }
  .names { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink-3); font-size: 12px; }
  .names::before { content: '— '; color: var(--ink-4); }

  .allclear { display: flex; align-items: center; gap: .7rem; padding: 1.2rem 1rem; color: var(--done); }
  .allclear div { color: var(--ink-2); }
  .allclear strong { color: var(--ink); }

  .rundetails { margin: .7rem 0 0; color: var(--ink-4); font-size: 12px; }
  .rundetails summary { cursor: pointer; width: max-content; }

  .applybar {
    position: sticky; bottom: .6rem; z-index: 10;
    display: flex; align-items: center; gap: 1rem;
    margin-top: .8rem; padding: .55rem .6rem .55rem .9rem;
    border: 1px solid var(--line-strong); border-radius: 10px;
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    backdrop-filter: blur(8px);
    box-shadow: 0 6px 24px -12px rgb(24 32 44 / 35%);
  }
  .applybar .count { color: var(--ink-2); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .applybar .count strong { color: var(--ink); font-size: 14px; }
  .tally { display: flex; gap: .8rem; flex-wrap: wrap; }
  .t { display: inline-flex; align-items: center; gap: .3rem; color: var(--ink-2); font-size: 12px; font-weight: 550; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .t i { width: 8px; height: 8px; border-radius: 2px; background: var(--c); }
  .t.label_todo { --c: var(--todo); } .t.archive { --c: var(--archive); } .t.trash { --c: var(--trash); } .t.leave { --c: var(--leave); } .t.done { --c: var(--done); }
  .keys-wrap { position: relative; }
  .keys { position: absolute; right: 0; bottom: calc(100% + .6rem); width: 17rem; padding: .7rem .9rem; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); box-shadow: 0 8px 28px -10px rgb(24 32 44 / 35%); color: var(--ink-2); font-size: 12px; }
  .keys p { margin: .25rem 0; }
  kbd { display: inline-block; min-width: 1.2em; margin-right: .2rem; padding: 0 .3rem; border: 1px solid var(--line-strong); border-bottom-width: 2px; border-radius: 4px; background: var(--paper); font: 600 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; text-align: center; color: var(--ink); }

  .notice { position: fixed; left: 50%; bottom: 5.2rem; z-index: 20; transform: translateX(-50%); display: flex; align-items: center; gap: .8rem; max-width: min(40rem, calc(100vw - 2rem)); padding: .55rem .6rem .55rem .9rem; border-radius: 8px; background: var(--ink); color: #fff; box-shadow: 0 10px 30px -10px rgb(24 32 44 / 50%); font-size: 12.5px; }
  .notice.error { background: #8f1d33; }
  .notice .close { border: 0; background: none; color: inherit; font-size: 16px; line-height: 1; cursor: pointer; opacity: .7; }
  .notice .close:hover { opacity: 1; }

  .spinner { width: 12px; height: 12px; border: 2px solid var(--line-strong); border-top-color: var(--focus); border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } .chev, .jumpto .fill { transition: none; } }

  @media (max-width: 1000px) {
    main { --who-width: 9.5rem; }
    .band .hint, .grouphead .hint { display: none; }
    .runinfo { order: 5; flex-basis: 100%; margin-top: -.6rem; padding-bottom: .5rem; }
  }
  @media (max-width: 720px) {
    .top { gap: .5rem; padding: .4rem 0; }
    .runinfo { margin-top: 0; }
    .jump { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; margin-inline: -1rem; padding-inline: 1rem; }
    .jumpto { flex-shrink: 0; }
    .applybar { flex-wrap: wrap; gap: .5rem; }
    .applybar .btn.primary { flex: 1; justify-content: center; }
    .tally, .keys-wrap { display: none; }
    .names { display: none; }
  }
</style>

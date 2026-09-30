<script lang="ts">
  import { onMount } from 'svelte';
  import V3Row from '$lib/components/V3Row.svelte';
  import type { ReviewDecision } from '$lib/types/v3';

  type View = 'board' | 'briefing' | 'exceptions';
  let accounts = $state<string[]>([]);
  let accountId = $state('');
  let view = $state<View>('board');
  let data = $state<any>({ run: null, policy: null, items: [], calls: [] });
  let drafts = $state<Record<string, ReviewDecision>>({});
  let busy = $state(false);
  let message = $state('');
  let showCleanup = $state(false);
  let showReceipts = $state(false);
  let minPriority = $state(0);
  const items = $derived(data.items as any[]);
  const pending = $derived(Object.values(drafts).length);
  const importInfo = $derived(data.policy?.import_report ? JSON.parse(data.policy.import_report) : null);

  onMount(() => {
    void (async () => {
      const savedView = localStorage.getItem('mailward-v3-view');
      view = savedView === 'briefing' || savedView === 'exceptions' ? savedView : 'board';
      const response = await fetch('/api/accounts');
      if (response.ok) {
        accounts = (await response.json()).accounts;
        const savedAccount = localStorage.getItem('mailward-account');
        accountId = savedAccount && accounts.includes(savedAccount) ? savedAccount : accounts[0] || '';
        if (accountId) localStorage.setItem('mailward-account', accountId);
        if (accountId) await refresh();
      } else message = 'Could not load connected Gmail accounts.';
    })();
    const timer = setInterval(() => { if (accountId && data.run?.status === 'running') refresh(); }, 2000);
    return () => clearInterval(timer);
  });
  function selectView(next: View) { view = next; localStorage.setItem('mailward-v3-view', next); }
  async function refresh() {
    const response = await fetch(`/api/v3/run?accountId=${encodeURIComponent(accountId)}`);
    if (response.ok) data = await response.json();
    else message = (await response.json()).error || 'Could not load your inbox review.';
  }
  async function start() {
    busy = true; message = '';
    try {
      const response = await fetch(`/api/v3/run?accountId=${encodeURIComponent(accountId)}`, { method: 'POST' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Assessment could not start');
      await refresh();
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    finally { busy = false; }
  }
  async function submit() {
    if (!data.run || !pending) return;
    busy = true; message = '';
    try {
      const response = await fetch(`/api/v3/review?accountId=${encodeURIComponent(accountId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: data.run.id, decisions: Object.values(drafts) })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Review failed');
      drafts = {}; message = `Submitted ${result.results.length} reviewed item(s).`;
      await refresh();
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    finally { busy = false; }
  }
  async function undo(actionId: string) {
    busy = true; message = '';
    try {
      const response = await fetch(`/api/v3/undo?accountId=${encodeURIComponent(accountId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actionId }) });
      const result = await response.json();
      if (!response.ok || result.status !== 'applied') throw new Error(result.error || 'Undo failed');
      await refresh();
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    finally { busy = false; }
  }
  async function undoRun() {
    if (!data.run) return;
    busy = true; message = '';
    try {
      const response = await fetch(`/api/v3/undo?accountId=${encodeURIComponent(accountId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ runId: data.run.id }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Undo failed');
      message = `Undid ${result.undone} action(s)${result.failed ? `; ${result.failed} failed` : ''}.`;
      await refresh();
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    finally { busy = false; }
  }
  function setDraft(item: any, decision: ReviewDecision | null) {
    if (decision) drafts = { ...drafts, [item.id]: decision };
    else { const next = { ...drafts }; delete next[item.id]; drafts = next; }
  }
  function groups() {
    const live = items.filter((i) => !i.review_kind && (i.priority >= minPriority || ['needs_action','worth_reading','decision','show_me'].includes(i.lane)));
    const reviewed = items.filter((i) => i.review_kind);
    const group = (title: string, lanes: string[]) => ({ title, rows: live.filter((i) => lanes.includes(i.lane)) });
    if (view === 'board') return [
      group('TODO · needs action', ['needs_action']), group('TODO · worth checking out', ['worth_reading']),
      group('Needs a decision', ['decision']), group('Show before clearing', ['show_me']),
      { title: 'Archive', rows: live.filter((i) => i.lane === 'cleanup' && i.proposed_action === 'archive') },
      { title: 'Trash', rows: live.filter((i) => i.lane === 'cleanup' && i.proposed_action === 'trash') },
      { title: 'Applied and reviewed receipts', rows: reviewed }
    ];
    if (view === 'briefing') return [
      group('Needs action', ['needs_action']), group('Worth checking out', ['worth_reading']),
      group('Show me', ['show_me']), group('Needs a decision', ['decision']),
      { title: 'Cleanup · archive', rows: live.filter((i) => i.lane === 'cleanup' && i.proposed_action === 'archive') },
      { title: 'Cleanup · trash', rows: live.filter((i) => i.lane === 'cleanup' && i.proposed_action === 'trash') },
      { title: 'Reviewed receipts', rows: reviewed }
    ];
    return [
      group('Needs a decision', ['decision']), group('Show before clearing', ['show_me']),
      group('Needs action', ['needs_action']), group('Worth checking out', ['worth_reading']),
      { title: 'Other proposed cleanup', rows: showCleanup ? live.filter((i) => i.lane === 'cleanup') : [] },
      { title: 'Applied and reviewed receipts', rows: showReceipts ? reviewed : [] }
    ];
  }
</script>

<svelte:head><title>Inbox review · Mailward</title></svelte:head>
<main>
  <div class="toolbar accountbar">
    {#if accounts.length}
      <label>Gmail account <select bind:value={accountId} onchange={() => { localStorage.setItem('mailward-account', accountId); drafts = {}; data = { run: null, policy: null, items: [], calls: [] }; refresh(); }}>
        {#each accounts as account}<option value={account}>{account}</option>{/each}
      </select></label>
      {#if data.run}<button class="primary" disabled={!accountId || busy || data.run.status === 'running'} onclick={start}>Check unread mail again</button>{/if}
      <span class="run-status" title={data.replay ? `Assessed at ${new Date(data.replay.assessedAt).toLocaleString()}` : undefined}>{data.run?.status === 'running' ? 'Checking your mail…' : data.run ? `${items.length} threads${data.replay ? ' · saved inbox replay' : ' in this review'}` : 'Ready when you are'}</span>
    {:else}<p>No Gmail account connected. <a href="/auth">Connect Gmail</a> to begin.</p>{/if}
    {#if data.run?.status === 'reauth_required'}<a href="/auth">Reconnect Gmail</a>{/if}
  {#if data.policy}
    <details class="policy"><summary><strong>Preferences</strong><span>Policy {data.policy.version_no}</span></summary>
      <div class="policy-body"><p>This guidance summarizes {importInfo?.sourceRuleCount ?? 0} earlier rules and your feedback. Every mail action still waits for your review.</p><p><strong>Deterministic proposals</strong>: {data.deterministicRules?.map((r: any) => `${r.name} v${r.version} → Trash`).join(', ') || 'Bare calendar responses v1 → Trash'}. Human notes and unrecognized messages go to Jev.</p><pre>{data.policy.text}</pre><details><summary>Import details</summary><pre>{JSON.stringify(importInfo, null, 2)}</pre></details></div>
    </details>
  {/if}
    <a class="legacy" href="/v2">Previous rule view</a>
  </div>
  {#if data.run}
  <nav aria-label="Review view">
    <button class:active={view === 'board'} onclick={() => selectView('board')}>Review</button>
    <button class:active={view === 'briefing'} onclick={() => selectView('briefing')}>Briefing</button>
    <button class:active={view === 'exceptions'} onclick={() => selectView('exceptions')}>Needs a decision</button>
  </nav>
  <div class="overview" aria-label="Inbox summary">
    {#each [['needs_action','Needs action'],['worth_reading','Worth reading'],['decision','Needs decision'],['show_me','Show first'],['cleanup','Cleanup']] as [lane, label]}<span><strong>{items.filter((i) => !i.review_kind && i.lane === lane).length}</strong> {label}</span>{/each}
  <details class="filters"><summary>Filters</summary><div class="toolbar secondary">
    <label>Show cleanup above priority <input type="range" min="0" max="140" step="10" bind:value={minPriority} /> {minPriority}</label>
    {#if view === 'exceptions'}
      <label><input type="checkbox" bind:checked={showCleanup} /> Show other cleanup</label>
      <label><input type="checkbox" bind:checked={showReceipts} /> Show receipts</label>
    {/if}
  </div></details></div>
  {/if}
  {#if message}<p class="message" role="status">{message}</p>{/if}
  {#if data.run}
    {#each groups() as group}
      {#if group.rows.length}
        <section><h2>{group.title} <span>{group.rows.length}</span></h2>
          {#if !group.rows.length}<p class="empty">Nothing here in this run.</p>{/if}
          {#each group.rows as item (item.id)}
            <V3Row {item} {accountId} draft={drafts[item.id]} onChange={(decision) => setDraft(item, decision)} onUndo={undo} />
          {/each}
        </section>
      {/if}
    {/each}
    <div class="submit"><button disabled={busy || !items.some((i) => i.action_status === 'applied')} onclick={undoRun}>Undo applied in run</button><span>{pending} reviewed item(s) ready to submit</span><button class="primary" disabled={!pending || busy || data.run.status !== 'completed'} onclick={submit}>Apply reviewed set</button></div>
    <details class="metrics"><summary>Assessment details</summary><pre>{JSON.stringify({ stages: data.steps, calls: data.calls }, null, 2)}</pre></details>
  {:else if accountId}<div class="welcome"><h2>Start with your unread mail</h2><p>Mailward will suggest what needs action, what is worth reading, and what can be cleared. Review each choice before anything changes in Gmail.</p><button class="primary" disabled={busy} onclick={start}>Check unread mail</button></div>{/if}
</main>

<style>
  main { max-width:1400px;margin:auto }.toolbar,nav,.submit { display:flex;align-items:center;gap:.7rem;flex-wrap:wrap }
  .legacy { color:#51617e;font-size:.76rem;margin-left:auto }
  .toolbar { background:#fff;border:1px solid #d9dee8;border-radius:10px;padding:.3rem .5rem;margin:.3rem 0 }.accountbar { gap:1rem }.accountbar label { display:flex;align-items:center;gap:.4rem;font-size:.76rem;font-weight:700;color:#596474 }.accountbar select { font-weight:500;font-size:.8rem }.run-status { color:#596474;font-size:.82rem }
  button,select { border:1px solid #bec8da;border-radius:6px;padding:.25rem .5rem;background:white;color:#26344a;cursor:pointer;font:inherit;font-size:.8rem }
  button:disabled { opacity:.5;cursor:default }button.primary { background:#375dc1;color:white;border-color:#375dc1 }
  nav { border-bottom:1px solid #ccd4e2;gap:.2rem;margin:.4rem 0 .3rem }nav button { border:0;border-radius:7px 7px 0 0 }nav button.active { background:#dfe8ff;color:#213f91;font-weight:700 }
  .secondary { background:#f7f9fc }.secondary label { display:flex;align-items:center;gap:.35rem;font-size:.8rem }.secondary input[type=range] { width:7rem }
  section { margin:.25rem 0 }section h2 { background:#eaf0f7;padding:2px 7px;font-size:.78rem;margin:0;color:#253958 }h2 span { color:#667892;font-weight:400 }
  .empty { color:#748198;font-size:.87rem }.message { padding:.6rem;background:#fff7df;border:1px solid #ecd48b;border-radius:7px }
  .submit { position:sticky;bottom:0;justify-content:flex-end;background:#f5f7fc;padding:.35rem;border-top:1px solid #d8dfec;box-shadow:0 -4px 12px #fff }
  .policy { display:block;background:transparent;border:0;margin:0;color:#26344a;font-size:.83rem }.policy>summary { cursor:pointer;padding:.2rem .3rem;display:flex;align-items:center;gap:.6rem;flex-wrap:wrap }.policy[open] { flex-basis:100% }.policy>summary span { color:#596474 }.policy-body { border-top:1px solid #d6e1f5;padding:0 .85rem .85rem }.policy pre,.metrics pre { white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:.8rem;border-radius:6px;line-height:1.5 }.policy-body details { margin-top:.75rem }.welcome { padding:2rem;background:white;border:1px solid #d9dee8;border-radius:12px;margin:1.4rem 0 }.welcome h2 { margin-top:0 }.welcome p { max-width:42rem;color:#596474;line-height:1.5 }
  .overview { display:flex;align-items:center;gap:18px;flex-wrap:wrap;font-size:12px;color:#58677d;margin:6px 0 }.overview strong { color:#243a5e }.filters { font-size:11px;color:#69778b;margin:2px 0 }.filters summary { cursor:pointer }
  @media(max-width:650px) { .accountbar label,.accountbar select { width:100% } }
</style>

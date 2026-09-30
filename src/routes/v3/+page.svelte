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

  onMount(() => {
    void (async () => {
      view = (localStorage.getItem('mailward-v3-view') as View) || 'board';
      const response = await fetch('/api/accounts');
      if (response.ok) {
        accounts = (await response.json()).accounts;
        accountId = localStorage.getItem('mailward-account') || accounts[0] || '';
        if (accountId) await refresh();
      }
    })();
    const timer = setInterval(() => { if (accountId && data.run?.status === 'running') refresh(); }, 2000);
    return () => clearInterval(timer);
  });
  function selectView(next: View) { view = next; localStorage.setItem('mailward-v3-view', next); }
  async function refresh() {
    const response = await fetch(`/api/v3/run?accountId=${encodeURIComponent(accountId)}`);
    if (response.ok) data = await response.json();
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
      group('Unsure and show before clearing', ['decision','show_me']),
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

<svelte:head><title>Mailward v3 · Review</title></svelte:head>
<main>
  <div class="mode"><strong>Mailward v3</strong><span>Shared assessment · review first</span><a href="/">Open v2</a></div>
  <div class="toolbar">
    <label>Account <select bind:value={accountId} onchange={() => { localStorage.setItem('mailward-account', accountId); drafts = {}; refresh(); }}>
      {#each accounts as account}<option value={account}>{account}</option>{/each}
    </select></label>
    <button class="primary" disabled={!accountId || busy || data.run?.status === 'running'} onclick={start}>Assess unread mail</button>
    <span>{data.run?.status === 'running' ? 'Assessing… results appear as they complete' : data.run ? `${items.length} assessments · ${data.run.status}` : 'No v3 run yet'}</span>
    {#if data.run?.status === 'reauth_required'}<a href="/auth">Reconnect Gmail</a>{/if}
  </div>
  <nav aria-label="Review view">
    <button class:active={view === 'board'} onclick={() => selectView('board')}>Action board</button>
    <button class:active={view === 'briefing'} onclick={() => selectView('briefing')}>Briefing</button>
    <button class:active={view === 'exceptions'} onclick={() => selectView('exceptions')}>Exceptions</button>
  </nav>
  {#if data.policy}<div class="policy">Policy v{data.policy.version_no} · rubric v{data.policy.rubric_version} · {data.policy.status} · no automation inherited
    <details><summary>Import report</summary><pre>{JSON.stringify(JSON.parse(data.policy.import_report ?? '{}'), null, 2)}</pre></details>
  </div>{/if}
  <div class="toolbar secondary">
    <label>Cleanup priority threshold <input type="range" min="0" max="140" step="10" bind:value={minPriority} /> {minPriority}</label>
    {#if view === 'exceptions'}
      <label><input type="checkbox" bind:checked={showCleanup} /> Show other cleanup</label>
      <label><input type="checkbox" bind:checked={showReceipts} /> Show receipts</label>
    {/if}
    <span class="hint">Display only · changes do not apply mail actions</span>
  </div>
  {#if message}<p class="message" role="status">{message}</p>{/if}
  {#if data.run}
    {#each groups() as group}
      {#if group.rows.length || ['Needs action','Worth checking out','TODO · needs action','TODO · worth checking out'].includes(group.title)}
        <section><h2>{group.title} <span>{group.rows.length}</span></h2>
          {#if !group.rows.length}<p class="empty">Nothing here in this run.</p>{/if}
          {#each group.rows as item (item.id)}
            <V3Row {item} {accountId} draft={drafts[item.id]} onChange={(decision) => setDraft(item, decision)} onUndo={undo} />
          {/each}
        </section>
      {/if}
    {/each}
    <div class="submit"><button disabled={busy || !items.some((i) => i.action_status === 'applied')} onclick={undoRun}>Undo applied in run</button><span>{pending} reviewed item(s) ready to submit</span><button class="primary" disabled={!pending || busy || data.run.status !== 'completed'} onclick={submit}>Apply reviewed set</button></div>
    <details class="metrics"><summary>Run usage and timing</summary><pre>{JSON.stringify({ stages: data.steps, calls: data.calls }, null, 2)}</pre></details>
  {:else}<p class="empty">Select an account and assess unread mail to begin. All three views will use the same results.</p>{/if}
</main>

<style>
  main { max-width:1100px;margin:auto } .mode,.toolbar,nav,.submit { display:flex;align-items:center;gap:.7rem;flex-wrap:wrap }
  .mode { margin-bottom:.8rem }.mode strong { font-size:1.25rem }.mode span,.hint,.policy { color:#596474;font-size:.82rem }.mode a { margin-left:auto;color:#3e5ca9 }
  .toolbar { background:#fff;border:1px solid #d9dee8;border-radius:10px;padding:.7rem;margin:.7rem 0 }
  button,select { border:1px solid #bec8da;border-radius:6px;padding:.43rem .7rem;background:white;color:#26344a;cursor:pointer;font:inherit }
  button:disabled { opacity:.5;cursor:default }button.primary { background:#375dc1;color:white;border-color:#375dc1 }
  nav { border-bottom:1px solid #ccd4e2;gap:.2rem;margin:1rem 0 }nav button { border:0;border-radius:7px 7px 0 0 }nav button.active { background:#dfe8ff;color:#213f91;font-weight:700 }
  .secondary { background:#f7f9fc }.secondary label { display:flex;align-items:center;gap:.35rem;font-size:.8rem }.secondary input[type=range] { width:7rem }
  section { margin:1.5rem 0 }h2 { font-size:1rem;margin:.4rem 0;color:#253958 }h2 span { color:#667892;font-weight:400 }
  .empty { color:#748198;font-size:.87rem }.message { padding:.6rem;background:#fff7df;border:1px solid #ecd48b;border-radius:7px }
  .submit { position:sticky;bottom:0;justify-content:flex-end;background:#f5f7fc;padding:.75rem;border-top:1px solid #d8dfec;box-shadow:0 -4px 12px #fff }
  .policy details { display:inline-block;margin-left:.5rem }.policy pre,.metrics pre { white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:.7rem }
</style>

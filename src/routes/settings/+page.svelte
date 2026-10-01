<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import Icon from '$lib/components/v3/Icon.svelte';
  import Guidance from '$lib/components/settings/Guidance.svelte';
  import Recipes from '$lib/components/settings/Recipes.svelte';
  import Setup from '$lib/components/settings/Setup.svelte';
  import type { PolicyCard } from '$lib/types/v3';
  import { actorLabel, ago, type SettingsData } from '$lib/v3/settings';

  type Notice = { text: string; tone: 'info' | 'success' | 'error' };
  const QUESTION_TITLE: Record<string, string> = { category: 'Kind', attention: 'Attention', retention: 'Afterwards', urgency: 'Urgency', relevance: 'Relevance', gap: 'Missing evidence' };

  let accounts = $state<string[]>([]);
  let accountId = $state('');
  let data = $state<SettingsData | null>(null);
  let loadError = $state('');
  let notice = $state<Notice | null>(null);
  let viewing = $state<string | null>(null);
  let guidance = $state<ReturnType<typeof Guidance>>();

  // Confirmations fade on their own; errors stay until dismissed.
  $effect(() => { if (notice?.tone !== 'success') return; const t = setTimeout(() => (notice = null), 4000); return () => clearTimeout(t); });

  const activeRecipes = $derived(data?.recipes.filter((r) => r.status === 'active').length ?? 0);
  const latestAgreement = $derived(data?.agreement[0] ?? null);

  onMount(() => {
    void (async () => {
      const response = await fetch('/api/accounts');
      if (!response.ok) { loadError = 'Could not load connected Gmail accounts.'; return; }
      accounts = (await response.json()).accounts;
      const wanted = new URL(location.href).searchParams.get('account') ?? localStorage.getItem('mailward-account');
      accountId = wanted && accounts.includes(wanted) ? wanted : accounts[0] ?? '';
      if (accountId) await load(); else loadError = 'Connect a Gmail account first.';
    })();
    const warn = (e: BeforeUnloadEvent) => { if (guidance?.isDirty()) e.preventDefault(); };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  });

  async function load() {
    const response = await fetch(`/api/v3/settings?accountId=${encodeURIComponent(accountId)}`);
    const body = await response.json();
    if (!response.ok) { loadError = body.error ?? 'Could not load settings.'; return; }
    data = body; loadError = '';
  }

  /** POST a settings operation and reload. Returns the result, `{ error }` for validation problems, or null on failure. */
  async function call(op: Record<string, unknown>, success?: string): Promise<any | null> {
    const response = await fetch(`/api/v3/settings?accountId=${encodeURIComponent(accountId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(op) });
    const body = await response.json().catch(() => ({ error: 'Unexpected response' }));
    if (!response.ok) {
      if (response.status === 409 && op.op !== 'setup') { notice = { text: body.error, tone: 'error' }; await load(); return null; }
      if (op.op === 'saveRecipe' || op.op === 'testRecipe' || op.op === 'setup') return { error: body.error };
      notice = { text: body.error ?? 'Could not save.', tone: 'error' }; return null;
    }
    if (op.op !== 'testRecipe') await load();
    if (success) notice = { text: success, tone: 'success' };
    return body;
  }

  async function savePolicy(cards: PolicyCard[], note: string) {
    if (!data?.policy) return false;
    const previous = data.policy.version;
    const result = await call({ op: 'savePolicy', expectedPolicyId: data.policy.id, cards, note });
    if (result) notice = { text: result.version === previous ? `Updated v${previous}; Jev's input is unchanged.` : `Saved policy v${result.version}. The next check uses it.`, tone: 'success' };
    return !!result;
  }

  async function restore(id: string, version: number) {
    if (!data?.policy || !confirm(`Restore v${version} as a new version? The current guidance stays in history.`)) return;
    if (guidance?.isDirty() && !confirm('Discard your unsaved guidance changes?')) return;
    await call({ op: 'restorePolicy', expectedPolicyId: data.policy.id, policyId: id }, `Restored v${version} as a new version.`);
  }

  function switchAccount(next: string) {
    if (guidance?.isDirty() && !confirm('Discard your unsaved guidance changes?')) return;
    accountId = next; localStorage.setItem('mailward-account', next); data = null; void load();
  }
</script>

<svelte:head><title>Settings · Mailward</title></svelte:head>

<main>
  <header class="top">
    <a class="brand" href="/">Mailward</a>
    <span class="crumb">Settings</span>
    {#if accounts.length > 1}
      <select class="account" aria-label="Gmail account" value={accountId} onchange={(e) => switchAccount(e.currentTarget.value)}>
        {#each accounts as account}<option value={account}>{account}</option>{/each}
      </select>
    {:else if accountId}<span class="account">{accountId}</span>{/if}
    <span class="spacer"></span>
    <a class="btn" href="/"><Icon name="back" size={13} /> Back to review</a>
  </header>

  {#if loadError}
    <div class="sheet pad"><p>{loadError}</p>{#if !accounts.length}<a class="btn primary" href="/auth">Connect Gmail</a>{/if}</div>
  {:else if !data}
    <div class="sheet pad loading" aria-busy="true"><span class="spinner"></span> Loading settings…</div>
  {:else if data.setupNeeded}
    <Setup {data} {call} onDone={() => goto('/?setup=done')} />
  {:else if data.policy}
    <div class="layout">
      <nav class="toc" aria-label="Settings sections">
        <a href="#how"><Icon name="arrow" size={13} /> How it decides</a>
        <a href="#guidance"><Icon name="book" size={13} /> Guidance</a>
        <a href="#recipes"><Icon name="zap" size={13} /> Recipes</a>
        <a href="#history"><Icon name="clock" size={13} /> History</a>
        <a href="#jev"><Icon name="cpu" size={13} /> About Jev</a>
      </nav>

      <div class="content">
        <section id="how" class="flow" aria-label="How Mailward decides">
          <a class="stage" href="#recipes">
            <span class="k"><Icon name="zap" size={13} /> Recipes</span>
            <strong>{activeRecipes ? `${activeRecipes} active` : 'None yet'}</strong>
            <span>Known mail is matched by its metadata. Jev is not asked.</span>
          </a>
          <span class="arrow" aria-hidden="true"><Icon name="arrow" size={14} /></span>
          <a class="stage" href="#guidance">
            <span class="k"><Icon name="cpu" size={13} /> Jev + your guidance</span>
            <strong>Policy v{data.policy.version} · {data.policy.words} words</strong>
            <span>Six questions per thread, read against your guidance.</span>
          </a>
          <span class="arrow" aria-hidden="true"><Icon name="arrow" size={14} /></span>
          <a class="stage" href="/">
            <span class="k"><Icon name="check" size={13} /> You</span>
            <strong>{latestAgreement ? `${Math.round((latestAgreement.matched / latestAgreement.comparable) * 100)}% agreement` : 'Review and apply'}</strong>
            <span>{latestAgreement ? `Your decisions matched ${latestAgreement.matched} of ${latestAgreement.comparable} firm suggestions (v${latestAgreement.version}, 30 days).` : 'Nothing changes in Gmail until you apply your decisions.'}</span>
          </a>
        </section>

        <section id="guidance" class="block" aria-labelledby="h-guidance">
          <header class="bhead">
            <div>
              <h2 id="h-guidance">Guidance</h2>
              <p>What Jev reads with every thread, in this order. Titles are only for you; switched-off cards are kept but not sent.</p>
            </div>
            <span class="ver">v{data.policy.version} · {actorLabel(data.policy.createdBy)} · {ago(data.policy.createdAt)}</span>
          </header>
          <div class="sheet">
            <Guidance bind:this={guidance} original={data.policy.cards} version={data.policy.version} threads={data.lastRunThreads} onSave={savePolicy} />
          </div>
        </section>

        <section id="recipes" class="block" aria-labelledby="h-recipes">
          <header class="bhead">
            <div>
              <h2 id="h-recipes">Recipes</h2>
              <p>Mail that is always handled the same way. A match skips Jev and is proposed straight away, still for your review. The first matching recipe wins.</p>
            </div>
          </header>
          <div class="sheet"><Recipes {data} {call} /></div>
        </section>

        <section id="history" class="block" aria-labelledby="h-history">
          <header class="bhead">
            <div>
              <h2 id="h-history">History</h2>
              <p>Every change to Jev's input is a new version, whether it came from you, setup or a weekly review. Restoring creates a new version.</p>
            </div>
          </header>
          <div class="sheet">
            {#each data.history as h (h.id)}
              <div class="ver-row" class:current={h.id === data.policy.id}>
                <span class="vno">v{h.version}</span>
                <div class="vmain">
                  <span class="vnote">{h.note ?? 'No note'}</span>
                  <span class="vmeta">{actorLabel(h.createdBy)} · {ago(h.createdAt)} · {h.words} words</span>
                </div>
                {#if h.id === data.policy.id}<span class="tag">Current</span>{/if}
                <button class="quiet" aria-expanded={viewing === h.id} onclick={() => (viewing = viewing === h.id ? null : h.id)}>{viewing === h.id ? 'Hide' : 'View'}</button>
                {#if h.id !== data.policy.id}<button class="quiet" onclick={() => restore(h.id, h.version)}>Restore</button>{/if}
              </div>
              {#if viewing === h.id}<pre class="vtext">{h.text}</pre>{/if}
            {/each}
          </div>
        </section>

        <section id="jev" class="block" aria-labelledby="h-jev">
          <header class="bhead">
            <div>
              <h2 id="h-jev">About Jev</h2>
              <p>Jev answers the same six questions for every thread; Mailward turns the answers into a suggestion. The questions are part of the program, so they are shown here but not edited. When Jev is not clearly sure, the thread goes to <em>Needs a decision</em>.</p>
            </div>
            <span class="ver">{data.jev.model} · rubric v{data.jev.rubricVersion}</span>
          </header>
          <div class="sheet">
            {#each data.jev.questions as q (q.key)}
              <details class="q">
                <summary>
                  <span class="qt">{QUESTION_TITLE[q.key] ?? q.key}</span>
                  <span class="opts">{#each q.options as o}<span class="opt" title={o.label}>{q.kind === 'score' ? o.key : o.key.replace('_', ' ')}</span>{/each}</span>
                  <span class="chev"><Icon name="chevron" size={12} /></span>
                </summary>
                <div class="qbody">
                  <p class="instr">{q.instruction}</p>
                  <dl>{#each q.options as o}<div><dt>{q.kind === 'score' ? o.key : o.key.replace('_', ' ')}</dt><dd>{o.label}</dd></div>{/each}</dl>
                </div>
              </details>
            {/each}
            <details class="q">
              <summary><span class="qt">Shared instruction</span><span class="opts dim">sent with every question</span><span class="chev"><Icon name="chevron" size={12} /></span></summary>
              <div class="qbody"><p class="instr">{data.jev.shared}</p></div>
            </details>
          </div>
        </section>
      </div>
    </div>
  {/if}

  {#if notice}
    <div class="notice {notice.tone}" role={notice.tone === 'error' ? 'alert' : 'status'}>
      <span>{notice.text}</span><button class="close" aria-label="Dismiss" onclick={() => (notice = null)}>×</button>
    </div>
  {/if}
</main>

<style>
  main { max-width: 1120px; margin: 0 auto; padding-bottom: 3rem; font-size: 13px; }
  .spacer { flex: 1; }
  .top { display: flex; align-items: center; gap: .9rem; min-height: 52px; flex-wrap: wrap; }
  .brand { font-size: 15px; font-weight: 750; letter-spacing: -.01em; color: var(--ink); text-decoration: none; }
  .crumb { color: var(--ink-3); font-size: 13px; font-weight: 600; }
  .crumb::before { content: '/'; margin-right: .9rem; color: var(--line-strong); }
  .account { color: var(--ink-2); font: inherit; font-size: 12.5px; }
  select.account { height: 28px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--surface); padding: 0 .4rem; }

  .sheet { border: 1px solid var(--line); border-radius: 10px; background: var(--surface); overflow: clip; }
  .pad { padding: 1.5rem; color: var(--ink-2); }
  .loading { display: flex; align-items: center; gap: .6rem; color: var(--ink-3); }

  .layout { display: grid; grid-template-columns: 11rem minmax(0, 1fr); gap: 2rem; margin-top: .6rem; }
  .toc { position: sticky; top: 1rem; align-self: start; display: flex; flex-direction: column; gap: .1rem; }
  .toc a { display: flex; align-items: center; gap: .55rem; height: 30px; padding: 0 .6rem; border-radius: 7px; color: var(--ink-2); font-weight: 550; text-decoration: none; }
  .toc a:hover { background: var(--surface); color: var(--ink); }
  .toc a :global(svg) { color: var(--ink-4); }
  .content { min-width: 0; }

  .flow { display: flex; align-items: stretch; gap: .4rem; margin-bottom: 2rem; scroll-margin-top: 1rem; }
  .stage { flex: 1; display: flex; flex-direction: column; gap: .2rem; padding: .8rem .9rem; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--ink-3); font-size: 12px; line-height: 1.4; text-decoration: none; transition: border-color .15s; }
  .stage:hover { border-color: var(--line-strong); }
  .stage .k { display: flex; align-items: center; gap: .35rem; color: var(--ink-3); font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .05em; }
  .stage strong { color: var(--ink); font-size: 14px; font-weight: 700; }
  .arrow { display: flex; align-items: center; color: var(--ink-4); }

  .block { margin-bottom: 2.2rem; scroll-margin-top: 1rem; }
  .bhead { display: flex; align-items: flex-end; gap: 1rem; margin-bottom: .7rem; }
  .bhead div { flex: 1; }
  .bhead h2 { margin: 0 0 .2rem; font-size: 16px; font-weight: 700; letter-spacing: -.01em; }
  .bhead p { margin: 0; max-width: 72ch; color: var(--ink-3); line-height: 1.5; }
  .ver { color: var(--ink-3); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }

  .ver-row { display: flex; align-items: center; gap: .8rem; min-height: 46px; padding: .3rem .6rem .3rem 1rem; border-top: 1px solid var(--line); }
  .ver-row:first-child { border-top: 0; }
  .vno { flex: 0 0 2.4rem; font-weight: 700; color: var(--ink-2); font-variant-numeric: tabular-nums; }
  .current .vno { color: var(--ink); }
  .vmain { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .vnote { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
  .vmeta { color: var(--ink-3); font-size: 12px; }
  .tag { height: 19px; padding: 0 .4rem; border: 1px solid var(--line-strong); border-radius: 5px; color: var(--ink-3); font-size: 11px; line-height: 17px; }
  .vtext { margin: 0; padding: .9rem 1rem; border-top: 1px solid var(--line); background: var(--sunken); color: var(--ink-2); font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; max-height: 28rem; overflow: auto; }

  .q { border-top: 1px solid var(--line); }
  .q:first-child { border-top: 0; }
  .q summary { display: flex; align-items: center; gap: .8rem; min-height: 42px; padding: 0 .8rem 0 1rem; cursor: pointer; list-style: none; }
  .q summary::-webkit-details-marker { display: none; }
  .q summary:hover { background: var(--row-hover); }
  .qt { flex: 0 0 8.5rem; font-weight: 650; color: var(--ink); }
  .opts { flex: 1; display: flex; gap: .3rem; flex-wrap: wrap; min-width: 0; }
  .opts.dim { color: var(--ink-4); font-size: 12px; }
  .opt { height: 20px; padding: 0 .45rem; border-radius: 5px; background: var(--sunken); color: var(--ink-2); font-size: 11.5px; line-height: 20px; }
  .chev { display: flex; color: var(--ink-4); transition: transform .15s; }
  .q[open] .chev { transform: rotate(90deg); }
  .qbody { padding: .2rem 1rem 1rem calc(1rem + 8.5rem + .8rem); }
  .instr { margin: 0 0 .7rem; max-width: 80ch; color: var(--ink-2); line-height: 1.55; }
  .qbody dl { margin: 0; display: grid; gap: .25rem; }
  .qbody dl div { display: flex; gap: .7rem; }
  .qbody dt { flex: 0 0 6.5rem; color: var(--ink); font-weight: 600; }
  .qbody dd { margin: 0; color: var(--ink-3); }

  .notice { position: fixed; left: 50%; bottom: 1.2rem; z-index: 20; transform: translateX(-50%); display: flex; align-items: center; gap: .8rem; max-width: min(40rem, calc(100vw - 2rem)); padding: .55rem .6rem .55rem .9rem; border-radius: 8px; background: var(--ink); color: #fff; box-shadow: 0 10px 30px -10px rgb(24 32 44 / 50%); font-size: 12.5px; }
  .notice.error { background: #8f1d33; }
  .notice .close { border: 0; background: none; color: inherit; font-size: 16px; line-height: 1; cursor: pointer; opacity: .7; }
  .spinner { width: 12px; height: 12px; border: 2px solid var(--line-strong); border-top-color: var(--focus); border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (max-width: 900px) {
    .layout { grid-template-columns: minmax(0, 1fr); gap: 0; }
    .toc { position: static; flex-direction: row; overflow-x: auto; scrollbar-width: none; margin: 0 -1rem 1rem; padding: 0 1rem; }
    .toc a { flex-shrink: 0; }
  }
  @media (max-width: 720px) {
    .flow { flex-direction: column; }
    .arrow { justify-content: center; transform: rotate(90deg); height: 14px; }
    .bhead { flex-direction: column; align-items: flex-start; gap: .3rem; }
    .qt { flex-basis: 6.5rem; }
    .qbody { padding-left: 1rem; }
    .crumb { display: none; }
  }
</style>

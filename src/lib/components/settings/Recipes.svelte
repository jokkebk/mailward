<script lang="ts">
  import Icon from '$lib/components/v3/Icon.svelte';
  import type { RecipeSpec } from '$lib/types/v3';
  import { actorLabel, ago, RECIPE_ACTION, RECIPE_TEMPLATE, recipeOutcome, type MatchReport, type RecipeStat, type SettingsData } from '$lib/v3/settings';

  let { data, call }: { data: SettingsData; call: (body: Record<string, unknown>) => Promise<any | null> } = $props();

  // Open JSON editors by recipe key; "new" is the blank recipe.
  let drafts = $state<Record<string, string>>({});
  let tests = $state<Record<string, MatchReport | null>>({});
  let errors = $state<Record<string, string>>({});
  let busy = $state<string | null>(null);
  let showLibrary = $state(false);
  let showFields = $state(false);

  const stats = $derived(new Map(data.recipeStats.results.map((r) => [r.key, r])));
  const available = $derived(data.library.filter((l) => !l.adopted));
  const pretty = (spec: RecipeSpec) => JSON.stringify(spec, null, 2);

  function edit(key: string, spec: RecipeSpec | null) {
    if (key in drafts) { const { [key]: _, ...rest } = drafts; drafts = rest; return; }
    drafts = { ...drafts, [key]: spec ? pretty(spec) : RECIPE_TEMPLATE };
    errors = { ...errors, [key]: '' }; tests = { ...tests, [key]: null };
  }
  function close(key: string) { const { [key]: _, ...rest } = drafts; drafts = rest; }

  function parsed(key: string): unknown | null {
    try { return JSON.parse(drafts[key]); } catch (e) { errors = { ...errors, [key]: `Not valid JSON: ${(e as Error).message}` }; return null; }
  }
  async function test(key: string) {
    const recipe = parsed(key); if (!recipe) return;
    busy = `test:${key}`;
    const result = await call({ op: 'testRecipe', recipe }).finally(() => (busy = null));
    if (result?.error) errors = { ...errors, [key]: result.error };
    else if (result) { errors = { ...errors, [key]: '' }; tests = { ...tests, [key]: result }; }
  }
  async function save(key: string) {
    const recipe = parsed(key); if (!recipe) return;
    busy = `save:${key}`;
    const result = await call({ op: 'saveRecipe', recipe }).finally(() => (busy = null));
    if (result?.error) errors = { ...errors, [key]: result.error }; else if (result) close(key);
  }
  async function act(body: Record<string, unknown>, confirmText?: string) {
    if (confirmText && !confirm(confirmText)) return;
    busy = `${body.op}:${body.key}`;
    await call(body).finally(() => (busy = null));
  }
  function agreement(s: RecipeStat | undefined) {
    if (!s) return 'No matches in the last 30 days';
    if (!s.matched) return `No matches in ${data.recipeStats.scanned} recent threads`;
    return `Matched ${s.matched} recent thread${s.matched === 1 ? '' : 's'}${s.reviewed ? ` · your decision agreed ${s.agreed} of ${s.reviewed}` : ''}`;
  }
</script>

{#snippet badge(spec: RecipeSpec)}
  <span class="badge {spec.action}" title={recipeOutcome(spec)}>{RECIPE_ACTION[spec.action]}{#if spec.section === 'show_before_clearing'}<small>after a look</small>{/if}</span>
{/snippet}

{#snippet editor(key: string, isNew: boolean)}
  <div class="editor">
    <textarea class="json" spellcheck="false" aria-label="Recipe JSON" bind:value={drafts[key]} rows={Math.min(28, drafts[key].split('\n').length + 1)}></textarea>
    {#if errors[key]}<p class="error" role="alert">{errors[key]}</p>{/if}
    {#if tests[key]}
      {@const r = tests[key]!.results[0]}
      <div class="test">
        <p><strong>{r.matched}</strong> of {tests[key]!.scanned} threads from the last {tests[key]!.days} days would match{#if r.reviewed}, and you decided {r.agreed} of {r.reviewed} reviewed ones the same way{/if}.
          {#if r.overlaps.length}<span class="warn">Also matched by {r.overlaps.join(', ')}; the earlier recipe in the list wins.</span>{/if}</p>
        {#if r.samples.length}
          <ul>{#each r.samples as s}<li><span class="from">{s.from.replace(/<.*>/, '').trim() || s.from}</span><span class="subj">{s.subject}</span>{#if s.reviewed}<span class="rev">you: {s.reviewed === 'label_todo' ? 'TODO' : s.reviewed}</span>{/if}</li>{/each}</ul>
        {/if}
      </div>
    {/if}
    <div class="tools">
      <button class="btn" disabled={busy !== null} onclick={() => test(key)}>{busy === `test:${key}` ? 'Testing…' : 'Test on recent mail'}</button>
      <span class="spacer"></span>
      <button class="quiet" onclick={() => close(key)}>Cancel</button>
      <button class="btn primary" disabled={busy !== null} onclick={() => save(key)}>{busy === `save:${key}` ? 'Saving…' : isNew ? 'Adopt recipe' : 'Save new version'}</button>
    </div>
  </div>
{/snippet}

<div class="list">
  {#each data.recipes as r, i (r.key)}
    {@const s = stats.get(r.key)}
    <article class="recipe" class:paused={r.status === 'paused'}>
      <div class="row">
        <span class="order" title="Match order: the first matching recipe wins">{i + 1}</span>
        <div class="main">
          <div class="line">
            <span class="title">{r.spec.title}</span>
            {@render badge(r.spec)}
            {#if r.status === 'paused'}<span class="tag">Paused</span>{/if}
          </div>
          {#if r.spec.description}<p class="desc">{r.spec.description}</p>{/if}
          <p class="meta">
            {r.status === 'paused' ? 'Not matching while paused' : agreement(s)}
            {#if s?.overlaps.length}<span class="warn">· overlaps {s.overlaps.join(', ')}</span>{/if}
            <span class="dim">· v{r.version} by {actorLabel(r.createdBy)} {ago(r.updatedAt)}{r.source?.startsWith('library:') ? ' · from library' : ''}</span>
          </p>
        </div>
        <div class="actions">
          <button class="switch" role="switch" aria-checked={r.status === 'active'} aria-label="{r.status === 'active' ? 'Pause' : 'Resume'} {r.spec.title}" disabled={busy !== null}
            title={r.status === 'active' ? 'Active: matches skip Jev' : 'Paused: Jev assesses these'} onclick={() => act({ op: 'recipeStatus', key: r.key, status: r.status === 'active' ? 'paused' : 'active' })}><i></i></button>
          <button class="quiet" aria-expanded={r.key in drafts} onclick={() => edit(r.key, r.spec)}>JSON</button>
          <button class="icon" aria-label="Move {r.spec.title} earlier" disabled={i === 0 || busy !== null} onclick={() => act({ op: 'moveRecipe', key: r.key, delta: -1 })}><Icon name="up" size={13} /></button>
          <button class="icon" aria-label="Move {r.spec.title} later" disabled={i === data.recipes.length - 1 || busy !== null} onclick={() => act({ op: 'moveRecipe', key: r.key, delta: 1 })}><Icon name="down" size={13} /></button>
          <button class="icon danger" aria-label="Remove {r.spec.title}" disabled={busy !== null} onclick={() => act({ op: 'removeRecipe', key: r.key }, `Remove “${r.spec.title}”? Matching mail goes to Jev again. Past verdicts keep their record.`)}><Icon name="close" size={13} /></button>
        </div>
      </div>
      {#if r.key in drafts}{@render editor(r.key, false)}{/if}
    </article>
  {:else}
    <p class="empty">No recipes yet. Everything goes to Jev, which is a fine place to start. Adopt one from the library when a kind of mail is always handled the same way.</p>
  {/each}

  {#if 'new' in drafts}
    <article class="recipe new"><div class="row"><span class="order"><Icon name="plus" size={12} /></span><div class="main"><span class="title">New recipe</span><p class="desc">Paste or write JSON. Test it against your recent mail before adopting.</p></div></div>{@render editor('new', true)}</article>
  {/if}
</div>

<div class="foot">
  <button class="btn" aria-expanded={showLibrary} onclick={() => (showLibrary = !showLibrary)}><Icon name="book" size={13} /> Library{#if available.length}<span class="n">{available.length}</span>{/if}</button>
  <button class="quiet" aria-expanded={'new' in drafts} onclick={() => edit('new', null)}><Icon name="plus" size={13} /> Write a recipe</button>
  <span class="spacer"></span>
  <button class="quiet" aria-expanded={showFields} onclick={() => (showFields = !showFields)}>Fields and operators</button>
</div>

{#if showLibrary}
  <div class="library">
    {#each data.library as l (l.spec.key)}
      <div class="lib">
        <div class="main">
          <div class="line"><span class="title">{l.spec.title}</span>{@render badge(l.spec)}{#if l.recommended}<span class="tag">Recommended</span>{/if}</div>
          {#if l.spec.description}<p class="desc">{l.spec.description}</p>{/if}
          <details><summary>JSON</summary><pre>{pretty(l.spec)}</pre></details>
        </div>
        {#if l.adopted}<span class="adopted"><Icon name="check" size={13} /> Adopted</span>
        {:else}<button class="btn" disabled={busy !== null} onclick={() => act({ op: 'adoptRecipe', key: l.spec.key })}>Adopt</button>{/if}
      </div>
    {/each}
  </div>
{/if}

{#if showFields}
  <div class="fields">
    <p>Each condition is <code>{'{ "field": …, "<operator>": … }'}</code>; all conditions in <code>match</code> must hold for every unread message (set <code>"messages": "any"</code> to relax). Combine with <code>any</code>, <code>all</code> and <code>not</code>. Text comparisons ignore case.</p>
    <p><strong>Operators</strong> <code>equals</code> <code>matches</code> (regular expression) <code>contains</code> <code>in</code> <code>is</code> (true, false or null) <code>shorterThan</code> <code>longerThan</code></p>
    <p><strong>Outcome</strong> <code>"action"</code>: trash, archive or label_todo · <code>"section"</code>: needs_action or worth_reading for TODO, show_before_clearing for trash/archive · <code>"then"</code>: handling after a TODO is done · <code>"completeContentOnly": false</code> also matches threads with missing content.</p>
    <dl>{#each Object.entries(data.fields) as [k, v]}<div><dt><code>{k}</code></dt><dd>{v}</dd></div>{/each}</dl>
  </div>
{/if}

<style>
  .recipe { border-top: 1px solid var(--line); }
  .recipe:first-child { border-top: 0; }
  .row { display: flex; align-items: flex-start; gap: .75rem; padding: .75rem .6rem .75rem 1rem; }
  .recipe:hover .row { background: var(--row-hover); }
  .order { display: grid; place-items: center; flex-shrink: 0; width: 20px; height: 20px; margin-top: 1px; border-radius: 50%; background: var(--sunken); color: var(--ink-3); font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .main { flex: 1; min-width: 0; }
  .line { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; }
  .title { font-weight: 650; color: var(--ink); }
  .paused .title, .paused .desc { color: var(--ink-3); }
  .desc { margin: .2rem 0 0; color: var(--ink-2); font-size: 12.5px; line-height: 1.45; }
  .meta { margin: .3rem 0 0; color: var(--ink-3); font-size: 12px; }
  .dim { color: var(--ink-4); }
  .warn { color: var(--warn); }
  .badge { --c: var(--ink-3); display: inline-flex; align-items: center; gap: .3rem; height: 19px; padding: 0 .45rem; border-radius: 5px; background: color-mix(in srgb, var(--c) 11%, transparent); color: var(--c); font-size: 11px; font-weight: 700; letter-spacing: .01em; }
  .badge small { font-weight: 550; opacity: .85; }
  .badge.trash { --c: var(--trash); } .badge.archive { --c: var(--archive); } .badge.label_todo { --c: var(--todo); }
  .tag { height: 19px; padding: 0 .4rem; border: 1px solid var(--line-strong); border-radius: 5px; color: var(--ink-3); font-size: 11px; line-height: 17px; }
  .actions { display: flex; align-items: center; gap: .15rem; }
  .icon { display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 6px; background: none; color: var(--ink-4); cursor: pointer; }
  .icon:hover:not(:disabled) { background: var(--sunken); color: var(--ink); }
  .icon:disabled { opacity: .35; cursor: default; }
  .icon.danger:hover:not(:disabled) { color: var(--trash); }
  .switch { position: relative; flex-shrink: 0; width: 30px; height: 18px; margin-right: .3rem; padding: 0; border: 0; border-radius: 9px; background: var(--line-strong); cursor: pointer; transition: background .15s; }
  .switch i { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 25%); transition: transform .15s; }
  .switch[aria-checked='true'] { background: var(--done); }
  .switch[aria-checked='true'] i { transform: translateX(12px); }

  .editor { padding: 0 1rem 1rem calc(1rem + 20px + .75rem); }
  .json { box-sizing: border-box; width: 100%; padding: .7rem .8rem; border: 1px solid var(--line-strong); border-radius: 8px; background: #fbfcfd; color: var(--ink); font: 12px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; tab-size: 2; resize: vertical; }
  .json:focus { outline: 2px solid var(--focus); outline-offset: -1px; border-color: transparent; }
  .error { margin: .5rem 0 0; padding: .45rem .7rem; border-radius: 7px; background: color-mix(in srgb, var(--trash) 9%, transparent); color: #9b1c33; font-size: 12.5px; }
  .test { margin-top: .6rem; padding: .6rem .8rem; border-radius: 8px; background: var(--sunken); font-size: 12.5px; color: var(--ink-2); }
  .test p { margin: 0; }
  .test ul { margin: .5rem 0 0; padding: 0; list-style: none; }
  .test li { display: flex; gap: .6rem; padding: .2rem 0; border-top: 1px solid var(--line); }
  .test .from { flex: 0 0 9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); font-weight: 600; }
  .test .subj { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .test .rev { color: var(--ink-3); white-space: nowrap; }
  .tools { display: flex; align-items: center; gap: .4rem; margin-top: .6rem; }
  .spacer { flex: 1; }
  .empty { margin: 0; padding: 1.1rem 1rem; color: var(--ink-3); line-height: 1.5; }

  .foot { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; padding: .7rem 1rem; border-top: 1px solid var(--line); }
  .foot .n { margin-left: .1rem; padding: 0 .35rem; border-radius: 4px; background: var(--sunken); color: var(--ink-2); font-size: 11px; }
  .library { border-top: 1px solid var(--line); background: var(--row-hover); }
  .lib { display: flex; align-items: flex-start; gap: .8rem; padding: .75rem 1rem; border-top: 1px solid var(--line); }
  .lib:first-child { border-top: 0; }
  .lib details { margin-top: .3rem; font-size: 12px; color: var(--ink-3); }
  .lib summary { cursor: pointer; width: max-content; }
  .lib pre { margin: .4rem 0 0; padding: .6rem .7rem; border-radius: 7px; background: var(--surface); border: 1px solid var(--line); font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; color: var(--ink-2); }
  .adopted { display: inline-flex; align-items: center; gap: .3rem; height: 30px; color: var(--done); font-size: 12.5px; font-weight: 600; white-space: nowrap; }
  .fields { padding: .8rem 1rem 1rem; border-top: 1px solid var(--line); background: var(--row-hover); color: var(--ink-2); font-size: 12.5px; line-height: 1.55; }
  .fields p { margin: 0 0 .5rem; max-width: 90ch; }
  .fields dl { display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: .15rem 1.2rem; margin: .6rem 0 0; }
  .fields dl div { display: flex; gap: .5rem; }
  .fields dt { flex: 0 0 10.5rem; }
  .fields dd { margin: 0; color: var(--ink-3); }
  code { padding: 0 .25rem; border-radius: 4px; background: var(--sunken); font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink); }
  @media (max-width: 720px) { .editor { padding-left: 1rem; } .row { flex-wrap: wrap; } .actions { width: 100%; justify-content: flex-end; } }
</style>

<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '$lib/components/v3/Icon.svelte';
  import { RECIPE_ACTION, recipeOutcome, type SettingsData } from '$lib/v3/settings';

  let { data, onDone, call }: { data: SettingsData; onDone: () => void; call: (body: Record<string, unknown>) => Promise<any | null> } = $props();

  let name = $state('');
  let role = $state('');
  let topics = $state('');
  // Initial choices only; later reloads of `data` must not reset the form.
  let starter = $state<Record<string, boolean>>(untrack(() => Object.fromEntries(data.setup.starter.map((c) => [c.id, true]))));
  let suggested = $state<Record<string, boolean>>({});
  let recipes = $state<Record<string, boolean>>(untrack(() => Object.fromEntries(data.library.map((l) => [l.spec.key, l.recommended]))));
  let peek = $state<string | null>(null);
  let busy = $state(false);
  let error = $state('');

  const picked = $derived(Number(!!name.trim()) + Object.values(starter).filter(Boolean).length + Object.entries(suggested).filter(([id, on]) => on && (id !== 'interests' || topics.trim())).length);

  async function create() {
    busy = true; error = '';
    const result = await call({
      op: 'setup', name, role, topics,
      starter: Object.keys(starter).filter((k) => starter[k]),
      suggested: Object.keys(suggested).filter((k) => suggested[k]),
      recipes: Object.keys(recipes).filter((k) => recipes[k])
    });
    busy = false;
    if (result?.error) error = result.error; else if (result) onDone();
  }
</script>

<section class="setup" aria-labelledby="setup-title">
  <header class="hero">
    <h1 id="setup-title">Set up Mailward</h1>
    <p>Three choices tell Jev how to read <strong>{data.accountId}</strong>. All of it stays editable in Settings, and nothing changes in Gmail until you review and apply.</p>
  </header>

  <ol class="steps">
    <li class="step">
      <div class="num">1</div>
      <div class="body">
        <h2>Who is this inbox for?</h2>
        <p class="hint">Optional, but a name and role help Jev tell your tasks from someone else’s.</p>
        <div class="pair">
          <label><span>Name</span><input class="input" bind:value={name} placeholder="Alex Virtanen" autocomplete="name" /></label>
          <label><span>Role</span><input class="input" bind:value={role} placeholder="e.g. product designer at Acme" /></label>
        </div>
      </div>
    </li>

    <li class="step">
      <div class="num">2</div>
      <div class="body">
        <h2>How should Jev think?</h2>
        <p class="hint">Sensible defaults are switched on. Add anything that sounds like you.</p>
        <div class="choices">
          {#each data.setup.starter as c (c.id)}
            <div class="choice" class:on={starter[c.id]}>
              <label class="check"><input type="checkbox" bind:checked={starter[c.id]} /><span class="ctitle">{c.title}</span></label>
              <button class="peek" aria-expanded={peek === c.id} onclick={() => (peek = peek === c.id ? null : c.id)}>{peek === c.id ? 'Hide' : 'Read'}</button>
              {#if peek === c.id}<p class="text">{c.body}</p>{/if}
            </div>
          {/each}
        </div>
        <h3>Also sounds like me</h3>
        <div class="choices">
          {#each data.setup.suggested as c (c.id)}
            <div class="choice" class:on={suggested[c.id]}>
              <label class="check"><input type="checkbox" bind:checked={suggested[c.id]} /><span class="ctitle">{c.blurb}</span></label>
              <button class="peek" aria-expanded={peek === c.id} onclick={() => (peek = peek === c.id ? null : c.id)}>{peek === c.id ? 'Hide' : 'Read'}</button>
              {#if c.input && suggested[c.id]}
                <label class="inline"><span>{c.input.label}</span><input class="input" bind:value={topics} placeholder={c.input.placeholder} /></label>
              {/if}
              {#if peek === c.id}<p class="text">{c.body.replace('{topics}', topics.trim() || '…')}</p>{/if}
            </div>
          {/each}
        </div>
      </div>
    </li>

    <li class="step">
      <div class="num">3</div>
      <div class="body">
        <h2>Anything you never need to think about?</h2>
        <p class="hint">Recipes recognise known mail by its metadata and skip Jev. Matches still wait for your review.</p>
        <div class="choices">
          {#each data.library as l (l.spec.key)}
            <div class="choice" class:on={recipes[l.spec.key]}>
              <label class="check"><input type="checkbox" bind:checked={recipes[l.spec.key]} />
                <span class="ctitle">{l.spec.title}</span><span class="badge {l.spec.action}" title={recipeOutcome(l.spec)}>{RECIPE_ACTION[l.spec.action]}</span></label>
              {#if l.spec.description}<p class="sub">{l.spec.description}</p>{/if}
            </div>
          {/each}
        </div>
      </div>
    </li>
  </ol>

  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <footer class="go">
    <span>{picked} guidance card{picked === 1 ? '' : 's'} · {Object.values(recipes).filter(Boolean).length} recipe{Object.values(recipes).filter(Boolean).length === 1 ? '' : 's'}</span>
    <span class="spacer"></span>
    <button class="btn primary big" disabled={busy || !picked} onclick={create}>{busy ? 'Setting up…' : 'Finish setup'} <Icon name="arrow" size={13} /></button>
  </footer>
</section>

<style>
  .setup { max-width: 760px; margin: 1.2rem auto 0; }
  .hero h1 { margin: 0 0 .4rem; font-size: 24px; font-weight: 750; letter-spacing: -.02em; }
  .hero p { margin: 0; max-width: 62ch; color: var(--ink-2); font-size: 14px; line-height: 1.55; }
  .steps { margin: 1.6rem 0 0; padding: 0; list-style: none; }
  .step { display: flex; gap: 1rem; padding: 1.2rem 0; border-top: 1px solid var(--line-strong); }
  .num { display: grid; place-items: center; flex-shrink: 0; width: 28px; height: 28px; border-radius: 50%; background: var(--ink); color: #fff; font-weight: 700; font-size: 13px; }
  .body { flex: 1; min-width: 0; }
  h2 { margin: .2rem 0 .2rem; font-size: 16px; font-weight: 700; letter-spacing: -.01em; }
  h3 { margin: 1.1rem 0 .5rem; font-size: 12px; font-weight: 650; color: var(--ink-3); text-transform: uppercase; letter-spacing: .05em; }
  .hint { margin: 0 0 .8rem; color: var(--ink-3); font-size: 13px; }
  .pair { display: grid; grid-template-columns: 1fr 1.4fr; gap: .7rem; }
  .pair label, .inline { display: flex; flex-direction: column; gap: .3rem; font-size: 12px; font-weight: 600; color: var(--ink-2); }
  .inline { margin: .5rem 0 0 1.6rem; }
  .input { box-sizing: border-box; width: 100%; height: 34px; padding: 0 .65rem; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--surface); color: var(--ink); font: inherit; font-size: 13.5px; font-weight: 400; }
  .input:focus { outline: 2px solid var(--focus); outline-offset: -1px; border-color: transparent; }
  .choices { display: grid; grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); gap: .5rem; }
  .choice { position: relative; padding: .6rem .7rem; border: 1px solid var(--line); border-radius: 9px; background: var(--surface); transition: border-color .15s, box-shadow .15s; }
  .choice.on { border-color: color-mix(in srgb, var(--focus) 45%, var(--line)); box-shadow: inset 3px 0 0 var(--focus); }
  .check { display: flex; align-items: center; gap: .55rem; padding-right: 2.6rem; cursor: pointer; font-size: 13px; }
  .check input { width: 15px; height: 15px; margin: 0; accent-color: var(--focus); }
  .ctitle { font-weight: 600; color: var(--ink); }
  .peek { position: absolute; top: .45rem; right: .45rem; height: 22px; padding: 0 .45rem; border: 0; border-radius: 5px; background: none; color: var(--ink-3); font: inherit; font-size: 11.5px; cursor: pointer; }
  .peek:hover, .peek[aria-expanded='true'] { background: var(--sunken); color: var(--ink); }
  .text, .sub { margin: .45rem 0 0 1.6rem; color: var(--ink-2); font-size: 12.5px; line-height: 1.5; }
  .sub { color: var(--ink-3); }
  .badge { --c: var(--ink-3); margin-left: auto; height: 18px; padding: 0 .4rem; border-radius: 5px; background: color-mix(in srgb, var(--c) 11%, transparent); color: var(--c); font-size: 10.5px; font-weight: 700; line-height: 18px; }
  .badge.trash { --c: var(--trash); } .badge.archive { --c: var(--archive); } .badge.label_todo { --c: var(--todo); }
  .error { padding: .5rem .8rem; border-radius: 8px; background: color-mix(in srgb, var(--trash) 9%, transparent); color: #9b1c33; }
  .go { position: sticky; bottom: .6rem; display: flex; align-items: center; gap: .8rem; margin-top: .4rem; padding: .6rem .6rem .6rem 1rem; border: 1px solid var(--line-strong); border-radius: 10px; background: color-mix(in srgb, var(--surface) 94%, transparent); backdrop-filter: blur(8px); box-shadow: 0 6px 24px -12px rgb(24 32 44 / 35%); color: var(--ink-3); font-size: 12.5px; }
  .spacer { flex: 1; }
  .big { height: 34px; padding: 0 1rem; font-size: 13px; }
  @media (max-width: 720px) { .pair { grid-template-columns: 1fr; } .step { gap: .7rem; } }
</style>
